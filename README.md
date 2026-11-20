# Court Scheduler v2

Invitation-only court scheduling with a separate booking session for every account. Desktop and mobile layouts preserve the familiar indoor beach volleyball booking interface. This is an independent assistant, not the official KU Leuven or Delcom service.

## Architecture

- **GitHub Pages:** public interface and link to the private service; no credentials or session state. Without a backend URL, it reports scheduling unavailable.
- **Private server:** user authentication, ownership checks, encrypted provider sessions, durable jobs and booking attempts.
- **Booking worker:** isolated Playwright browser contexts. Accepted schedules execute on the host independently of participant devices.

The application starts in **rehearsal mode**, which never contacts KU Leuven. A live DOM adapter is included, based on the existing extension. Actual hosted login, stable account identity, reservation verification and release behavior still require live validation. No real booking was made during development. Unknown submissions are stopped and never blindly retried.

## Run locally — host/operator only

Requires Node.js 24.13 or later. Participants only need a browser.

```powershell
npm ci --ignore-scripts
node scripts/configure.mjs
node --env-file=.env scripts/admin.mjs create-invite --name "First participant" --hours 48
npm start
```

Open http://127.0.0.1:4318 and use the one-use invitation to create an account. Connect a rehearsal account, choose the date and first hour, then select **Schedule rehearsal**. This one click runs the checks and authorizes the two displayed sessions; there is no review dialog or separate test button. Wait for server acceptance in My schedules. Rehearsal execution is separate from the official release instant.

For the host's real browser connection, run `npx playwright install chromium`, or configure `BROWSER_CHANNEL=msedge` to use an existing permitted compatible Edge browser. Nothing is installed on participant devices.

## Verify

```powershell
npm run check
npm test
npm run build:pages
npm run test:browser
```

Browser tests use local fixtures and need the matching browser. See [verification](docs/VERIFICATION.md) for checks actually performed.

## Host and publish

See [GitHub Pages](docs/GITHUB-PAGES.md) and [server deployment](docs/DEPLOYMENT.md). GitHub Pages alone cannot execute unattended bookings. The single-host server uses SQLite WAL with database transactions to keep the free deployment self-contained. Do not run independent scheduler replicas or place SQLite on network storage. Multiple hosts would need a shared database and safe failover design.

## Data and integration limits

Runtime `.data/` and private `.env` are excluded from Git and Docker builds. Protect the database and encryption key separately. Provider passwords are not intentionally retained; remote login input passes through the private host to the official page. The host operator can access reusable sessions: encryption at rest is not end-to-end encryption.

Each scheduler user owns their connection and jobs. Reconnect/disconnect is isolated. A visible account display name alone is insufficient to verify unique provider identity, so live arming requires a verified stable identity contract. No selector is invented. Disconnect removes local access but does not remotely revoke the official provider session.

Two hourly reservations are not atomic. One confirmed hour is partial; ambiguous outcomes require review. Availability, account eligibility and provider limits remain controlled by the official service. Thirty simultaneous accounts is a test target, not a production capacity guarantee. The host must be measured before broad rollout.
