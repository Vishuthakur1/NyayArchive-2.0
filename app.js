const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

const badge = status => `<span class="badge b-${esc(status).replace(/ /g, "-")}">${esc(status)}</span>`;
const fmt = value => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const documentListHTML = file => file.documents.length
  ? `<ul class="document-list">${file.documents.map(document => `<li>${esc(document)}</li>`).join("")}</ul>`
  : "No document list recorded.";
const lastScanText = file => file.lastScan
  ? `${esc(file.lastScan.name)} scanned at ${esc(file.lastScan.station || "an unassigned station")} · ${esc(fmt(file.lastScan.time))}<br>Previous holder: ${esc(file.lastScan.holder || "Not recorded for this scan.")}`
  : "No QR scan recorded yet.";
const statuses = ["Stored", "In Court", "In Movement", "Missing"];
let authUser = null;
let setupRequired = false;
let authStatusAvailable = false;
let authStatusError = "";
let loginNotice = "";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
  } catch {
    throw new Error("Cannot reach the NyayArchive server. Check that it is running and try again.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = result && typeof result.error === "string" ? result.error : `The server could not complete the request (${response.status}).`;
    throw new Error(message);
  }
  if (!result || typeof result !== "object") throw new Error("The server returned an unexpected response.");
  return result;
}

