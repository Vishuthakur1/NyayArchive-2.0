require("dotenv").config();

const express = require("express");
const fs = require("fs");
const https = require("https");
const mysql = require("mysql2/promise");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");

const app = express();
const port = Number(process.env.PORT || 3000);
const scrypt = promisify(crypto.scrypt);
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z"
});

const caseTypes = new Set(["Civil", "Criminal", "Family", "Property", "Commercial", "Other"]);
const statuses = new Set(["Stored", "In Court", "In Movement", "Missing"]);
const fileStations = [
  { key: "record-room", location: "Record Room", officer: "Mahi Shree" },
  { key: "clerk", location: "Clerk", officer: "Meghraj" },
  { key: "courtroom", location: "Courtroom", officer: "Vishal" },
  { key: "judge-office", location: "Judge's Office", officer: "Sumera" }
];
const route = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const sessions = new Map();
const sessionLifetime = 8 * 60 * 60 * 1000;
const sessionCookie = "nyayarchive_session";
const passwordSaltBytes = 16;
const passwordHashBytes = 64;
const dummyPasswordSalt = crypto.randomBytes(passwordSaltBytes);
const dummyPasswordHash = crypto.randomBytes(passwordHashBytes);
let poolEndPromise;

function closeDatabasePool() {
  if (!poolEndPromise) poolEndPromise = Promise.resolve().then(() => pool.end());
  return poolEndPromise;
}

function tlsOptionsFromEnvironment(environment = process.env) {
  const pfxPath = environment.HTTPS_PFX_PATH;
  const pfxPassword = environment.HTTPS_PFX_PASSWORD;
  const certificatePath = environment.HTTPS_CERT_PATH;
  const keyPath = environment.HTTPS_KEY_PATH;
  const pfxConfigured = Boolean(pfxPath || pfxPassword);
  const pemConfigured = Boolean(certificatePath || keyPath);
  if (!pfxConfigured && !pemConfigured) return null;
  if (pfxConfigured && pemConfigured) {
    throw new Error("Configure HTTPS with either HTTPS_PFX_PATH and HTTPS_PFX_PASSWORD, or HTTPS_CERT_PATH and HTTPS_KEY_PATH, not both.");
  }
  if (pfxConfigured) {
    if (!pfxPath || !pfxPassword) {
      throw new Error("Set both HTTPS_PFX_PATH and HTTPS_PFX_PASSWORD in .env to enable HTTPS.");
    }
    try {
      return {
        pfx: fs.readFileSync(path.resolve(__dirname, pfxPath)),
        passphrase: pfxPassword
      };
    } catch (error) {
      throw new Error(`Could not read the HTTPS PFX certificate: ${error.message}`);
    }
  }
  if (!certificatePath || !keyPath) {
    throw new Error("Set both HTTPS_CERT_PATH and HTTPS_KEY_PATH in .env to enable HTTPS.");
  }
  try {
    return {
      cert: fs.readFileSync(path.resolve(__dirname, certificatePath)),
      key: fs.readFileSync(path.resolve(__dirname, keyPath))
    };
  } catch (error) {
    throw new Error(`Could not read the HTTPS certificate or private key: ${error.message}`);
  }
}

