# NyayArchive 2.0

NyayArchive is a fictional court-file tracking prototype. It stores file and movement records in MySQL and binds its web server to all network interfaces. HTTPS can be enabled for trusted local-network camera access.

## Configure and start

1. Install Node.js and MySQL.
2. Create a MySQL database for the application and configure the connection in the ignored `.env` file:

   ```dotenv
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=your_database_user
   DB_PASSWORD=your_database_password
   DB_NAME=your_database_name
   PORT=3000
   ```

   Use your own database credentials; do not commit `.env`. The database user needs permission to create and modify the application's tables.
3. Install dependencies with `npm install`, then start the application with `npm start`.
4. Without HTTPS configured, open `http://localhost:3000`. For HTTPS and phone-camera scanning, follow **Enable HTTPS for your phone** below first, then open `https://localhost:3000` on the laptop. On first launch, the application creates its tables without deleting existing file records. If the database has no administrator yet, the setup screen asks you to choose an administrator name, email, and password (at least 12 characters). There is no default account.
5. After creating that first administrator, sign in with the same email and password. On later visits, use that account to sign in. A session identifier is stored in an HTTP-only cookie; restarting the server signs active sessions out, but does not remove administrator accounts or file records.

## Enable HTTPS for your phone

HTTPS uses a local development certificate so the app and MySQL remain on your laptop; it does not publish the app to the internet. The setup uses Windows' built-in certificate tools and does not need an internet download.

1. Run `ipconfig` and note the laptop's IPv4 address on the active phone-hotspot Wi-Fi adapter.
2. From the project folder, run `powershell -ExecutionPolicy Bypass -File .\scripts\setup-https.ps1 -IpAddress <laptop-ip>`, replacing `<laptop-ip>` with that address. The script creates a certificate, trusts its local CA on the laptop, and adds HTTPS settings to the ignored `.env` file without replacing your database settings.
3. Transfer only `certs\nyayarchive-root.cer` to the phone using USB or another private method and install it as a trusted CA certificate. **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA certificate (wording varies by device). **iPhone:** install the downloaded certificate profile in Settings, then enable it under Settings → General → About → Certificate Trust Settings. Only install a CA certificate you generated and control. Never transfer `certs\nyayarchive.pfx` or the HTTPS password from `.env`.
4. Stop the old server with `Ctrl+C`, run `npm start`, and open `https://<laptop-ip>:3000` on the laptop and phone. Allow camera access when the browser prompts. The phone and laptop must remain on the same hotspot/network.

The phone must trust the local CA; accepting a certificate warning alone may not enable camera access. After a hotspot/IP change, rerun the setup script using the new Wi-Fi IPv4 address. The `certs` folder is ignored by Git because it contains the private HTTPS key. Use a current browser that supports in-page QR detection; otherwise the app offers manual file-ID lookup.

## Open on a phone on the same Wi-Fi

1. Connect the computer running NyayArchive and the phone to the same Wi-Fi network.
2. Start the app on the computer with `npm start` and keep that terminal and computer running.
3. Find the computer's IPv4 address with `ipconfig` on Windows (look for **IPv4 Address** under the active Wi-Fi adapter).
4. On the phone, open `https://<computer-ipv4-address>:3000` after configuring HTTPS above. Do not use `localhost` on the phone.
5. If Windows Firewall asks, allow Node.js on **Private networks**. Do not open the port to public networks.

The app and its MySQL database stay on the computer; the phone only accesses the web app over the local hotspot. Do not expose the development computer or its MySQL server directly to the public internet. If you do not configure HTTPS, camera scanning will be blocked on the phone; use its camera/QR reader to read the file ID and enter it in NyayArchive.

Initial administrator setup is available only while the administrators table has no administrator accounts. If setup has already been completed, sign in with the existing administrator account. From the account menu, an administrator can change their own password after entering the current password, create staff accounts, change staff names, and set a new password for any staff account. Staff password changes immediately sign that staff member out of other active sessions; name changes take effect on their next request without signing them out. Choose passwords of at least 12 characters and share them with the staff member using a trusted channel. Staff sign in with their email and password and have the same file-workspace access, but cannot manage accounts or change other staff names/passwords. Passwords are stored only as hashes and cannot be retrieved later.

To track a file through its assigned stations, create or rename four staff accounts to exactly **Mahi Shree**, **Meghraj**, **Vishal**, and **Sumera**. Their fixed, strictly enforced route is **Record Room → Clerk → Courtroom → Judge's Office → Record Room**. Sign in as the staff member at the expected next station and scan the file QR there; only that scan updates the file's location, holder, and movement history. A later station cannot scan until the expected station has scanned: the out-of-order scan is rejected, the file stays unchanged, and an in-app alert is sent to the person who completed the previous valid station scan (or Mahi Shree for a wrong first scan). For example, if Record Room scans and the file reaches Courtroom without a Clerk scan, the Courtroom scan is blocked, Meghraj must scan first, and Mahi Shree receives an alert about the missed Clerk scan. Open **Alerts** in the top bar to see and mark messages as read. If an alert cannot be delivered because the previous station's account is unavailable, the scan is rejected with an error so an administrator can restore that account.

To look up a file by QR code, sign in, choose **Scan a QR code to see file details** on the overview or open **Track & hand over** and choose **Scan QR**. Allow camera access and point the camera at a NyayArchive file QR code. The app opens the matching file with its current location and status, case number/type/year, current holder, file date, case summary, document checklist, and movement timeline. File details show who performed the latest scan, the station and time, and the previous holder before that scan. Use **Update file contents** in the tracking view to fill in or update an existing file's summary and document checklist. Handover history separately records who logged each transfer and who received the file. The QR contains only the file ID; details are shown inside the signed-in app. If live scanning is unavailable, use your phone's QR scanner to read the ID and enter it in the app's **Scan QR** lookup form.

The server uses `PORT` when configured and otherwise uses port `3000`. If both `HTTPS_PFX_PATH` and `HTTPS_PFX_PASSWORD`, or both `HTTPS_CERT_PATH` and `HTTPS_KEY_PATH`, are set, it serves HTTPS; if neither pair is set, it serves HTTP. Configure only one pair. If another application already owns that port, NyayArchive reports the conflict and leaves the other process alone. Identify the owning process before deciding whether to stop it.

The prototype may add its fictional sample file records when the file table is empty. It does not overwrite or delete existing records.

## Deploy on Netlify and Render

Netlify serves the static website, but it cannot run `server.js` or connect to MySQL. Deploy the Node.js server separately on Render and proxy `/api/*` through Netlify so the existing same-origin API and session cookie continue to work.

1. Create a MySQL database that is reachable from Render. In Render, create a Blueprint from this repository and provide `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` when prompted. The `render.yaml` blueprint starts the API with `NODE_ENV=production`; do not add database credentials to the repository.
2. Wait for the Render web service to finish deploying, then copy its public URL (for example, `https://nyayarchive-api.onrender.com`).
3. In `netlify.toml`, replace `https://REPLACE-WITH-RENDER-SERVICE.onrender.com` with that Render service URL. Keep the `/api/:splat` suffix in the destination.
4. Commit and push the updated `netlify.toml`, then trigger a new Netlify deploy. Netlify's `/api/*` proxy sends authentication and other API requests to Render.
5. Open the Netlify site and check that `/api/auth/status` responds with JSON rather than a Netlify 404. On first use, create the administrator account.

The Render and Netlify sites must use HTTPS. The Render service keeps login sessions in memory, so restarting or redeploying it signs users out; it does not remove accounts or file records from MySQL.

## Tests

Run the focused Node.js tests with:

```sh
npm test
```
