# Verification record

Checked on 20 November 2026 in the Windows development workspace using Node.js 24.13.1. This record distinguishes application checks from validation against the real booking service.

## Completed checks

| Command | Observed result |
| --- | --- |
| `npm test` | **20 passed, 0 failed, 0 skipped** |
| `npm run check` | **18 JavaScript files passed syntax checking** |
| `npm run test:browser` | **7 passed, 0 failed**, reported by the browser QA run |
| `node --test tests/browser/provider.test.mjs` after enabling Chromium sandbox | **4 passed, 0 failed**, using installed Edge with approved external-process execution on Windows |

The unit and integration suite uses generated users, local SQLite databases, synthetic provider behavior and mocked remote-browser operations. It does not log into KU Leuven or submit real reservations.

The completed suite exercises:

- Brussels release-date calculation across both daylight-saving transitions.
- Production configuration checks for HTTPS and a vault encryption key.
- Invitation-only registration, password login, cookie protection, CSRF, request origin/Host checks and tenant-scoped job access.
- Encryption and authenticated binding of provider session state to the owning scheduler user. Swapping encrypted state between users fails authentication.
- Persistent ownership of a verified provider identity: disconnect removes reusable session state but does not let a different scheduler user claim that identity.
- Separate draft and final booking authorization, request idempotency and account/test freshness checks.
- Execution lease fencing, one submission grant per requested hour, and internal claims for competing court/time requests.
- Recovery of a pending submission after database reopen as **unknown**, without automatic resubmission.
- Thirty isolated accounts completing synthetic server-side rehearsals with separate schedules/results. A competing-users scenario also verifies that four users do not all receive the same three synthetic courts.
- Stopping during final readiness without a submission, and lease loss before granting a submission.
- Guarding live arming when only a display name identifies the account.
- Remote handoff ownership, input validation, expiry and cancellation races, plus the browser request hostname allowlist.
- Chromium sandbox is explicitly required for every browser launch; launch failures are never retried with the sandbox disabled.
- Distinguishing complete, partial and unknown outcomes.

The 30-account rehearsal is a correctness test of application coordination. It is **not** a benchmark of 30 real authenticated browser sessions, a measurement of cloud capacity, or evidence of successful release-time bookings.

The browser suite uses the local application and controlled booking-page fixtures. It covers the desktop/mobile-width registration and scheduling flow, explicit final consent, persisted results, the GitHub Pages mode without credential collection or executable schedules, scaled remote-login input with cleared text, read-only dialog validation, one authorized fixture submission, account/price mismatch rejection, waitlist and lease-guard handling, and cookie isolation between actual browser contexts. Fixture submissions are synthetic and do not reserve a real court.

The four provider browser fixtures were rerun after making Chromium sandbox mandatory. The default development-tool sandbox prevented Edge renderer creation; running those same fixtures with approved external-process permissions passed all four while keeping Chromium's own sandbox enabled. This is Windows validation only. The non-root Docker configuration and pinned seccomp profile still require validation on the deployment host.

## Integration and deployment limits

No real booking, cancellation or authenticated production login was performed for these checks. The following remain unverified:

- Remote KU Leuven login, SSO/MFA behavior, session lifetime and reconnect behavior on actual iPhone, Android and corporate-managed browsers.
- A stable provider identity field and the operator's corresponding selector configuration. No production identity selector is supplied as a verified default.
- Actual membership/quota behavior, provider request limits, release-boundary behavior and current live markup compatibility.
- Independent reservation-history verification. The adapter's success evidence is the official page's success marker; ambiguous outcomes remain stopped for manual review and are not automatically reconciled against history.
- Docker image execution, Chromium sandbox behavior on the deployment host, ARM64 compatibility, cloud provisioning, TLS deployment, backup restoration and sustained operation on a free-tier host.
- Real memory/CPU requirements and dispatch latency for 10–30 simultaneous connected accounts.

Browser layout emulation, when performed, is not a substitute for testing on physical mobile devices. A GitHub Pages deployment only publishes the public interface; it does not provision or validate the private booking server.

## Release state

### Windows personal host check — 20 November 2026

The personal Windows host passed all 20 unit/integration checks, all 7 browser checks and syntax validation of 23 JavaScript files. Its limited per-user startup task was registered and observed running. The actual task opened a sandboxed Edge browser and verified two isolated contexts using entirely synthetic intercepted pages. A graceful stop/start was observed in the host log and followed by a healthy local `/healthz` response with the scheduler running in rehearsal. This verifies the current logged-in session; an actual reboot has not been tested. Tailscale's public Funnel activation and public HTTPS end-to-end checks were still pending when this record was written. See [personal server operation](PERSONAL-SERVER.md).

The default configuration remains **rehearsal**, with live booking disabled. Production requires HTTPS configuration and a private encryption key. Live arming additionally checks explicit activation, an owned connected account, a configured stable identity, a successful recent test and the user's final authorization for the exact sessions.

These controls reduce accidental or duplicate submissions; they do not guarantee court availability, exact-time execution, provider uptime or zero-cost hosting reliability. Keep the service in rehearsal until the live integration and chosen host have been validated.
