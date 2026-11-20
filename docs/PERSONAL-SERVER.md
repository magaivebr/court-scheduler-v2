# Personal Windows server

Participants use the bookmarked website in a normal browser. They do not install Tailscale, Node.js, Edge extensions or any other application. This PC runs the private scheduler and its isolated booking browsers.

## Connection

Tailscale Funnel supplies the public HTTPS connection to the app on `127.0.0.1:4318`. Only that application is exposed. The Node server remains bound to loopback; no router port forwarding is required. Account creation requires a one-use invitation. GitHub Pages only links to the private service and contains no credentials.

Funnel is available on Tailscale's free personal plan, but has bandwidth limits and no promise of uninterrupted service. The Tailscale account and the host device must remain connected. Keep the host powered on with internet access. Locking Windows is compatible with hosting; shutting down, sleeping or losing connectivity interrupts service. Default Tailscale device keys expire after 180 days, so review the device expiry in the admin console before it is due. Do not disable expiry without considering the effect of a stolen device.

## Windows startup

After installing Node.js 24.13+ and signing in to the official Windows Tailscale app on the host, configure the device's HTTPS hostname, then run from this project directory:

```powershell
npm ci --ignore-scripts
node scripts/configure-windows-host.mjs --origin https://your-device.your-tailnet.ts.net
node scripts/install-windows-host.mjs
```

The setup preserves an existing encryption key and deliberately returns booking mode to rehearsal. It uses the existing Microsoft Edge browser. Run it as the Windows account that will host the service. Once the local service is healthy, run `tailscale funnel --bg 4318` and review Tailscale's HTTPS/Funnel activation prompt. Only enable the public link after reviewing the access change. Configure GitHub's `PUBLIC_BACKEND_URL` Actions variable with the same HTTPS origin and run the Pages workflow.

The Windows task is named **Court Scheduler v2**. It runs as the host owner with limited privileges using the existing Windows sign-in session, without storing the Windows password. It starts at logon, ignores duplicate starts, and asks Windows to restart it after a failure. **After a reboot, the owner must sign in to Windows before the scheduler resumes.** The screen can then be locked. Tailscale's own service runs automatically in unattended mode. Setup uses Windows' task and filesystem tools; it does not change PowerShell execution policies.

At startup, the app checks that a sandboxed Edge browser can open two isolated contexts using synthetic local pages. No official booking request is made by this check. The application only starts after the check passes. Task registration and execution must be verified on the actual host; preparing these files alone does not mean the task is installed successfully.

Run these commands from the project directory:

```powershell
node scripts/host-control.mjs status
node scripts/host-control.mjs start
node scripts/host-control.mjs stop
node scripts/host-control.mjs restart
node scripts/host-control.mjs invite "Participant"
```

An invitation is private and can be used only once. Each participant creates their own scheduler password and connects their own booking account. Never share a scheduler account among multiple people.

The stop/restart commands request a graceful shutdown through a file in the protected data directory. They do not force-kill a running booking browser. After an unexpected process exit, startup waits for the old scheduler lease to expire before resuming. Avoid maintenance during a release window.

## Local data

The private `.env` contains the session encryption key. `.data/` contains the local database, session vault and operational status. The installer restricts access to the host owner, SYSTEM and local administrators. These files must never be uploaded to GitHub. The host operator can access reusable sessions; encryption at rest does not hide them from the operator.

`.data/host-status.json` contains only operational status, and `.data/host.log` contains sanitized startup messages. A stale status file is not proof that the service is still running; check the Windows task and the HTTPS `/healthz` endpoint as well.

Back up the SQLite database consistently with SQLite's backup API or by stopping the task before copying the database and any remaining WAL files. Keep a protected copy of the encryption key separately. A database backup cannot decrypt provider sessions if its matching key is lost. Do not restore old pending jobs directly into live execution without reviewing their outcomes.

## Current booking mode

The Windows configuration starts in **rehearsal mode**. Hosting the app does not validate the live provider integration. Real remote login, a stable account identity, reservation-history reconciliation and release-time performance still need validation before enabling actual booking. A 32 GB host is not itself proof of successful 30-account release-time capacity.

## Sources

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale personal plan](https://tailscale.com/pricing)
- [Windows unattended mode and key expiry](https://tailscale.com/docs/how-to/run-unattended)