const API = {
  authStatus: () => request("/api/auth/status"),
  login: data => request("/api/auth/login", { method: "POST", body: JSON.stringify(data) }),
  setup: data => request("/api/auth/setup", { method: "POST", body: JSON.stringify(data) }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  changePassword: data => request("/api/auth/password", { method: "POST", body: JSON.stringify(data) }),
  staff: () => request("/api/admin/users"),
  createStaff: data => request("/api/admin/users", { method: "POST", body: JSON.stringify(data) }),
  updateStaffName: (id, name) => request(`/api/admin/users/${encodeURIComponent(id)}/name`, { method: "PUT", body: JSON.stringify({ name }) }),
  resetStaffPassword: (id, password) => request(`/api/admin/users/${encodeURIComponent(id)}/password`, { method: "PUT", body: JSON.stringify({ password }) }),
  notifications: () => request("/api/notifications"),
  readNotification: id => request(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
  list: () => request("/api/files"),
  get: id => request(`/api/files/${encodeURIComponent(id)}`),
  create: data => request("/api/files", { method: "POST", body: JSON.stringify(data) }),
  updateDetails: (id, data) => request(`/api/files/${encodeURIComponent(id)}/details`, { method: "PUT", body: JSON.stringify(data) }),
  handover: (id, data) => request(`/api/files/${encodeURIComponent(id)}/handover`, { method: "POST", body: JSON.stringify(data) }),
  qr: id => request(`/api/files/${encodeURIComponent(id)}/qr`),
  recordScan: id => request(`/api/files/${encodeURIComponent(id)}/scans`, { method: "POST" })
};

function flash(element, text, ok = true) {
  element.className = `msg ${ok ? "ok" : "err"}`;
  element.textContent = text;
  clearTimeout(element._timer);
  element._timer = setTimeout(() => { element.className = "msg"; }, 5000);
}

function allEvents(files) {
  return files.flatMap(file => file.history.map(event => ({ ...event, id: file.id, caseNo: file.caseNo })))
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

function eventHTML(event, detail = true) {
  const movement = event.fromLocation
    ? `<div class="event-fromto"><strong>${esc(event.fromLocation)}</strong><span>→</span><strong>${esc(event.toLocation)}</strong></div>`
    : `<div class="event-detail">${esc(event.toLocation)}${event.officer ? ` · ${esc(event.officer)}` : ""}</div>`;
  const details = detail && event.receivedBy ? ` · Received by ${esc(event.receivedBy)}` : "";
  const notes = detail && event.notes ? `<div class="event-detail">${esc(event.notes)}</div>` : "";
  return `<div class="it"><div class="event-title">${esc(event.id)} <span aria-hidden="true">·</span> ${esc(event.caseNo)} ${badge(event.status)}</div>
    <div class="history-event"><div class="event-main"><div class="event-detail">${esc(event.action)}${details}</div>${movement}${notes}<small>${esc(fmt(event.time))}</small></div></div></div>`;
}

function setPage(page) {
  $$(".page").forEach(section => section.classList.toggle("active", section.id === `page-${page}`));
  $$("#nav button").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  $("#pageTitle").textContent = ({ dashboard: "Overview", add: "Register a file", search: "Search files", track: "Track & hand over", history: "Movement history" })[page];
  if (page === "dashboard") renderDashboard();
  if (page === "search") renderTable();
  if (page === "history") renderHistory();
  window.scrollTo(0, 0);
}

$("#nav").addEventListener("click", event => {
  const button = event.target.closest("button[data-page]");
  if (button) setPage(button.dataset.page);
});
$("#newFileBtn").addEventListener("click", () => setPage("add"));
$("#quickHistory").addEventListener("click", () => setPage("history"));
$("#allHistory").addEventListener("click", () => setPage("history"));

async function renderDashboard() {
  try {
    const files = await API.list();
    const count = status => files.filter(file => file.status === status).length;
    $("#s-total").textContent = files.length;
    $("#s-court").textContent = count("In Court");
    $("#s-arch").textContent = count("Stored");
    $("#s-move").textContent = count("In Movement");
    $("#s-missing").textContent = count("Missing");
    const events = allEvents(files).slice(0, 4);
    $("#recent").innerHTML = events.length ? events.map(event => eventHTML(event, false)).join("") : '<div class="empty">No recent activity.</div>';
    $("#dashboardMsg").className = "msg";
  } catch (error) {
    flash($("#dashboardMsg"), `Could not load the workspace: ${error.message}`, false);
  }
}

function quickSearch() {
  $("#searchBox").value = $("#quick").value;
  setPage("search");
}
$("#quickBtn").addEventListener("click", quickSearch);
$("#quick").addEventListener("keydown", event => { if (event.key === "Enter") quickSearch(); });

function validateNewFile(data) {
  const required = ["caseNo", "type", "year", "location", "status", "officer", "date"];
  const missing = required.find(key => !String(data[key] ?? "").trim());
  if (missing) return `${missing} is required.`;
  if (!Number.isInteger(data.year) || data.year < 1900 || data.year > 2100) return "Case year must be between 1900 and 2100.";
  if (!statuses.includes(data.status)) return "Select a valid file status.";
  return "";
}

const addForm = $("#addForm");
$("#caseYear").value = new Date().getFullYear();
$("#fileDate").value = new Date().toISOString().slice(0, 10);
addForm.addEventListener("submit", async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(addForm).entries());
  Object.keys(data).forEach(key => { data[key] = String(data[key] ?? "").trim(); });
  data.year = Number(data.year);
  const invalid = validateNewFile(data);
  if (invalid) return flash($("#addMsg"), invalid, false);
  try {
    const result = await API.create(data);
    addForm.reset();
    $("#caseYear").value = new Date().getFullYear();
    $("#fileDate").value = new Date().toISOString().slice(0, 10);
    flash($("#addMsg"), `File ${result.file.id} registered. Its unique ID and first history event are saved.`);
    await renderDashboard();
    showQr(result.file.id, "File registered");
  } catch (error) {
    flash($("#addMsg"), `Could not save the file: ${error.message}`, false);
  }
});

async function renderTable() {
  try {
    const query = $("#searchBox").value.trim().toLowerCase();
    const files = await API.list();
    const rows = files.filter(file => !query || [file.id, file.caseNo, file.type, file.year, file.location, file.status, file.officer, file.desc]
      .some(value => String(value ?? "").toLowerCase().includes(query)));
    $("#searchCount").textContent = `${rows.length} ${rows.length === 1 ? "record" : "records"}${query ? " found" : ""}`;
    $("#fileRows").innerHTML = rows.length ? rows.map(file => `<tr>
      <td class="file-id">${esc(file.id)}</td><td class="case-no">${esc(file.caseNo)}</td><td>${esc(file.type)}</td>
      <td>${esc(file.location)}</td><td>${badge(file.status)}</td><td>${esc(file.officer)}</td>
      <td><div class="table-actions"><button class="table-action" data-action="view" data-id="${esc(file.id)}">View</button><button class="table-action" data-action="qr" data-id="${esc(file.id)}">QR</button></div></td>
      </tr>`).join("") : '<tr><td colspan="7" class="empty">No matching files found.</td></tr>';
    $("#searchMsg").className = "msg";
  } catch (error) {
    $("#fileRows").innerHTML = "";
    flash($("#searchMsg"), `Could not load files: ${error.message}`, false);
  }
}

async function lookupRegisterFile(recordScan = false) {
  const id = $("#registerLookupId").value.trim();
  if (!id) return flash($("#registerLookupMsg"), "Enter a file ID or scan a QR code to view its full details.", false);
  try {
    if (recordScan) await API.recordScan(id);
    const file = await API.get(id);
    const timeline = [...file.history].reverse().map(event => eventHTML({ ...event, id: file.id, caseNo: file.caseNo })).join("") || '<div class="empty">No movement history recorded yet.</div>';
    $("#registerDetails").innerHTML = `<div class="tracking-grid">
      <section class="panel tracking-card"><h3>File details</h3>
        <div class="kv">
          <div><small>Unique file ID</small><b>${esc(file.id)}</b></div>
          <div><small>Case number</small>${esc(file.caseNo)}</div>
          <div><small>Current location</small>${esc(file.location)}</div>
          <div><small>Status</small>${badge(file.status)}</div>
          <div><small>Current holder / assigned lawyer</small>${esc(file.officer)}</div>
          <div><small>Case type / year</small>${esc(file.type)} · ${esc(file.year)}</div>
          <div><small>File date</small>${esc(file.date)}</div>
          <div style="grid-column:1 / -1;"><small>Case summary</small>${esc(file.desc || "No summary recorded.")}</div>
          <div style="grid-column:1 / -1;"><small>Documents inside the file</small>${documentListHTML(file)}</div>
          <div style="grid-column:1 / -1;"><small>Last QR scan</small>${lastScanText(file)}</div>
        </div>
        <div class="qr-inline"><img class="qr-mini" src="/api/files/${encodeURIComponent(file.id)}/qr-image" alt="QR code for ${esc(file.id)}"><div><b>File QR code</b><small>Use it to quickly locate this case file.</small></div><button class="table-action" id="registerDetailQr" type="button">Open</button></div>
      </section>
      <section class="panel route-panel"><h3>Movement timeline</h3><div class="timeline full">${timeline}</div></section>
    </div>`;
    $("#registerDetailQr").addEventListener("click", () => showQr(file.id, "File details"));
    $("#registerLookupMsg").className = "msg ok";
    $("#registerLookupMsg").textContent = `Showing full details for ${file.id}.`;
  } catch (error) {
    $("#registerDetails").innerHTML = "";
    flash($("#registerLookupMsg"), error.message === "File not found." ? "No file found with that ID." : `Could not load file details: ${error.message}`, false);
  }
}
$("#searchBox").addEventListener("input", renderTable);
$("#registerLookupBtn").addEventListener("click", lookupRegisterFile);
$("#registerLookupId").addEventListener("keydown", event => { if (event.key === "Enter") lookupRegisterFile(); });
$("#registerScanBtn").addEventListener("click", () => showScanner("register"));

$("#fileRows").addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "view") {
    $("#trackId").value = button.dataset.id;
    setPage("track");
    doTrack();
  } else if (button.dataset.action === "qr") {
    showQr(button.dataset.id, "File QR code");
  }
});

