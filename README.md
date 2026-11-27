# Numo

Numo is a browser-based email app where your phone number gives you a mailbox. On a default installation, a number ending in `5550101234` gets the address `5550101234@numo.local`. Sign in, enter another registered user's number, and exchange email in a conversation.

## What you can do

- Read incoming and outgoing messages in one thread. On desktop, the conversation list stays beside the open thread. On a small screen, the thread opens full-screen.
- Search conversations by contact name or address. Start one by typing a phone number or email address, or pick a contact on browsers that support it.
- Track a message as it sends and retry a failed send without retyping it. An open inbox checks for new mail every three seconds.
- Edit your display name and manage mailbox aliases in Settings. Closing the tab keeps you signed in. Each new session expires 14 days after sign-in, or sooner if you sign out.

## Run Numo on your PC

Install and start Docker Desktop with Docker Compose. Open PowerShell in the folder containing [docker-compose.yml](docker-compose.yml). Docker runs the web app, API, databases, and mail listener together.

1. Create your private configuration file from [the example](.env.example). The command preserves an existing installation's settings.

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

2. On a fresh installation, replace the sample `JWT_SECRET` with your own random value. Run this PowerShell command to copy a new secret to the clipboard, then paste it after `JWT_SECRET=` and save. Keep the same secret, database connection, and mailbox domain when restarting an existing installation.

   ```powershell
   $secretBytes = New-Object byte[] 32
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
   $rng.GetBytes($secretBytes)
   $rng.Dispose()
   [Convert]::ToBase64String($secretBytes) | Set-Clipboard
   ```

3. For a private test on your PC, use `NODE_ENV=development`, leave the three `TWILIO_` values empty, and add `RECOVERY_TEST_SMTP_HOST=mailpit` to your root `.env`. This enables the local SMS code and captures account emails in Mailpit. Start the services in the same PowerShell window.

   ```powershell
   docker compose --profile mail-testing up --build -d
   docker compose ps
   ```

4. Open Numo, enter a test phone number, select **Get OTP**, and choose **Get sign-in help** to see the local code. After verifying the phone, enter a test recovery address such as `first@example.test`. Open Mailpit, copy the eight-digit email code, and enter it in Numo to create your mailbox. Anyone with access to this test inbox can see its codes and links, so use it only for local testing. [Open Numo](http://localhost:3000) · [Open Mailpit](http://localhost:8025)

5. To try a conversation, repeat signup in a private browser window with a second test number and recovery address. In the first window, choose **Compose**, enter the second number, select **Start conversation**, and send a message.

Compose initializes PostgreSQL on first startup and keeps mailbox data in a named volume. Use `docker compose stop` to pause the app and `docker compose start` to resume it. If the page opens but sign-in fails, check the backend logs with `docker compose logs --tail=50 backend`. The API health endpoint is at [localhost:4000/api/health](http://localhost:4000/api/health).

## Signup and recovery

New users verify their phone number and an external recovery email before Numo creates their mailbox. Double-check the address before confirming the email code. Once confirmed, the recovery address is permanent. Accounts created in earlier versions enroll once at their next sign-in after verifying their phone. Their existing mail and original session expiry are preserved.

If SMS is unavailable, enter your registered phone number and choose **Sign in with recovery email**. Open the email and select **Sign in to Numo**. Each link works once and expires in 15 minutes. Requesting a new link after the cooldown replaces the previous one. This option works once the account has a verified recovery address.

For real email delivery, set `EXTERNAL_SMTP_USER` to your Gmail address and `EXTERNAL_SMTP_PASS` to its Google app password in the root `.env`. Leave `RECOVERY_TEST_SMTP_HOST` empty. Set `APP_PUBLIC_URL` to the Numo **web address** recipients can open, such as `http://localhost:3000` on the same PC or your public HTTPS web address. Apply the settings with `docker compose up --build -d`.

## Mail delivery

Mail between two registered Numo users stays in the configured PostgreSQL database. The default mailbox domain is `numo.local`.

- **Send to an external address.** Add `EXTERNAL_SMTP_USER` (your Gmail address) and `EXTERNAL_SMTP_PASS` (its app password) to the root `.env`, then run `docker compose up -d backend`. The backend sends through Gmail and sets the Numo mailbox as the reply-to address. These settings are optional for local conversations.
- **Receive incoming SMTP mail.** The listener accepts messages for registered mailboxes under `SMTP_DOMAIN` on port `2525`. To receive mail or replies from the public internet, use a domain you control and configure an inbound mail route to the listener.

## Project layout

| Location | Role | Default local port |
| --- | --- | --- |
| [web-client/](web-client/) | React and TypeScript interface, built with Vite and served by Nginx in Docker | 3000 in Docker, 5173 with Vite |
| [backend/](backend/) | Express API for sign-in, conversations, contacts, and settings | 4000 |
| [smtp-server/](smtp-server/) | Node.js SMTP listener that parses incoming mail and stores it in PostgreSQL | 2525 |
| [Database schema](backend/src/db/init.sql) | PostgreSQL tables for accounts, conversations, messages, and recipients | 5432 |
| [Compose services](docker-compose.yml) | Redis stores temporary registration data | 6379 |

The original Android client and installer are archived separately under `backups/android/android-client.zip` in the local workspace.

## Develop outside Docker

Use Node.js 22.12 or later and npm. Initialize a PostgreSQL database with [the schema](backend/src/db/init.sql). In the root `.env`, set `DATABASE_URL` to a connection reachable from your PC. For a local database, use `localhost` as the hostname. Set `REDIS_URL` to your Redis instance, or leave it empty to use the backend's in-memory store.

Open a terminal in each component you want to run. Run `npm ci` once in each directory, then `npm run dev`. The backend reads the root `.env` and applies the recovery tables automatically. For the standalone SMTP server, supply the same `DATABASE_URL` and `SMTP_DOMAIN` in its process environment or in `smtp-server/.env`. For Vite, set `APP_PUBLIC_URL=http://localhost:5173`. If you run Mailpit in Docker with the backend on the host, set `RECOVERY_TEST_SMTP_HOST=localhost` in development. Vite forwards `/api` to port `4000`. [Open the development web client](http://localhost:5173)

Run `npm run build` separately in `web-client`, `backend`, and `smtp-server` to build all three. The production web client uses `/api` on its own origin by default. Set `VITE_API_URL` at build time for a separately hosted API.