app.use(express.json({ limit: "20kb" }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  const cookie = cookies.find(item => item.trim().startsWith(`${name}=`));
  return cookie ? cookie.trim().slice(name.length + 1) : "";
}

function setSessionCookie(res, token) {
  const httpsConfigured = (process.env.HTTPS_PFX_PATH && process.env.HTTPS_PFX_PASSWORD) ||
    (process.env.HTTPS_CERT_PATH && process.env.HTTPS_KEY_PATH);
  const secure = process.env.NODE_ENV === "production" || httpsConfigured ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure}`);
}

function clearSessionCookie(res) {
  const httpsConfigured = (process.env.HTTPS_PFX_PATH && process.env.HTTPS_PFX_PASSWORD) ||
    (process.env.HTTPS_CERT_PATH && process.env.HTTPS_KEY_PATH);
  const secure = process.env.NODE_ENV === "production" || httpsConfigured ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

async function passwordRecord(password) {
  const salt = crypto.randomBytes(passwordSaltBytes);
  const hash = await scrypt(password, salt, passwordHashBytes);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function passwordMatches(password, record) {
  const [saltHex, hashHex] = String(record || "").split(":");
  const salt = /^[a-f0-9]{32}$/i.test(saltHex || "") ? Buffer.from(saltHex, "hex") : dummyPasswordSalt;
  const expected = /^[a-f0-9]{128}$/i.test(hashHex || "") ? Buffer.from(hashHex, "hex") : dummyPasswordHash;
  const actual = await scrypt(password, salt, passwordHashBytes);
  return crypto.timingSafeEqual(actual, expected);
}

async function administratorCount(executor = pool) {
  const [[row]] = await executor.execute("SELECT COUNT(*) AS total FROM administrators WHERE role = 'Administrator'");
  return Number(row.total);
}

function safeUser(row) {
  return { name: row.display_name, role: row.role, email: row.email };
}

function stationForUser(name) {
  const normalizedName = String(name).trim().replace(/\s+/g, " ").toLowerCase();
  return fileStations.find(station => station.officer.toLowerCase() === normalizedName) || null;
}

async function activeUser(req) {
  const token = cookieValue(req, sessionCookie);
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const [rows] = await pool.execute("SELECT admin_id, email, display_name, role FROM administrators WHERE admin_id = ?", [session.adminId]);
  if (!rows.length) {
    sessions.delete(token);
    return null;
  }
  req.userId = session.adminId;
  return safeUser(rows[0]);
}

function startSession(req, res, adminId) {
  sessions.delete(cookieValue(req, sessionCookie));
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { adminId, expiresAt: Date.now() + sessionLifetime });
  setSessionCookie(res, token);
}

const requireAuthentication = route(async (req, res, next) => {
  req.user = await activeUser(req);
  if (!req.user) return res.status(401).json({ error: "Sign in to access this workspace." });
  next();
});

function requireAdministrator(req, res, next) {
  if (req.user.role !== "Administrator") {
    return res.status(403).json({ error: "Only an administrator can manage staff accounts." });
  }
  next();
}

app.get("/api/auth/status", route(async (req, res) => {
  const user = await activeUser(req);
  res.json({ setupRequired: await administratorCount() === 0, user });
}));

app.post("/api/auth/setup", route(async (req, res) => {
  const { email, name, password } = req.body || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const displayName = typeof name === "string" ? name.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return res.status(400).json({ error: "Enter a valid administrator email address." });
  }
  if (!displayName || displayName.length > 100) {
    return res.status(400).json({ error: "Enter an administrator name of 1 to 100 characters." });
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    return res.status(400).json({ error: "Choose a password between 12 and 1,024 characters." });
  }

  const passwordHash = await passwordRecord(password);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("SELECT setup_id FROM admin_setup_guard WHERE setup_id = 1 FOR UPDATE");
    if (await administratorCount(connection)) {
      await connection.rollback();
      return res.status(409).json({ error: "Initial setup is already complete. Sign in with an existing administrator account." });
    }
    await connection.execute(
      "INSERT INTO administrators (email, display_name, password_hash, role) VALUES (?, ?, ?, 'Administrator')",
      [normalizedEmail, displayName, passwordHash]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "An account with that email already exists." });
    throw error;
  } finally {
    connection.release();
  }
  res.status(201).json({ ok: true });
}));

app.post("/api/auth/login", route(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string" || password.length > 1024) {
    return res.status(400).json({ error: "Enter your administrator email and password." });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const [rows] = await pool.execute(
    "SELECT admin_id, email, display_name, password_hash, role FROM administrators WHERE email = ?",
    [normalizedEmail]
  );
  const matches = await passwordMatches(password, rows[0] && rows[0].password_hash);
  if (!rows.length || !matches) return res.status(401).json({ error: "Email or password is incorrect." });
  startSession(req, res, rows[0].admin_id);
  res.json({ user: safeUser(rows[0]) });
}));

app.post("/api/auth/logout", route(async (req, res) => {
  sessions.delete(cookieValue(req, sessionCookie));
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.post("/api/auth/password", requireAuthentication, route(async (req, res) => {
  if (req.user.role !== "Administrator") {
    return res.status(403).json({ error: "Only an administrator can change this password." });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "Enter your current password and a new password." });
  }
  if (newPassword.length < 12 || newPassword.length > 1024) {
    return res.status(400).json({ error: "Choose a new password between 12 and 1,024 characters." });
  }

  const connection = await pool.getConnection();
  let adminId;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT admin_id, password_hash FROM administrators WHERE email = ? FOR UPDATE",
      [req.user.email]
    );
    if (!rows.length || !(await passwordMatches(currentPassword, rows[0].password_hash))) {
      await connection.rollback();
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    if (await passwordMatches(newPassword, rows[0].password_hash)) {
      await connection.rollback();
      return res.status(400).json({ error: "Choose a new password different from your current password." });
    }
    adminId = rows[0].admin_id;
    const newPasswordHash = await passwordRecord(newPassword);
    await connection.execute("UPDATE administrators SET password_hash = ? WHERE admin_id = ?", [newPasswordHash, adminId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const currentToken = cookieValue(req, sessionCookie);
  for (const [token, session] of sessions) {
    if (session.adminId === adminId && token !== currentToken) sessions.delete(token);
  }
  res.json({ ok: true });
}));

app.use("/api/admin", requireAuthentication, requireAdministrator);

app.use("/api/notifications", requireAuthentication);
app.get("/api/notifications", route(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT n.notification_id, f.file_id, n.message, n.created_at, n.read_at
       FROM file_notifications n
       JOIN court_files f ON f.record_id = n.file_record_id
      WHERE n.recipient_admin_id = ?
      ORDER BY n.notification_id DESC LIMIT 50`,
    [req.userId]
  );
  res.json(rows.map(row => ({
    id: row.notification_id,
    fileId: row.file_id,
    message: row.message,
    createdAt: asIso(row.created_at),
    readAt: row.read_at ? asIso(row.read_at) : null
  })));
}));