let activeQrData = "";
async function showQr(id, title) {
  try {
    const result = await API.qr(id);
    activeQrData = result.dataUrl;
    $("#modalBox").innerHTML = `<div class="modal-title"><div><p class="eyebrow">${esc(title)}</p><h2 id="modalTitle">${esc(id)}</h2><p>This QR contains the file ID. Scan it from NyayArchive while signed in to view the current location, case details and movement history.</p></div><button class="icon-button" data-close aria-label="Close">×</button></div>
      <div class="qr-modal"><img src="${esc(result.dataUrl)}" alt="QR code for file ${esc(id)}"><span class="qr-id">${esc(id)}</span></div>
      <div class="modal-actions"><button class="btn btn-primary" id="downloadQr" type="button">Download QR code</button><button class="btn btn-light" data-close type="button">Close</button></div>`;
    openModal();
    $("#downloadQr").addEventListener("click", () => {
      const link = document.createElement("a");
      link.href = activeQrData;
      link.download = `${id}-qr.png`;
      link.click();
    });
  } catch (error) {
    flash($("#searchMsg"), `Could not generate QR code: ${error.message}`, false);
  }
}

let trackedId = null;
async function doTrack(recordScan = false) {
  const id = $("#trackId").value.trim();
  if (!id) return flash($("#trackMsg"), "Enter a file ID or scan a QR code.", false);
  try {
    if (recordScan) await API.recordScan(id);
    const file = await API.get(id);
    trackedId = file.id;
    $("#trackMsg").className = "msg";
    await renderTrack(file);
  } catch (error) {
    trackedId = null;
    $("#trackOut").innerHTML = "";
    flash($("#trackMsg"), error.message === "File not found." ? "No file found with that ID." : `Could not track this file: ${error.message}`, false);
  }
}

