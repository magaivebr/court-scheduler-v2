# Private server

An online host runs browser sessions. Participants use ordinary browsers. A sleeping laptop or locked smartphone is not a dependable host.

Oracle Always Free documentation checked 20 November 2026 lists Ampere A1 capacity equivalent to **2 OCPUs and 12 GB memory** for an Always Free tenancy, subject to availability. Idle resources may be reclaimed; no free-tier SLA applies. Signup requires account/card verification. Stay within resources explicitly marked Always Free; this project creates no cloud account or paid resources.

References: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm and https://www.oracle.com/cloud/free/faq/

## Docker on a single Linux host

Prerequisites: Docker Compose, a DNS hostname pointed at the host and inbound HTTPS allowed. Restrict SSH to the operator. Caddy handles HTTPS; do not expose internal port 4318 publicly.

```sh
npm ci --ignore-scripts
node scripts/configure.mjs --origin https://your-host.example
docker compose --env-file .env -f deploy/compose.yml up -d --build
docker compose --env-file .env -f deploy/compose.yml exec scheduler node scripts/admin.mjs create-invite --name "Participant" --hours 48
```

The generated `.env` is private. Caddy receives only the public hostname; the session encryption key is supplied only to the scheduler. Named volumes persist database and certificates. The ARM64 build needs verification on the actual VM. Initial mode is rehearsal.

### Chromium sandbox

The booking browser always launches with `chromiumSandbox: true`. There is no setting or automatic fallback that disables it. The Docker image runs as the non-root `node` user. Compose keeps `no-new-privileges` and drops all capabilities, and applies `deploy/seccomp_profile.json` so Chromium can create the user namespaces its sandbox needs. The profile path is relative to `deploy/compose.yml`.

The pinned profile is the unmodified [Playwright v1.58.2 upstream profile](https://raw.githubusercontent.com/microsoft/playwright/v1.58.2/utils/docker/seccomp_profile.json), matching this project's Playwright dependency. Its SHA-256 is `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. The upstream license is included in `deploy/PLAYWRIGHT-LICENSE.txt`. It retains a deny-by-default seccomp policy with the upstream namespace permissions; it is not an unconfined profile. See [Playwright's Docker sandbox guidance](https://playwright.dev/docs/docker).

The deployment host must support unprivileged user namespaces and permit the sandbox under its kernel/container security policy. Browser startup must be tested on that actual host before enabling live mode. If the host blocks it, keep live operation disabled and use a compatible host configuration; do not work around the failure with `--no-sandbox`, privileged containers, unconfined seccomp or added administrator capabilities. No Docker sandbox execution was verified on this Windows development machine. Sandboxed Edge fixture tests did pass on Windows with approved external-process execution.

## Live readiness

Verify real remote login on iPhone, Android and intended corporate browsers; inspect stable provider identity and normal reservation history; confirm applicable booking/automation rules and eligibility. Configure verified `PROVIDER_IDENTITY_SELECTOR` and `PROVIDER_IDENTITY_ATTRIBUTE` based on evidence, not a display name. Test concurrent execution on local fixtures, never by load-testing the official provider.

Only after validation deliberately set `BOOKING_MODE=live` and `LIVE_BOOKING_ENABLED=true` and restart. Each user still must connect their own account, test the exact plan and authorize the schedule. Uncertain submissions remain stopped for review. A successful UI marker is not independent reservation-history reconciliation.

## Operations

Monitor the health endpoint and sanitized logs. Keep one scheduler process. Back up SQLite using its backup API, or stop the service before copying database/WAL files; protect the vault key separately. Verify restoration. Schedule updates outside release preparation. Measure readiness, memory and dispatch latency before increasing simultaneous accounts. Free hosting provides no guarantee of release-time execution or court availability.