app.post("/api/notifications/:id/read", route(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Choose a valid notification." });
  const [result] = await pool.execute(
    "UPDATE file_notifications SET read_at = CURRENT_TIMESTAMP(3) WHERE notification_id = ? AND recipient_admin_id = ? AND read_at IS NULL",
    [Number(req.params.id), req.userId]
  );
  if (!result.affectedRows) return res.status(404).json({ error: "Notification not found." });
  res.json({ ok: true });
}));

app.get("/api/admin/users", route(async (_req, res) => {
  const [rows] = await pool.execute(
    "SELECT admin_id, email, display_name, role, created_at FROM administrators WHERE role = 'Staff' ORDER BY created_at ASC, admin_id ASC"
  );
  res.json(rows.map(row => ({
    id: row.admin_id,
    email: row.email,
    name: row.display_name,
    role: row.role,
    createdAt: row.created_at
  })));
}));

app.post("/api/admin/users", route(async (req, res) => {
  const { email, name, password } = req.body || {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const displayName = typeof name === "string" ? name.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return res.status(400).json({ error: "Enter a valid staff email address." });
  }
  if (!displayName || displayName.length > 100) {
    return res.status(400).json({ error: "Enter a staff name of 1 to 100 characters." });
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    return res.status(400).json({ error: "Choose a staff password between 12 and 1,024 characters." });
  }

  const passwordHash = await passwordRecord(password);
  try {
    await pool.execute(
      "INSERT INTO administrators (email, display_name, password_hash, role) VALUES (?, ?, ?, 'Staff')",
      [normalizedEmail, displayName, passwordHash]
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "An account with that email already exists." });
    throw error;
  }
  res.status(201).json({ user: { name: displayName, email: normalizedEmail, role: "Staff" } });
}));

app.put("/api/admin/users/:id/name", route(async (req, res) => {
  const staffId = Number(req.params.id);
  if (!Number.isSafeInteger(staffId) || staffId < 1) {
    return res.status(400).json({ error: "Choose a valid staff account." });
  }
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 100) {
    return res.status(400).json({ error: "Enter a staff name of 1 to 100 characters." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT admin_id FROM administrators WHERE admin_id = ? AND role = 'Staff' FOR UPDATE",
      [staffId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: "Staff account not found." });
    }
    await connection.execute("UPDATE administrators SET display_name = ? WHERE admin_id = ?", [name, staffId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.json({ ok: true });
}));

app.put("/api/admin/users/:id/password", route(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Choose a valid staff account." });
  const { password } = req.body || {};
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    return res.status(400).json({ error: "Choose a staff password between 12 and 1,024 characters." });
  }

  const connection = await pool.getConnection();
  let staffId;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT admin_id FROM administrators WHERE admin_id = ? AND role = 'Staff' FOR UPDATE",
      [Number(req.params.id)]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: "Staff account not found." });
    }
    staffId = rows[0].admin_id;
    const passwordHash = await passwordRecord(password);
    await connection.execute("UPDATE administrators SET password_hash = ? WHERE admin_id = ?", [passwordHash, staffId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  for (const [token, session] of sessions) {
    if (session.adminId === staffId) sessions.delete(token);
  }
  res.json({ ok: true });
}));

app.use("/api/files", requireAuthentication);

function asIso(value) {
  if (value instanceof Date) return value.toISOString();
  return `${String(value).replace(" ", "T")}Z`;
}