function renderTrack(file) {
  const path = [];
  file.history.forEach(event => {
    if (!path.length || path[path.length - 1] !== event.toLocation) path.push(event.toLocation);
  });
  const actor = authUser ? authUser.name : "";
  $("#trackOut").innerHTML = `<div class="tracking-grid">
    <section class="panel tracking-card"><h3>Current file location</h3><div class="kv">
      <div><small>Unique file ID</small><b>${esc(file.id)}</b></div><div><small>Case number</small>${esc(file.caseNo)}</div>
      <div><small>Current location</small>${esc(file.location)}</div><div><small>Status</small>${badge(file.status)}</div>
      <div><small>Current holder / assigned lawyer</small>${esc(file.officer)}</div><div><small>Case type / year</small>${esc(file.type)} · ${esc(file.year)}</div>
      <div><small>File date</small>${esc(file.date)}</div>
      <div style="grid-column:1 / -1;"><small>Case summary</small>${esc(file.desc || "No summary recorded.")}</div>
      <div style="grid-column:1 / -1;"><small>Documents inside the file</small>${documentListHTML(file)}</div>
      <div style="grid-column:1 / -1;"><small>Last QR scan</small>${lastScanText(file)}</div>
    </div><div class="qr-inline"><img class="qr-mini" src="/api/files/${encodeURIComponent(file.id)}/qr-image" alt="QR code for ${esc(file.id)}"><div><b>File QR code</b><small>Use it to find this record quickly.</small></div><button class="table-action" id="trackQr" type="button">Open</button></div></section>
    <section class="panel handover-panel"><h3>Record a handover</h3><p>Every handover is added to the permanent demo movement history with a timestamp.</p>
      <form class="handover-form" id="handoverForm">
        <div class="field"><label for="fromLocation">Handing over from</label><input id="fromLocation" value="${esc(file.location)}" readonly></div>
        <div class="field"><label for="toLocation">Handing over to <span class="required">*</span></label><input id="toLocation" maxlength="255" required placeholder="e.g. Court Hall 2"></div>
        <div class="handover-pair"><div class="field"><label for="handoverStatus">New status</label><select id="handoverStatus">${statuses.map(status => `<option${status === file.status ? " selected" : ""}>${status}</option>`).join("")}</select></div>
          <div class="field"><label for="receivedBy">Received by / new file holder <span class="required">*</span></label><input id="receivedBy" maxlength="255" required placeholder="Lawyer or officer name"></div></div>
        <div class="field"><label for="handoverNotes">Handover note <span class="optional">OPTIONAL</span></label><input id="handoverNotes" maxlength="1000" placeholder="e.g. Sent for scheduled hearing"></div>
        <button class="btn btn-primary" type="submit">Confirm handover <span>→</span></button>
      </form></section>
    <section class="panel handover-panel"><h3>Update file contents</h3><p>Keep the case summary and document checklist current.</p>
      <form class="handover-form" id="fileDetailsForm">
        <div class="field"><label for="fileSummaryEdit">Case summary</label><textarea id="fileSummaryEdit" maxlength="2000" rows="3">${esc(file.desc)}</textarea></div>
        <div class="field"><label for="fileDocumentsEdit">Documents inside the file</label><textarea id="fileDocumentsEdit" maxlength="5000" rows="4" placeholder="Enter one document per line">${esc(file.documents.join("\n"))}</textarea></div>
        <button class="btn btn-outline" type="submit">Save file contents</button>
      </form></section>
    <section class="panel route-panel"><h3>Movement route</h3><div class="flow">${path.map((location, index) => `${index ? "<i>→</i>" : ""}<span>${esc(location)}</span>`).join("")}</div>
      <h4>Complete movement timeline</h4><div class="timeline full">${[...file.history].reverse().map(event => eventHTML({ ...event, id: file.id, caseNo: file.caseNo })).join("") || '<div class="empty">No movement history recorded yet.</div>'}</div></section>
    </div>`;
  $("#trackQr").addEventListener("click", () => showQr(file.id, "File QR code"));
  $("#fileDetailsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const details = { desc: $("#fileSummaryEdit").value.trim(), documents: $("#fileDocumentsEdit").value.trim() };
    try {
      const result = await API.updateDetails(file.id, details);
      await renderTrack(result.file);
      flash($("#trackMsg"), `File contents for ${file.id} updated.`);
    } catch (error) {
      flash($("#trackMsg"), `Could not update file contents: ${error.message}`, false);
    }
  });
  $("#handoverForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = {
      toLocation: $("#toLocation").value.trim(),
      status: $("#handoverStatus").value,
      receivedBy: $("#receivedBy").value.trim(),
      officer: actor,
      notes: $("#handoverNotes").value.trim()
    };
    if (!data.toLocation || !data.receivedBy) return flash($("#trackMsg"), "Destination and receiving officer are required.", false);
    try {
      const result = await API.handover(file.id, data);
      flash($("#trackMsg"), `Handover for ${file.id} recorded at ${fmt(result.event.time)}.`);
      await renderTrack(result.file);
      await renderDashboard();
    } catch (error) {
      flash($("#trackMsg"), `Could not record handover: ${error.message}`, false);
    }
  });
}

