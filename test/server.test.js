const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { app, createShutdownHandler, listenErrorMessage, passwordMatches, passwordRecord, pool, tlsOptionsFromEnvironment } = require("../server");

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("passwords are salted hashes and only match the original password", async () => {
  const password = "correct horse battery staple";
  const record = await passwordRecord(password);
  assert.notEqual(record, password);
  assert.equal(await passwordMatches(password, record), true);
  assert.equal(await passwordMatches("not the password", record), false);
});

test("HTTPS requires both certificate and private-key paths", () => {
  assert.equal(tlsOptionsFromEnvironment({}), null);
  assert.throws(
    () => tlsOptionsFromEnvironment({ HTTPS_CERT_PATH: "certs/nyayarchive.pem" }),
    /Set both HTTPS_CERT_PATH and HTTPS_KEY_PATH/
  );
  assert.throws(
    () => tlsOptionsFromEnvironment({ HTTPS_PFX_PATH: "certs/nyayarchive.pfx" }),
    /Set both HTTPS_PFX_PATH and HTTPS_PFX_PASSWORD/
  );
  assert.throws(
    () => tlsOptionsFromEnvironment({
      HTTPS_PFX_PATH: "certs/nyayarchive.pfx",
      HTTPS_PFX_PASSWORD: "test",
      HTTPS_CERT_PATH: "certs/nyayarchive.pem",
      HTTPS_KEY_PATH: "certs/nyayarchive-key.pem"
    }),
    /Configure HTTPS with either/
  );
});

test("repeated shutdown waits for active requests and releases the server port once", async () => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const server = http.createServer((_req, res) => {
    requestStarted();
    setTimeout(() => res.end("finished"), 40);
  });
  const port = await listen(server);
  let poolCloseCount = 0;
  const shutdownErrors = [];
  const shutdown = createShutdownHandler(server, {
    async end() {
      poolCloseCount += 1;
    }
  }, { timeoutMs: 1000, logger: { log() {}, error(...messages) { shutdownErrors.push(messages.join(" ")); } } });

  const responsePromise = fetch(`http://127.0.0.1:${port}`);
  await started;
  const firstShutdown = shutdown("SIGTERM");
  const secondShutdown = shutdown("SIGINT");
  assert.equal(firstShutdown, secondShutdown);
  const response = await responsePromise;
  assert.equal(await response.text(), "finished");
  await firstShutdown;
  assert.equal(poolCloseCount, 1);
  assert.deepEqual(shutdownErrors, []);

  const replacement = http.createServer();
  assert.equal(await listen(replacement, port), port);
  await close(replacement);
});

test("port conflict guidance leaves the process that owns the port running", async () => {
  const owner = http.createServer((_req, res) => res.end("still running"));
  const port = await listen(owner);
  const collision = http.createServer();
  const error = await new Promise(resolve => {
    collision.once("error", resolve);
    collision.listen(port, "127.0.0.1");
  });

  assert.equal(error.code, "EADDRINUSE");
  assert.match(listenErrorMessage(error, port), new RegExp(`Port ${port} is already in use`));
  assert.match(listenErrorMessage(error, port), /No process was stopped/);
  const response = await fetch(`http://127.0.0.1:${port}`);
  assert.equal(await response.text(), "still running");
  await close(owner);
});