function mapFile(row, history = []) {
  return {
    id: row.file_id,
    caseNo: row.case_number,
    type: row.case_type,
    year: Number(row.case_year),
    location: row.current_location,
    status: row.status,
    officer: row.assigned_officer,
    date: typeof row.file_date === "string" ? row.file_date.slice(0, 10) : row.file_date.toISOString().slice(0, 10),
    desc: row.description || "",
    documents: String(row.documents || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean),
    history: history.map(event => ({
      fromLocation: event.from_location,
      toLocation: event.to_location,
      location: event.to_location,
      status: event.status,
      officer: event.officer,
      receivedBy: event.received_by,
      action: event.action,
      notes: event.notes || "",
      time: asIso(event.happened_at)
    }))
  };
}

async function lastScanFor(recordId, executor = pool) {
  const [rows] = await executor.execute(
    "SELECT scanned_by, holder_at_scan, station_key, scanned_at FROM file_scan_events WHERE file_record_id = ? ORDER BY scan_id DESC LIMIT 1",
    [recordId]
  );
  if (!rows.length) return null;
  return {
    name: rows[0].scanned_by,
    holder: rows[0].holder_at_scan,
    station: fileStations.find(station => station.key === rows[0].station_key)?.location || null,
    time: asIso(rows[0].scanned_at)
  };
}

async function historyFor(recordIds, executor = pool) {
  if (!recordIds.length) return new Map();
  const placeholders = recordIds.map(() => "?").join(",");
  const [events] = await executor.execute(
    `SELECT file_record_id, from_location, to_location, status, officer, received_by, action, notes, happened_at
       FROM file_movements WHERE file_record_id IN (${placeholders})
       ORDER BY happened_at ASC, movement_id ASC`,
    recordIds
  );
  const grouped = new Map();
  for (const event of events) {
    const list = grouped.get(event.file_record_id) || [];
    list.push(event);
    grouped.set(event.file_record_id, list);
  }
  return grouped;
}

async function fileById(id, executor = pool) {
  const [rows] = await executor.execute("SELECT * FROM court_files WHERE file_id = ?", [id]);
  if (!rows.length) return null;
  const grouped = await historyFor([rows[0].record_id], executor);
  return {
    ...mapFile(rows[0], grouped.get(rows[0].record_id) || []),
    lastScan: await lastScanFor(rows[0].record_id, executor)
  };
}

function validateFile(input) {
  const required = ["caseNo", "type", "year", "location", "status", "officer", "date"];
  if (required.some(key => !String(input[key] ?? "").trim())) return "Complete all required case details.";
  if (!caseTypes.has(input.type)) return "Select a valid case type.";
  if (!statuses.has(input.status)) return "Select a valid file status.";
  if (!Number.isInteger(Number(input.year)) || Number(input.year) < 1900 || Number(input.year) > 2100) return "Case year must be between 1900 and 2100.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) return "Enter a valid file date.";
  const fileDate = new Date(`${input.date}T00:00:00.000Z`);
  if (Number.isNaN(fileDate.getTime()) || fileDate.toISOString().slice(0, 10) !== input.date) return "Enter a valid file date.";
  for (const key of ["caseNo", "location", "officer"]) {
    if (String(input[key]).trim().length > 255) return `${key} must be 255 characters or fewer.`;
  }
  if (String(input.desc || "").length > 2000) return "Case description must be 2,000 characters or fewer.";
  if (input.documents !== undefined && (typeof input.documents !== "string" || input.documents.length > 5000)) {
    return "Document list must be 5,000 characters or fewer.";
  }
  return "";
}

app.get("/api/files", route(async (_req, res) => {
  const [rows] = await pool.execute("SELECT * FROM court_files ORDER BY record_id DESC");
  const grouped = await historyFor(rows.map(row => row.record_id));
  res.json(rows.map(row => mapFile(row, grouped.get(row.record_id) || [])));
}));