$("#trackBtn").addEventListener("click", doTrack);
$("#trackId").addEventListener("keydown", event => { if (event.key === "Enter") doTrack(); });

async function renderHistory() {
  try {
    const events = allEvents(await API.list());
    $("#histList").innerHTML = events.length ? events.map(event => eventHTML(event)).join("") : '<div class="empty">No movement history recorded yet.</div>';
    $("#historyCount").textContent = `${events.length} ${events.length === 1 ? "event" : "events"}`;
    $("#historyMsg").className = "msg";
  } catch (error) {
    flash($("#historyMsg"), `Could not load movement history: ${error.message}`, false);
  }
}

const modal = $("#modal");
function openModal() {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  const closeButton = $("[data-close]", $("#modalBox"));
  if (closeButton) closeButton.focus();
}
function closeModal() {
  if (!authUser) return;
  stopCamera();
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}
modal.addEventListener("click", event => {
  if (authUser && (event.target === modal || event.target.closest("[data-close]"))) closeModal();
});
document.addEventListener("keydown", event => { if (authUser && event.key === "Escape") closeModal(); });

function renderUser() {
  $("#userName").textContent = authUser ? authUser.name : "Sign in required";
  $("#userRole").textContent = authUser ? authUser.role : "Administrator account";
  $("#userAvatar").textContent = authUser ? authUser.name.charAt(0).toUpperCase() : "G";
  $("#notificationsOpen").hidden = !authUser;
}

let notificationItems = [];
async function refreshNotificationBadge() {
  if (!authUser) return;
  try {
    const items = await API.notifications();
    notificationItems = items;
    const unread = items.filter(item => !item.readAt).length;
    const badgeElement = $("#notificationBadge");
    badgeElement.hidden = unread === 0;
    badgeElement.textContent = unread > 50 ? "50+" : String(unread);
    $("#notificationsOpen").title = unread ? `${unread} unread alert${unread === 1 ? "" : "s"}` : "No unread alerts";
  } catch (error) {
    const badgeElement = $("#notificationBadge");
    badgeElement.hidden = false;
    badgeElement.textContent = "!";
    $("#notificationsOpen").title = `Could not load alerts: ${error.message}`;
  }
}

function renderNotifications() {
  const list = $("#notificationList");
  list.innerHTML = notificationItems.length
    ? notificationItems.map(item => `<article class="notification-item${item.readAt ? "" : " unread"}">
        <p><b>${esc(item.fileId)}</b> · ${esc(item.message)}</p>
        <small>${esc(fmt(item.createdAt))}${item.readAt ? " · Read" : " · Unread"}</small>
        ${item.readAt ? "" : `<button class="btn btn-outline" type="button" data-read-notification="${esc(item.id)}">Mark as read</button>`}
      </article>`).join("")
    : '<div class="empty">No station alerts yet.</div>';
}

async function showNotifications() {
  $("#modalBox").innerHTML = `<div class="modal-title"><div><p class="eyebrow">STATION WORKFLOW</p><h2 id="modalTitle">Alerts</h2><p>Missed file-station scans are sent here to the previous station staff member.</p></div><button class="icon-button" data-close aria-label="Close">×</button></div>
    <div id="notificationMsg" class="msg" role="status"></div><div class="notification-list" id="notificationList"><div class="empty">Loading alerts…</div></div>`;
  openModal();
  try {
    notificationItems = await API.notifications();
    renderNotifications();
  } catch (error) {
    flash($("#notificationMsg"), `Could not load alerts: ${error.message}`, false);
  }
}