test("file APIs reject requests without a signed-in administrator", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/files`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Sign in to access this workspace." });

    const passwordChange = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "current-password", newPassword: "a-new-long-password" })
    });
    assert.equal(passwordChange.status, 401);
    assert.deepEqual(await passwordChange.json(), { error: "Sign in to access this workspace." });

    const scan = await fetch(`${baseUrl}/api/files/NA-2026-001/scans`, { method: "POST" });
    assert.equal(scan.status, 401);
    assert.deepEqual(await scan.json(), { error: "Sign in to access this workspace." });
    const notifications = await fetch(`${baseUrl}/api/notifications`);
    assert.equal(notifications.status, 401);
    assert.deepEqual(await notifications.json(), { error: "Sign in to access this workspace." });
  } finally {
    await close(server);
  }
});

test("the configured brand logo is served as a JPEG image", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/logo.jpeg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/jpeg/);
    const image = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...image.subarray(0, 2)], [0xff, 0xd8]);
  } finally {
    await close(server);
  }
});

test("first-admin setup and sign-in explain invalid account input safely", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", name: "Administrator", password: "short" })
    });
    assert.equal(setupResponse.status, 400);
    assert.deepEqual(await setupResponse.json(), { error: "Choose a password between 12 and 1,024 characters." });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(loginResponse.status, 400);
    assert.deepEqual(await loginResponse.json(), { error: "Enter your administrator email and password." });
  } finally {
    await close(server);
  }
});

test("first-admin setup, sign-in, protected API access and sign-out work end to end", async () => {
  const originalExecute = pool.execute;
  const originalGetConnection = pool.getConnection;
  const administrators = [];
  let nextAdminId = 1;
  const fileRecord = {
    record_id: 77,
    file_id: "NA-2026-077",
    case_number: "CS/77/2026",
    case_type: "Civil",
    case_year: 2026,
    current_location: "Court Hall 2",
    status: "In Court",
    assigned_officer: "R. Kumar",
    file_date: "2026-08-21",
    description: "Property boundary dispute",
    documents: "Petition\nCourt order",
  };
  const fileMovement = {
    file_record_id: 77,
    from_location: "Central Record Room",
    to_location: "Court Hall 2",
    status: "In Court",
    officer: "First Admin",
    received_by: "R. Kumar",
    action: "File handed over",
    notes: "Listed for hearing",
    happened_at: "2026-09-01 12:00:00.000"
  };
  const scanEvents = [];
  const notifications = [];
  let nextNotificationId = 1;
  pool.execute = async (sql, values = []) => {
    if (sql.startsWith("SELECT COUNT(*) AS total FROM administrators WHERE role = 'Administrator'")) {
      return [[{ total: administrators.filter(admin => admin.role === "Administrator").length }], []];
    }
    if (sql.startsWith("SELECT admin_id, email, display_name, role FROM administrators WHERE admin_id")) {
      return [administrators.filter(admin => admin.admin_id === values[0]), []];
    }
    if (sql.startsWith("SELECT admin_id, email, display_name, password_hash, role FROM administrators WHERE email")) {
      return [administrators.filter(admin => admin.email === values[0]), []];
    }
    if (sql.startsWith("SELECT admin_id, email, display_name, role, created_at FROM administrators WHERE role = 'Staff'")) {
      return [administrators.filter(admin => admin.role === "Staff"), []];
    }
    if (sql.startsWith("INSERT INTO administrators") && sql.includes("'Staff'")) {
      const admin = {
        admin_id: nextAdminId++,
        email: values[0],
        display_name: values[1],
        password_hash: values[2],
        role: "Staff",
        created_at: new Date()
      };
      administrators.push(admin);
      return [{ insertId: admin.admin_id }, []];
    }
    if (sql.startsWith("SELECT * FROM court_files WHERE file_id")) {
      return [values[0] === fileRecord.file_id ? [fileRecord] : [], []];
    }
    if (sql.startsWith("SELECT file_record_id, from_location, to_location, status, officer, received_by, action, notes, happened_at")) {
      return [values.includes(fileRecord.record_id) ? [fileMovement] : [], []];
    }
    if (sql.startsWith("SELECT scanned_by, holder_at_scan, station_key, scanned_at FROM file_scan_events")) {
      return [scanEvents.length ? [scanEvents[scanEvents.length - 1]] : [], []];
    }
    if (sql.startsWith("SELECT station_key, scanned_by_admin_id FROM file_scan_events")) {
      return [scanEvents.length ? [scanEvents[scanEvents.length - 1]] : [], []];
    }
    if (sql.startsWith("SELECT n.notification_id, f.file_id")) {
      return [notifications.filter(item => item.recipient_admin_id === values[0])
        .map(item => ({ ...item, file_id: fileRecord.file_id })), []];
    }
    if (sql.startsWith("UPDATE file_notifications SET read_at")) {
      const item = notifications.find(notification =>
        notification.notification_id === values[0] && notification.recipient_admin_id === values[1] && !notification.read_at
      );
      if (item) item.read_at = "2026-09-02 09:35:00.000";
      return [{ affectedRows: item ? 1 : 0 }, []];
    }
    if (sql.startsWith("SELECT record_id FROM court_files WHERE file_id")) {
      return [values[0] === fileRecord.file_id ? [{ record_id: fileRecord.record_id }] : [], []];
    }
    if (sql.startsWith("UPDATE court_files SET description = ?, documents = ?")) {
      fileRecord.description = values[0];
      fileRecord.documents = values[1];
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("SELECT * FROM court_files")) return [[], []];
    throw new Error(`Unexpected test query: ${sql}`);
  };
  pool.getConnection = async () => ({
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, values = []) {
      if (sql.startsWith("SELECT setup_id FROM admin_setup_guard")) return [[], []];
      if (sql.startsWith("SELECT COUNT(*) AS total FROM administrators WHERE role = 'Administrator'")) {
        return [[{ total: administrators.filter(admin => admin.role === "Administrator").length }], []];
      }
      if (sql.startsWith("SELECT admin_id, password_hash FROM administrators WHERE email")) {
        return [administrators.filter(admin => admin.email === values[0]).map(admin => ({
          admin_id: admin.admin_id,
          password_hash: admin.password_hash
        })), []];
      }
      if (sql.startsWith("UPDATE administrators SET password_hash")) {
        const admin = administrators.find(item => item.admin_id === values[1]);
        if (admin) admin.password_hash = values[0];
        return [{ affectedRows: admin ? 1 : 0 }, []];
      }
      if (sql.startsWith("UPDATE administrators SET display_name")) {
        const admin = administrators.find(item => item.admin_id === values[1] && item.role === "Staff");
        if (admin) admin.display_name = values[0];
        return [{ affectedRows: admin ? 1 : 0 }, []];
      }
      if (sql.startsWith("INSERT INTO administrators")) {
        administrators.push({
          admin_id: nextAdminId++,
          email: values[0],
          display_name: values[1],
          password_hash: values[2],
          role: sql.includes("'Administrator'") ? "Administrator" : "Staff",
          created_at: new Date()
        });
        return [{ insertId: administrators[administrators.length - 1].admin_id }, []];
      }
      if (sql.startsWith("SELECT admin_id FROM administrators WHERE admin_id = ? AND role = 'Staff'")) {
        return [administrators.filter(admin => admin.admin_id === values[0] && admin.role === "Staff")
          .map(admin => ({ admin_id: admin.admin_id })), []];
      }
      if (sql.startsWith("SELECT record_id, current_location, status, assigned_officer FROM court_files WHERE file_id")) {
        return [values[0] === fileRecord.file_id
          ? [{
            record_id: fileRecord.record_id,
            current_location: fileRecord.current_location,
            status: fileRecord.status,
            assigned_officer: fileRecord.assigned_officer
          }]
          : [], []];
      }
      if (sql.startsWith("SELECT station_key, scanned_by_admin_id FROM file_scan_events")) {
        return [scanEvents.length ? [scanEvents[scanEvents.length - 1]] : [], []];
      }
      if (sql.startsWith("SELECT admin_id FROM administrators WHERE role = 'Staff' AND LOWER(display_name)")) {
        return [administrators.filter(admin => admin.role === "Staff" && admin.display_name.toLowerCase() === String(values[0]).toLowerCase())
          .map(admin => ({ admin_id: admin.admin_id })), []];
      }
      if (sql.startsWith("INSERT INTO file_scan_events")) {
        scanEvents.push({
          file_record_id: values[0],
          scanned_by: values[1],
          scanned_by_admin_id: values[2],
          holder_at_scan: values[3],
          station_key: values[4],
          scanned_at: "2026-09-02 09:30:00.000"
        });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("UPDATE court_files SET current_location = ?, assigned_officer = ?")) {
        fileRecord.current_location = values[0];
        fileRecord.assigned_officer = values[1];
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("INSERT INTO file_movements")) {
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("INSERT INTO file_notifications")) {
        notifications.push({
          notification_id: nextNotificationId++,
          recipient_admin_id: values[0],
          file_record_id: values[1],
          message: values[2],
          created_at: "2026-09-02 09:30:00.000",
          read_at: null
        });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected test query: ${sql}`);
    }
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const initialStatus = await fetch(`${baseUrl}/api/auth/status`);
    assert.deepEqual(await initialStatus.json(), { setupRequired: true, user: null });

    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Admin@Example.test", name: "First Admin", password: "choose-a-long-password" })
    });
    assert.equal(setupResponse.status, 201);
    assert.deepEqual(await setupResponse.json(), { ok: true });
    assert.equal(administrators[0].email, "admin@example.test");
    assert.equal(administrators[0].role, "Administrator");

    const repeatedSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "second@example.test", name: "Second Admin", password: "another-long-password" })
    });
    assert.equal(repeatedSetup.status, 409);

    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "incorrect-password" })
    });
    assert.equal(invalidLogin.status, 401);
    assert.deepEqual(await invalidLogin.json(), { error: "Email or password is incorrect." });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " ADMIN@example.test ", password: "choose-a-long-password" })
    });
    assert.equal(loginResponse.status, 200);
    assert.deepEqual(await loginResponse.json(), {
      user: { name: "First Admin", role: "Administrator", email: "admin@example.test" }
    });
    const cookie = loginResponse.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const cookieHeader = cookie.split(";")[0];

    const protectedFiles = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: cookieHeader } });
    assert.equal(protectedFiles.status, 200);
    assert.deepEqual(await protectedFiles.json(), []);
    const administratorScan = await fetch(`${baseUrl}/api/files/NA-2026-077/scans`, {
      method: "POST",
      headers: { Cookie: cookieHeader }
    });
    assert.equal(administratorScan.status, 403);

    const staffList = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookieHeader } });
    assert.equal(staffList.status, 200);
    assert.deepEqual(await staffList.json(), []);

    const weakPassword = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ email: "weak@example.test", name: "Weak Password", password: "short" })
    });
    assert.equal(weakPassword.status, 400);
    assert.deepEqual(await weakPassword.json(), {
      error: "Choose a staff password between 12 and 1,024 characters."
    });

    const createdStaff = await fetch(`${baseUrl}/api/admin/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        email: "clerk@example.test",
        name: "Meghraj",
        password: "admin-chosen-staff-password"
      })
    });
    assert.equal(createdStaff.status, 201);
    const staffCredentials = await createdStaff.json();
    assert.deepEqual(staffCredentials.user, {
      name: "Meghraj",
      email: "clerk@example.test",
      role: "Staff"
    });
    assert.equal(Object.hasOwn(staffCredentials, "password"), false);
    assert.equal(await passwordMatches("admin-chosen-staff-password", administrators[1].password_hash), true);
    assert.equal(await passwordMatches("different-password", administrators[1].password_hash), false);
    const updatedStaffList = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookieHeader } });
    assert.deepEqual(await updatedStaffList.json(), [{
      id: administrators[1].admin_id,
      email: administrators[1].email,
      name: administrators[1].display_name,
      role: administrators[1].role,
      createdAt: administrators[1].created_at.toISOString()
    }]);
    const stationAccounts = [
      { email: "recordroom@example.test", name: "Mahi Shree" },
      { email: "courtroom@example.test", name: "Vishal" },
      { email: "judgeoffice@example.test", name: "Sumera" }
    ];
    for (const account of stationAccounts) {
      const response = await fetch(`${baseUrl}/api/admin/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ ...account, password: "station-account-password" })
      });
      assert.equal(response.status, 201);
    }

    const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: staffCredentials.user.email, password: "admin-chosen-staff-password" })
    });
    assert.equal(staffLogin.status, 200);
    assert.deepEqual((await staffLogin.json()).user, {
      name: "Meghraj",
      role: "Staff",
      email: "clerk@example.test"
    });
    const staffCookie = staffLogin.headers.get("set-cookie").split(";")[0];
    const staffFileAccess = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: staffCookie } });
    assert.equal(staffFileAccess.status, 200);
    const qrFileDetails = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}`, { headers: { Cookie: staffCookie } });
    assert.equal(qrFileDetails.status, 200);
    assert.deepEqual(await qrFileDetails.json(), {
      id: "NA-2026-077",
      caseNo: "CS/77/2026",
      type: "Civil",
      year: 2026,
      location: "Court Hall 2",
      status: "In Court",
      officer: "R. Kumar",
      date: "2026-08-21",
      desc: "Property boundary dispute",
      documents: ["Petition", "Court order"],
      lastScan: null,
      history: [{
        fromLocation: "Central Record Room",
        toLocation: "Court Hall 2",
        location: "Court Hall 2",
        status: "In Court",
        officer: "First Admin",
        receivedBy: "R. Kumar",
        action: "File handed over",
        notes: "Listed for hearing",
        time: "2026-09-01T12:00:00.000Z"
      }]
    });
    const recordRoomLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "recordroom@example.test", password: "station-account-password" })
    });
    const recordRoomCookie = recordRoomLogin.headers.get("set-cookie").split(";")[0];
    const recordScan = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}/scans`, {
      method: "POST",
      headers: { Cookie: recordRoomCookie }
    });
    assert.equal(recordScan.status, 201);
    assert.deepEqual(await recordScan.json(), { ok: true });
    const afterScan = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}`, { headers: { Cookie: recordRoomCookie } });
    assert.equal(afterScan.status, 200);
    const scannedFile = await afterScan.json();
    assert.equal(scannedFile.officer, "Mahi Shree");
    assert.equal(scannedFile.location, "Record Room");
    assert.equal(scannedFile.lastScan.name, "Mahi Shree");
    assert.equal(scannedFile.lastScan.holder, "R. Kumar");
    assert.equal(scannedFile.lastScan.station, "Record Room");
    const courtroomLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "courtroom@example.test", password: "station-account-password" })
    });
    const courtroomCookie = courtroomLogin.headers.get("set-cookie").split(";")[0];
    const courtroomScan = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}/scans`, {
      method: "POST",
      headers: { Cookie: courtroomCookie }
    });
    assert.equal(courtroomScan.status, 201);
    const atCourtroom = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}`, { headers: { Cookie: courtroomCookie } });
    const courtroomFile = await atCourtroom.json();
    assert.equal(courtroomFile.location, "Courtroom");
    assert.equal(courtroomFile.officer, "Vishal");
    assert.equal(courtroomFile.lastScan.station, "Courtroom");
    assert.equal(courtroomFile.lastScan.holder, "Mahi Shree");
    const missedStationAlerts = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: recordRoomCookie } });
    assert.equal(missedStationAlerts.status, 200);
    const alerts = await missedStationAlerts.json();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].message, /Clerk \(Meghraj\)/);
    const markAlertRead = await fetch(`${baseUrl}/api/notifications/${alerts[0].id}/read`, {
      method: "POST",
      headers: { Cookie: recordRoomCookie }
    });
    assert.equal(markAlertRead.status, 200);
    const alertsAfterRead = await fetch(`${baseUrl}/api/notifications`, { headers: { Cookie: recordRoomCookie } });
    assert.ok((await alertsAfterRead.json())[0].readAt);
    const updateDetails = await fetch(`${baseUrl}/api/files/${fileRecord.file_id}/details`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: staffCookie },
      body: JSON.stringify({ desc: "Updated case summary", documents: "Petition\nExhibit A" })
    });
    assert.equal(updateDetails.status, 200);
    const updatedFile = (await updateDetails.json()).file;
    assert.equal(updatedFile.desc, "Updated case summary");
    assert.deepEqual(updatedFile.documents, ["Petition", "Exhibit A"]);
    const staffManagement = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: staffCookie } });
    assert.equal(staffManagement.status, 403);
    const staffPasswordChange = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: staffCookie },
      body: JSON.stringify({ currentPassword: "admin-chosen-staff-password", newPassword: "a-new-long-password" })
    });
    assert.equal(staffPasswordChange.status, 403);
    const staffCannotResetPassword = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: staffCookie },
      body: JSON.stringify({ password: "admin-reset-staff-password" })
    });
    assert.equal(staffCannotResetPassword.status, 403);
    const staffCannotChangeName = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: staffCookie },
      body: JSON.stringify({ name: "Unauthorized Rename" })
    });
    assert.equal(staffCannotChangeName.status, 403);

    const secondAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "choose-a-long-password" })
    });
    assert.equal(secondAdminLogin.status, 200);
    const secondAdminCookie = secondAdminLogin.headers.get("set-cookie").split(";")[0];

    const invalidStaffName = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ name: "   " })
    });
    assert.equal(invalidStaffName.status, 400);
    const missingStaffName = await fetch(`${baseUrl}/api/admin/users/999/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ name: "Updated Court Clerk" })
    });
    assert.equal(missingStaffName.status, 404);
    const changedStaffName = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/name`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ name: "Updated Court Clerk" })
    });
    assert.equal(changedStaffName.status, 200);
    assert.deepEqual(await changedStaffName.json(), { ok: true });
    const staffNameStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: staffCookie } });
    assert.equal((await staffNameStatus.json()).user.name, "Updated Court Clerk");

    const invalidStaffPassword = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ password: "short" })
    });
    assert.equal(invalidStaffPassword.status, 400);
    const missingStaffPasswordReset = await fetch(`${baseUrl}/api/admin/users/999/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ password: "admin-reset-staff-password" })
    });
    assert.equal(missingStaffPasswordReset.status, 404);
    const resetStaffPassword = await fetch(`${baseUrl}/api/admin/users/${administrators[1].admin_id}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ password: "admin-reset-staff-password" })
    });
    assert.equal(resetStaffPassword.status, 200);
    assert.deepEqual(await resetStaffPassword.json(), { ok: true });
    assert.equal(await passwordMatches("admin-reset-staff-password", administrators[1].password_hash), true);

    const wrongCurrentPassword = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ currentPassword: "incorrect-password", newPassword: "a-new-long-password" })
    });
    assert.equal(wrongCurrentPassword.status, 401);

    const changedPassword = await fetch(`${baseUrl}/api/auth/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ currentPassword: "choose-a-long-password", newPassword: "a-new-long-password" })
    });
    assert.equal(changedPassword.status, 200);
    assert.deepEqual(await changedPassword.json(), { ok: true });

    const oldAdminSession = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: cookieHeader } });
    assert.equal(oldAdminSession.status, 401);
    const currentAdminSession = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: secondAdminCookie } });
    assert.equal(currentAdminSession.status, 200);
    const expiredStaffSession = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: staffCookie } });
    assert.equal(expiredStaffSession.status, 401);

    const oldPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "choose-a-long-password" })
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: "a-new-long-password" })
    });
    assert.equal(newPasswordLogin.status, 200);
    const oldStaffPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "clerk@example.test", password: "admin-chosen-staff-password" })
    });
    assert.equal(oldStaffPasswordLogin.status, 401);
    const newStaffPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "clerk@example.test", password: "admin-reset-staff-password" })
    });
    assert.equal(newStaffPasswordLogin.status, 200);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: staffCookie }
    });
    assert.equal(logout.status, 200);
    const signedOutFiles = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: staffCookie } });
    assert.equal(signedOutFiles.status, 401);
  } finally {
    await close(server);
    pool.execute = originalExecute;
    pool.getConnection = originalGetConnection;
  }
});