app.post("/api/files", route(async (req, res) => {
  const invalid = validateFile(req.body || {});
  if (invalid) return res.status(400).json({ error: invalid });
  const input = req.body;
  const connection = await pool.getConnection();
  let fileId;
  try {
    await connection.beginTransaction();
    const [insert] = await connection.execute(
      `INSERT INTO court_files
        (file_id, case_number, case_type, case_year, current_location, status, assigned_officer, file_date, description, documents)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.caseNo.trim(), input.type, Number(input.year), input.location.trim(), input.status, input.officer.trim(), input.date, String(input.desc || "").trim(), String(input.documents || "").trim()]
    );
    fileId = `NA-${Number(input.year)}-${String(insert.insertId).padStart(3, "0")}`;
    await connection.execute("UPDATE court_files SET file_id = ? WHERE record_id = ?", [fileId, insert.insertId]);
    await connection.execute(
      `INSERT INTO file_movements
        (file_record_id, from_location, to_location, status, officer, received_by, action, notes)
       VALUES (?, NULL, ?, ?, ?, NULL, 'File registered', '')`,
      [insert.insertId, input.location.trim(), input.status, input.officer.trim()]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.status(201).json({ ok: true, file: await fileById(fileId) });
}));

app.get("/api/files/:id", route(async (req, res) => {
  const file = await fileById(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found." });
  res.json(file);
}));

app.post("/api/files/:id/scans", route(async (req, res) => {
  if (req.user.role !== "Staff") {
    return res.status(403).json({ error: "Station scans must be recorded using the assigned staff account." });
  }
  const station = stationForUser(req.user.name);
  if (!station) {
    return res.status(403).json({ error: "This account is not assigned to a file station. Ask an administrator to assign the account one of the four station names." });
  }
  const stationIndex = fileStations.findIndex(item => item.key === station.key);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [files] = await connection.execute(
      "SELECT record_id, current_location, status, assigned_officer FROM court_files WHERE file_id = ? FOR UPDATE",
      [req.params.id]
    );
    if (!files.length) {
      await connection.rollback();
      return res.status(404).json({ error: "File not found." });
    }
    const [previousScans] = await connection.execute(
      `SELECT station_key, scanned_by_admin_id FROM file_scan_events
        WHERE file_record_id = ? AND station_key IS NOT NULL
        ORDER BY scan_id DESC LIMIT 1`,
      [files[0].record_id]
    );
    const previousStationIndex = previousScans.length
      ? fileStations.findIndex(item => item.key === previousScans[0].station_key)
      : -1;
    const skippedStations = [];
    if (previousStationIndex === -1) {
      skippedStations.push(...fileStations.slice(0, stationIndex));
    } else {
      const stationDistance = (stationIndex - previousStationIndex + fileStations.length) % fileStations.length;
      for (let step = 1; step < stationDistance; step += 1) {
        skippedStations.push(fileStations[(previousStationIndex + step) % fileStations.length]);
      }
    }
    let notificationRecipientId = null;
    if (skippedStations.length) {
      if (previousScans.length) {
        notificationRecipientId = previousScans[0].scanned_by_admin_id;
      } else {
        const [recordRoomOwners] = await connection.execute(
          "SELECT admin_id FROM administrators WHERE role = 'Staff' AND LOWER(display_name) = LOWER(?) LIMIT 1",
          [fileStations[0].officer]
        );
        notificationRecipientId = recordRoomOwners.length ? recordRoomOwners[0].admin_id : null;
      }
      if (!notificationRecipientId) {
        await connection.rollback();
        return res.status(409).json({ error: "The previous station's staff account is unavailable, so the missed-station alert cannot be delivered. Ask an administrator to restore that account and retry." });
      }
    }
    await connection.execute(
      `INSERT INTO file_scan_events
        (file_record_id, scanned_by, scanned_by_admin_id, holder_at_scan, station_key)
       VALUES (?, ?, ?, ?, ?)`,
      [files[0].record_id, req.user.name, req.userId, files[0].assigned_officer, station.key]
    );
    await connection.execute(
      "UPDATE court_files SET current_location = ?, assigned_officer = ? WHERE record_id = ?",
      [station.location, station.officer, files[0].record_id]
    );
    await connection.execute(
      `INSERT INTO file_movements
        (file_record_id, from_location, to_location, status, officer, received_by, action, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'Station QR scan', '')`,
      [files[0].record_id, files[0].current_location, station.location, files[0].status, req.user.name, station.officer]
    );
    if (skippedStations.length) {
      const skippedNames = skippedStations.map(item => `${item.location} (${item.officer})`).join(", ");
      const message = `${req.params.id} was scanned at ${station.location} by ${station.officer}, but the required scan was missed at: ${skippedNames}.`;
      await connection.execute(
        "INSERT INTO file_notifications (recipient_admin_id, file_record_id, message) VALUES (?, ?, ?)",
        [notificationRecipientId, files[0].record_id, message]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  res.status(201).json({ ok: true });
}));

app.put("/api/files/:id/details", route(async (req, res) => {
  const { desc, documents } = req.body || {};
  if (typeof desc !== "string" || desc.length > 2000) {
    return res.status(400).json({ error: "Case summary must be 2,000 characters or fewer." });
  }
  if (typeof documents !== "string" || documents.length > 5000) {
    return res.status(400).json({ error: "Document list must be 5,000 characters or fewer." });
  }
  const [files] = await pool.execute("SELECT record_id FROM court_files WHERE file_id = ?", [req.params.id]);
  if (!files.length) return res.status(404).json({ error: "File not found." });
  await pool.execute(
    "UPDATE court_files SET description = ?, documents = ? WHERE record_id = ?",
    [desc.trim(), documents.trim(), files[0].record_id]
  );
  res.json({ ok: true, file: await fileById(req.params.id) });
}));

app.post("/api/files/:id/handover", route(async (req, res) => {
  const { toLocation, status, receivedBy, notes = "" } = req.body || {};
  const officer = req.user.name;
  if (![toLocation, receivedBy].every(value => typeof value === "string" && value.trim())) {
    return res.status(400).json({ error: "Destination and receiving officer are required." });
  }
  if (toLocation.trim().length > 255 || receivedBy.trim().length > 255) {
    return res.status(400).json({ error: "Location and officer names must be 255 characters or fewer." });
  }
  if (typeof notes !== "string" || notes.length > 1000) return res.status(400).json({ error: "Handover note must be 1,000 characters or fewer." });
  if (!statuses.has(status)) return res.status(400).json({ error: "Select a valid file status." });

  const connection = await pool.getConnection();
  let recordId;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute("SELECT record_id, current_location FROM court_files WHERE file_id = ? FOR UPDATE", [req.params.id]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: "File not found." });
    }
    recordId = rows[0].record_id;
    const fromLocation = rows[0].current_location;
    await connection.execute(
      "UPDATE court_files SET current_location = ?, status = ?, assigned_officer = ? WHERE record_id = ?",
      [toLocation.trim(), status, receivedBy.trim(), recordId]
    );
    await connection.execute(
      `INSERT INTO file_movements
        (file_record_id, from_location, to_location, status, officer, received_by, action, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'File handed over', ?)`,
      [recordId, fromLocation, toLocation.trim(), status, officer.trim(), receivedBy.trim(), notes.trim()]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  const file = await fileById(req.params.id);
  res.status(201).json({ ok: true, file, event: file.history[file.history.length - 1] });
}));

app.get("/api/files/:id/qr", route(async (req, res) => {
  const file = await fileById(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found." });
  res.json({ dataUrl: await QRCode.toDataURL(file.id, { errorCorrectionLevel: "M", margin: 1, width: 320 }) });
}));

app.get("/api/files/:id/qr-image", route(async (req, res) => {
  const file = await fileById(req.params.id);
  if (!file) return res.status(404).json({ error: "File not found." });
  res.type("png").send(await QRCode.toBuffer(file.id, { errorCorrectionLevel: "M", margin: 1, width: 192 }));
}));

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/logo.jpeg", (_req, res) => res.sendFile(path.join(__dirname, "logo.jpeg")));
app.use((error, _req, res, _next) => {
  console.error("NyayArchive request failed:", error.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "The request could not be completed. Check the server configuration and database connection." });
});

async function initializeDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS administrators (
      admin_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      email VARCHAR(254) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      password_hash VARCHAR(161) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'Administrator',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (admin_id),
      UNIQUE KEY uq_administrators_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[roleColumn]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'administrators' AND COLUMN_NAME = 'role'"
  );
  if (Number(roleColumn.total) === 0) {
    await pool.execute("ALTER TABLE administrators ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'Administrator'");
  }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS admin_setup_guard (
      setup_id TINYINT UNSIGNED NOT NULL,
      PRIMARY KEY (setup_id)
    ) ENGINE=InnoDB
  `);
  await pool.execute("INSERT IGNORE INTO admin_setup_guard (setup_id) VALUES (1)");
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS court_files (
      record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      file_id VARCHAR(32) NULL UNIQUE,
      case_number VARCHAR(255) NOT NULL,
      case_type VARCHAR(32) NOT NULL,
      case_year SMALLINT UNSIGNED NOT NULL,
      current_location VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL,
      assigned_officer VARCHAR(255) NOT NULL,
      file_date DATE NOT NULL,
      description VARCHAR(2000) NOT NULL DEFAULT '',
      documents VARCHAR(5000) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (record_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[documentsColumn]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'court_files' AND COLUMN_NAME = 'documents'"
  );
  if (Number(documentsColumn.total) === 0) {
    await pool.execute("ALTER TABLE court_files ADD COLUMN documents VARCHAR(5000) NOT NULL DEFAULT ''");
  }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS file_movements (
      movement_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      file_record_id BIGINT UNSIGNED NOT NULL,
      from_location VARCHAR(255) NULL,
      to_location VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL,
      officer VARCHAR(255) NOT NULL,
      received_by VARCHAR(255) NULL,
      action VARCHAR(64) NOT NULL,
      notes VARCHAR(1000) NOT NULL DEFAULT '',
      happened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (movement_id),
      KEY idx_file_movements_time (file_record_id, happened_at),
      CONSTRAINT fk_file_movements_file FOREIGN KEY (file_record_id)
        REFERENCES court_files (record_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS file_scan_events (
      scan_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      file_record_id BIGINT UNSIGNED NOT NULL,
      scanned_by VARCHAR(100) NOT NULL,
      scanned_by_admin_id BIGINT UNSIGNED NULL,
      holder_at_scan VARCHAR(255) NULL,
      station_key VARCHAR(32) NULL,
      scanned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (scan_id),
      KEY idx_file_scan_events_file (file_record_id, scan_id),
      CONSTRAINT fk_file_scan_events_file FOREIGN KEY (file_record_id)
        REFERENCES court_files (record_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[scannerIdColumn]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_scan_events' AND COLUMN_NAME = 'scanned_by_admin_id'"
  );
  if (Number(scannerIdColumn.total) === 0) {
    await pool.execute("ALTER TABLE file_scan_events ADD COLUMN scanned_by_admin_id BIGINT UNSIGNED NULL AFTER scanned_by");
  }
  const [[scanHolderColumn]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_scan_events' AND COLUMN_NAME = 'holder_at_scan'"
  );
  if (Number(scanHolderColumn.total) === 0) {
    await pool.execute("ALTER TABLE file_scan_events ADD COLUMN holder_at_scan VARCHAR(255) NULL AFTER scanned_by");
  }
  const [[stationKeyColumn]] = await pool.execute(
    "SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'file_scan_events' AND COLUMN_NAME = 'station_key'"
  );
  if (Number(stationKeyColumn.total) === 0) {
    await pool.execute("ALTER TABLE file_scan_events ADD COLUMN station_key VARCHAR(32) NULL AFTER holder_at_scan");
  }
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS file_notifications (
      notification_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      recipient_admin_id BIGINT UNSIGNED NOT NULL,
      file_record_id BIGINT UNSIGNED NOT NULL,
      message VARCHAR(500) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      read_at DATETIME(3) NULL,
      PRIMARY KEY (notification_id),
      KEY idx_file_notifications_recipient (recipient_admin_id, notification_id),
      CONSTRAINT fk_file_notifications_file FOREIGN KEY (file_record_id)
        REFERENCES court_files (record_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[count]] = await pool.execute("SELECT COUNT(*) AS total FROM court_files");
  if (Number(count.total) > 0) return;

  const demoFiles = [
    { id: "NA-2026-001", caseNo: "CS/118/2026", type: "Civil", year: 2026, location: "Central Record Room", status: "Stored", officer: "A. Rao", date: "2026-01-14", desc: "Fictional demo: contractor payment and property boundary dispute.", events: [["Filing Desk", "Central Record Room", "Stored", "A. Rao", "File registered", "2026-01-14 09:20:00.000"], ["Filing Desk", "Central Record Room", "Stored", "M. Das", "File handed over", "2026-01-15 11:05:00.000"]] },
    { id: "NA-2026-002", caseNo: "CR/204/2026", type: "Criminal", year: 2026, location: "Court Hall 3", status: "In Court", officer: "R. Iyer", date: "2026-02-03", desc: "Fictional demo: procedural hearing and witness statement review.", events: [["Central Record Room", "Court Hall 3", "In Court", "R. Iyer", "File handed over", "2026-02-03 10:10:00.000"]] },
    { id: "NA-2025-003", caseNo: "PR/79/2025", type: "Property", year: 2025, location: "Movement Desk", status: "In Movement", officer: "K. Sen", date: "2025-12-12", desc: "Fictional demo: residential plot boundary claim.", events: [["Archive Room", "Movement Desk", "In Movement", "K. Sen", "File handed over", "2026-03-02 09:10:00.000"]] },
    { id: "NA-2024-004", caseNo: "FC/36/2024", type: "Family", year: 2024, location: "Audit Desk", status: "Missing", officer: "P. Nair", date: "2024-08-05", desc: "Fictional demo: audit discrepancy awaiting a records check.", events: [["Registry Desk", "Central Record Room", "Stored", "P. Nair", "File registered", "2024-08-05 12:00:00.000"], ["Central Record Room", "Audit Desk", "Missing", "P. Nair", "File marked missing in demo audit", "2026-01-22 16:45:00.000"]] }
  ];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const file of demoFiles) {
      const [insert] = await connection.execute(
        `INSERT INTO court_files (file_id, case_number, case_type, case_year, current_location, status, assigned_officer, file_date, description, documents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
        [file.id, file.caseNo, file.type, file.year, file.location, file.status, file.officer, file.date, file.desc]
      );
      for (const [from, to, status, officer, action, time] of file.events) {
        await connection.execute(
          `INSERT INTO file_movements (file_record_id, from_location, to_location, status, officer, received_by, action, notes, happened_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, '', ?)`,
          [insert.insertId, from, to, status, officer, action, time]
        );
      }
    }
    await connection.commit();
    console.log("Added fictional NyayArchive demo records to the configured database.");
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function listenErrorMessage(error, targetPort) {
  if (error.code === "EADDRINUSE") {
    return `Port ${targetPort} is already in use (EADDRINUSE). No process was stopped. On Windows, inspect it with Get-NetTCPConnection -LocalPort ${targetPort} -State Listen and check the OwningProcess before deciding whether to stop it.`;
  }
  return `NyayArchive could not listen on port ${targetPort}: ${error.message}`;
}

function createShutdownHandler(server, databasePool, options = {}) {
  const timeoutMs = options.timeoutMs || 10000;
  const hardTimeoutMs = options.hardTimeoutMs || 5000;
  const logger = options.logger || console;
  const exit = options.exit || (code => process.exit(code));
  let shutdownPromise;

  return signal => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise(resolve => {
      logger.log(`Received ${signal}; stopping NyayArchive gracefully.`);
      let hardTimeout;
      let idleCleanup;
      let finishing = false;
      let finished = false;
      hardTimeout = setTimeout(() => {
        if (finished) return;
        logger.error("NyayArchive resources did not close within the shutdown limit; exiting.");
        exit(1);
      }, timeoutMs + hardTimeoutMs);
      const finish = async () => {
        if (finishing) return;
        finishing = true;
        clearTimeout(graceTimeout);
        clearInterval(idleCleanup);
        try {
          await databasePool.end();
        } catch (error) {
          logger.error("NyayArchive database pool shutdown failed:", error.message);
          process.exitCode = 1;
        }
        finished = true;
        clearTimeout(hardTimeout);
        resolve();
      };
      const graceTimeout = setTimeout(() => {
        logger.error(`NyayArchive shutdown exceeded ${timeoutMs}ms; closing remaining client connections.`);
        clearInterval(idleCleanup);
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      }, timeoutMs);
      if (typeof graceTimeout.unref === "function") graceTimeout.unref();
      server.close(error => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          logger.error("NyayArchive HTTP server shutdown failed:", error.message);
          process.exitCode = 1;
        }
        finish();
      });
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      idleCleanup = setInterval(() => {
        if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      }, 100);
      if (typeof idleCleanup.unref === "function") idleCleanup.unref();
    });
    return shutdownPromise;
  };
}

async function startServer() {
  const missingConfiguration = ["DB_HOST", "DB_USER", "DB_NAME"]
    .filter(key => !process.env[key]);
  if (missingConfiguration.length) {
    throw new Error(`Missing database configuration: ${missingConfiguration.join(", ")}. Set these values in .env.`);
  }
  const tlsOptions = tlsOptionsFromEnvironment();
  await initializeDatabase();
  const server = tlsOptions
    ? https.createServer(tlsOptions, app)
    : app.listen(port, "0.0.0.0");
  if (tlsOptions) server.listen(port, "0.0.0.0");
  server.once("listening", () => {
    const protocol = tlsOptions ? "https" : "http";
    console.log(`NyayArchive 2.0 demo is running at ${protocol}://localhost:${port}`);
    console.log("Demo data is fictional and this prototype is not connected to a real court system.");
  });
  const shutdown = createShutdownHandler(server, { end: closeDatabasePool });
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  server.once("error", error => {
    console.error(listenErrorMessage(error, port));
    closeDatabasePool().catch(closeError => {
      console.error("NyayArchive database pool shutdown failed:", closeError.message);
    }).finally(() => { process.exitCode = 1; });
  });
  return server;
}

if (require.main === module) {
  startServer().catch(async error => {
    console.error("NyayArchive could not start:", error.message);
    try {
      await closeDatabasePool();
    } catch (closeError) {
      console.error("NyayArchive database pool shutdown failed:", closeError.message);
    }
    process.exitCode = 1;
  });
}

module.exports = { app, pool, initializeDatabase, createShutdownHandler, listenErrorMessage, passwordRecord, passwordMatches, tlsOptionsFromEnvironment };