$("#notificationsOpen").addEventListener("click", showNotifications);
$("#modalBox").addEventListener("click", async event => {
  const button = event.target.closest("button[data-read-notification]");
  if (!button) return;
  try {
    await API.readNotification(button.dataset.readNotification);
    await refreshNotificationBadge();
    renderNotifications();
  } catch (error) {
    flash($("#notificationMsg"), `Could not mark alert as read: ${error.message}`, false);
  }
});
setInterval(refreshNotificationBadge, 15000);
function showLogin() {
  if (authUser) {
    $("#modalBox").innerHTML = `<div class="modal-title"><div><p class="eyebrow">ACCOUNT</p><h2 id="modalTitle">${authUser.role === "Administrator" ? "Administrator account" : "Staff account"}</h2><p>You are signed in to NyayArchive.</p></div><button class="icon-button" data-close aria-label="Close">×</button></div>
      <div id="accountMsg" class="msg" role="status"></div><div class="kv"><div><small>Signed in as</small>${esc(authUser.name)} (${esc(authUser.email)})</div><div><small>Role</small>${esc(authUser.role)}</div></div>
      ${authUser.role === "Administrator" ? `<section class="account-management"><h3>Change password</h3><p>Confirm your current password and choose a new password (at least 12 characters).</p>
        <form class="login-form" id="passwordForm">
          <div><label for="currentPassword">Current password</label><input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div>
          <div><label for="newPassword">New password</label><input id="newPassword" name="newPassword" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div>
          <div id="passwordMsg" class="msg" role="status"></div><button class="btn btn-primary" type="submit">Update password</button>
        </form></section>` : ""}
      ${authUser.role === "Administrator" ? `<section class="account-management"><h3>Staff accounts</h3><p>Set the four station staff names exactly: Mahi Shree → Meghraj → Vishal → Sumera. You can create accounts or update staff names and passwords here.</p>
        <form class="login-form" id="staffForm"><div><label for="staffName">Staff name</label><input id="staffName" name="name" maxlength="100" required></div>
          <div><label for="staffEmail">Staff email (sign-in ID)</label><input id="staffEmail" name="email" type="email" maxlength="254" required></div>
          <div><label for="staffPassword">Set password (at least 12 characters)</label><input id="staffPassword" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div>
          <div id="staffMsg" class="msg" role="status"></div><button class="btn btn-primary" type="submit">Create staff account</button></form>
        <div id="staffList" class="staff-list">Loading accounts…</div></section>` : ""}
      <div class="modal-actions"><button class="btn btn-light" id="signOut" type="button">Sign out</button></div>`;
  } else {
    const setup = setupRequired;
    const notice = loginNotice;
    loginNotice = "";
    $("#modalBox").innerHTML = `<div class="modal-title"><div><p class="eyebrow">${setup ? "FIRST-TIME SETUP" : "ADMINISTRATOR ACCESS"}</p><h2 id="modalTitle">${setup ? "Create the first administrator" : "Sign in to NyayArchive"}</h2>
      <p>${setup ? "Create your own administrator account. No default account is provided." : "Enter the sign-in email and password provided by your administrator."}</p></div>${authUser ? '<button class="icon-button" data-close aria-label="Close">×</button>' : ""}</div>
      ${notice ? `<div class="msg ok" role="status">${esc(notice)}</div>` : ""}
      ${!authStatusAvailable ? `<div class="setup-help">${esc(authStatusError || "Unable to check sign-in or setup status.")} Check the server configuration and retry.</div><div id="loginMsg" class="msg" role="status"></div><button class="btn btn-primary" id="retryAuth" type="button">Retry connection</button>` :
        setup ? `<div class="setup-help">The first administrator account is created once for this database. After setup, use the same email and password to sign in.</div>
        <form class="login-form" id="setupForm"><div><label for="setupName">Administrator name</label><input id="setupName" name="name" maxlength="100" autocomplete="name" required></div>
          <div><label for="setupEmail">Administrator email</label><input id="setupEmail" name="email" type="email" maxlength="254" autocomplete="email" required></div>
          <div><label for="setupPassword">Password (at least 12 characters)</label><input id="setupPassword" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></div>
          <div id="loginMsg" class="msg" role="status"></div><button class="btn btn-primary" type="submit">Create administrator <span>→</span></button></form>` :
        `<form class="login-form" id="loginForm"><div><label for="loginEmail">Email (sign-in ID)</label><input id="loginEmail" name="email" type="email" autocomplete="username" required></div>
          <div><label for="loginPassword">Password</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required></div>
          <div id="loginMsg" class="msg" role="status"></div><button class="btn btn-primary" type="submit">Sign in <span>→</span></button></form>`}`;
  }
  openModal();
  if (authUser) {
    if (authUser.role === "Administrator") {
      $("#passwordForm").addEventListener("submit", async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        try {
          await API.changePassword(data);
          event.currentTarget.reset();
          flash($("#passwordMsg"), "Password updated. Other active sessions have been signed out.");
        } catch (error) {
          flash($("#passwordMsg"), error.message, false);
        }
      });
      loadStaffAccounts();
      $("#staffForm").addEventListener("submit", async event => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.currentTarget).entries());
        try {
          const result = await API.createStaff(data);
          event.currentTarget.reset();
          flash($("#staffMsg"), `Account created for ${result.user.name} (${result.user.email}). Share the email and password you set with them securely.`);
          await loadStaffAccounts();
        } catch (error) {
          flash($("#staffMsg"), error.message, false);
        }
      });
      $("#staffList").addEventListener("click", event => {
        const button = event.target.closest("button[data-edit-staff]");
        if (!button) return;
        const userId = button.dataset.editStaff;
        const row = button.closest(".staff-row");
        row.innerHTML = `<form class="staff-name-form" data-staff-id="${esc(userId)}">
          <label for="editStaffName-${esc(userId)}">Staff name</label>
          <input id="editStaffName-${esc(userId)}" name="name" maxlength="100" value="${esc(button.dataset.staffName)}" required>
          <button class="btn btn-primary" type="submit">Save name</button>
          <button class="btn btn-light" type="button" data-cancel-edit>Cancel</button>
        </form>`;
        row.querySelector("input").focus();
      });
      $("#staffList").addEventListener("click", event => {
        const button = event.target.closest("button[data-reset-staff]");
        if (!button) return;
        const userId = button.dataset.resetStaff;
        const row = button.closest(".staff-row");
        row.innerHTML = `<form class="staff-reset-form" data-staff-id="${esc(userId)}">
          <label for="resetStaffPassword-${esc(userId)}">New password (at least 12 characters)</label>
          <input id="resetStaffPassword-${esc(userId)}" name="password" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required>
          <button class="btn btn-primary" type="submit">Save new password</button>
          <button class="btn btn-light" type="button" data-cancel-reset>Cancel</button>
        </form>`;
        row.querySelector("input").focus();
      });
      $("#staffList").addEventListener("click", event => {
        if (!event.target.closest("[data-cancel-reset], [data-cancel-edit]")) return;
        loadStaffAccounts();
      });
      $("#staffList").addEventListener("submit", async event => {
        const form = event.target.closest(".staff-name-form");
        if (!form) return;
        event.preventDefault();
        const name = new FormData(form).get("name");
        try {
          await API.updateStaffName(form.dataset.staffId, name);
          flash($("#staffMsg"), "Staff name updated.");
          await loadStaffAccounts();
        } catch (error) {
          flash($("#staffMsg"), `Could not change staff name: ${error.message}`, false);
        }
      });
      $("#staffList").addEventListener("submit", async event => {
        const form = event.target.closest(".staff-reset-form");
        if (!form) return;
        event.preventDefault();
        const password = new FormData(form).get("password");
        try {
          await API.resetStaffPassword(form.dataset.staffId, password);
          flash($("#staffMsg"), "Staff password updated. Their other active sessions have been signed out.");
          await loadStaffAccounts();
        } catch (error) {
          flash($("#staffMsg"), `Could not change staff password: ${error.message}`, false);
        }
      });
    }
    $("#signOut").addEventListener("click", () => {
      API.logout().then(() => {
        authUser = null;
        renderUser();
        document.body.classList.add("auth-required");
        showLogin();
      }).catch(error => flash($("#accountMsg"), `Could not sign out: ${error.message}`, false));
    });
  } else if (!authStatusAvailable) {
    $("#retryAuth").addEventListener("click", initializeAuth);
  } else if (setupRequired) {
    $("#setupForm").addEventListener("submit", async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget).entries());
      try {
        await API.setup(data);
        setupRequired = false;
        loginNotice = "Administrator account created. Sign in with the email and password you just chose.";
        renderUser();
        showLogin();
      } catch (error) {
        flash($("#loginMsg"), error.message, false);
      }
    });
  } else if (authStatusAvailable) {
    $("#loginForm").addEventListener("submit", event => {
      event.preventDefault();
      API.login({ email: $("#loginEmail").value.trim(), password: $("#loginPassword").value })
        .then(result => {
          authUser = result.user;
          document.body.classList.remove("auth-required");
          renderUser();
          refreshNotificationBadge();
          closeModal();
          renderDashboard();
        })
        .catch(error => flash($("#loginMsg"), error.message, false));
    });
  }
}

async function loadStaffAccounts() {
  const list = $("#staffList");
  if (!list) return;
  try {
    const users = await API.staff();
    list.innerHTML = users.map(user => `<div class="staff-row"><span><b>${esc(user.name)}</b><small>${esc(user.email)}</small></span><span class="staff-role">${esc(user.role)}</span><button class="table-action" type="button" data-edit-staff="${esc(user.id)}" data-staff-name="${esc(user.name)}">Change name</button><button class="table-action" type="button" data-reset-staff="${esc(user.id)}">Change password</button></div>`).join("") ||
      '<div class="empty">No accounts found.</div>';
  } catch (error) {
    list.textContent = `Could not load accounts: ${error.message}`;
    list.classList.add("staff-error");
  }
}

$("#loginOpen").addEventListener("click", showLogin);

async function initializeAuth() {
  try {
    const status = await API.authStatus();
    authStatusAvailable = true;
    authStatusError = "";
    authUser = status.user;
    setupRequired = status.setupRequired;
    renderUser();
    if (authUser) {
      document.body.classList.remove("auth-required");
      closeModal();
      refreshNotificationBadge();
      renderDashboard();
    } else {
      document.body.classList.add("auth-required");
      showLogin();
    }
  } catch (error) {
    authStatusAvailable = false;
    authStatusError = error.message;
    authUser = null;
    renderUser();
    document.body.classList.add("auth-required");
    showLogin();
  }
}

let cameraStream = null;
let cameraTimer = null;
function stopCamera() {
  if (cameraTimer) clearTimeout(cameraTimer);
  cameraTimer = null;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
}
function normalizeScannedId(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/NA-\d{4}-\d+/i);
  return match ? match[0].toUpperCase() : raw;
}
function acceptScan(value, mode = "track") {
  const id = normalizeScannedId(value);
  if (!id) return;
  stopCamera();
  closeModal();
  if (mode === "register") {
    $("#registerLookupId").value = id;
    lookupRegisterFile(true);
    return;
  }
  $("#trackId").value = id;
  setPage("track");
  doTrack(true);
}
function showScanner(mode = "track") {
  const secureContext = window.isSecureContext;
  const cameraAvailable = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const qrDetectionAvailable = "BarcodeDetector" in window;
  const cameraCanStart = secureContext && cameraAvailable && qrDetectionAvailable;
  let statusMessage = "Camera is ready. Tap Start camera and allow camera access.";
  if (!secureContext) {
    statusMessage = "Camera is blocked because this page is not HTTPS. A local address such as http://192.168.x.x:3000 cannot access the camera.";
  } else if (!cameraAvailable) {
    statusMessage = "This browser does not provide camera access. Try the latest Chrome or Safari, or enter the file ID below.";
  } else if (!qrDetectionAvailable) {
    statusMessage = "This browser does not support QR scanning inside the app. Use a supported browser or enter the file ID below.";
  }
  $("#modalBox").innerHTML = `<div class="modal-title"><div><p class="eyebrow">FILE LOOKUP</p><h2 id="modalTitle">Scan a file QR code</h2><p>Scan while signed in as the expected next station owner. Out-of-order scans are blocked and an alert is sent to the previous station staff member. Allow camera access or enter the file ID manually.</p></div><button class="icon-button" data-close aria-label="Close">×</button></div>
    <video class="scanner-video" id="scanVideo" autoplay muted playsinline aria-label="Camera preview"></video><p class="scan-status" id="scanStatus">${esc(statusMessage)}</p>
    <div class="modal-actions"><button class="btn btn-primary" id="startCamera" type="button"${cameraCanStart ? "" : " disabled"}>Start camera</button></div>
    <form class="scan-manual" id="manualScan"><div><label for="scanId">Enter file ID</label><input id="scanId" placeholder="e.g. NA-2026-001" required></div><button class="btn btn-outline" type="submit">Look up</button></form>`;
  openModal();
  $("#manualScan").addEventListener("submit", event => { event.preventDefault(); acceptScan($("#scanId").value, mode); });
  $("#startCamera").addEventListener("click", () => startCamera(mode));
}
async function startCamera(mode = "track") {
  const status = $("#scanStatus");
  try {
    if (!window.isSecureContext) throw new Error("Camera access requires HTTPS. A local address such as http://192.168.x.x:3000 is not secure.");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("This browser does not provide camera access. Update the browser or use another supported browser.");
    if (!("BarcodeDetector" in window)) throw new Error("Live QR scanning is not supported in this browser.");
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    $("#scanVideo").srcObject = cameraStream;
    await $("#scanVideo").play();
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    status.textContent = "Point the camera at a NyayArchive file QR code.";
    const scanFrame = async () => {
      if (!cameraStream || !modal.classList.contains("open")) return;
      try {
        const codes = await detector.detect($("#scanVideo"));
        if (codes.length) return acceptScan(codes[0].rawValue, mode);
      } catch (error) {
        status.textContent = `Could not read the camera frame: ${error.message}`;
        stopCamera();
        return;
      }
      cameraTimer = setTimeout(scanFrame, 350);
    };
    const video = $("#scanVideo");
    if (video.readyState >= 2) scanFrame();
    else video.addEventListener("loadeddata", scanFrame, { once: true });
  } catch (error) {
    const messages = {
      NotAllowedError: "Camera permission was denied. Allow camera access for this site in your browser settings, then try again.",
      NotFoundError: "No camera was found on this device.",
      NotReadableError: "The camera is busy in another app. Close that app and try again.",
      OverconstrainedError: "The requested camera is unavailable. Try again using another camera on this device."
    };
    status.textContent = `Camera unavailable: ${messages[error.name] || error.message} If needed, enter the file ID below instead.`;
    stopCamera();
  }
}
$("#openScanner").addEventListener("click", showScanner);
$("#scanTrack").addEventListener("click", showScanner);

document.body.classList.add("auth-required");
renderUser();
initializeAuth();
