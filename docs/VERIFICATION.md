# Verification record

Checked on 20 November 2026 in the Windows development workspace using Node.js 24.13.1. This record distinguishes application checks from validation against the real booking service.

## Completed checks

| Command | Observed result |
| --- | --- |
| `npm test` | **28 passed, 0 failed, 0 skipped** |
| `npm run check` | **25 JavaScript files passed syntax checking** |
| Browser tests | **15 passed across the provider, login and UI suites**, all rerun for one-hour scheduling |
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

### Direct scheduling from the facilities page

The review dialog, manual test button and consent checkbox have been removed. A single booking card shows one hour, free price and automatic court policy next to Schedule booking (Schedule rehearsal in rehearsal mode). The labelled click authorizes that displayed selection. The client freezes selection controls, saves the plan, runs the existing server checks and submits explicit authorization only after a successful check. Server validation, isolated sessions, live-mode restrictions and submission fencing are unchanged.

Failures appear inline. A request identifier is retained for the current selection and account so a retry after a lost response can recover the existing accepted plan without another arming request. A schedule is accepted only when the server confirms it. Six UI browser tests pass, covering desktop/mobile one-click scheduling, repeat clicks, failed checks, lost acceptance recovery, disabled live mode, static Pages behavior and existing login flows. Syntax checking passed for all 25 JavaScript files. No real booking was submitted; live booking remains disabled.

### One hour per schedule

Every new plan must explicitly declare durationHours: 1. The interface shows one 60-minute session, the provider prepares one isolated booking page, and the worker grants and submits only that selected hour. Any of the three courts may be used. The previous pair-selection path has been removed. Two hours require two independent schedules; there is no promise that they use the same court.

Overlap detection permits adjacent hours and rejects duplicate hours. The submission ledger and provider reject attempts for a second hour. Older records without a duration remain two-hour history; they are not silently shortened and cannot be armed or executed by the new worker. Cached older clients must refresh before creating a plan.

Regression checks cover one-hour validation, 30 isolated accounts, adjacent schedules under one account, duplicate rejection, out-of-scope submission refusal, uncertain outcomes, historical records and blocked legacy execution. The UI fixture creates one schedule, confirms exactly one result, then separately creates the next hour and verifies two independent schedules. No real reservation is submitted during these checks.

### Simplified booking sign-in

The default connection view is now a normal email/password form. Credentials go only through the authenticated, CSRF-protected private service into the official login form in that user's isolated browser. The fixed official origin and login path are checked before filling and submitting. Password fields are cleared, raw browser errors are sanitized, and no password is persisted. Five credential attempts per scheduler account are allowed in a 15-minute window. A successful sign-in calls the existing identity verification and encrypted-session save automatically. Official-screen sign-in remains available for university SSO and extra verification; it also detects the signed-in booking page and attempts session saving automatically.

Synthetic browser tests cover success, rejection, password clearing, wrong-origin refusal, owner checks, automatic saving, and the compact form on desktop and mobile. Real credential submission through the new form still needs the account owner's verification. The host remains in connection-only mode with automatic booking disabled.

### Account onboarding follow-up

The owner created a scheduler account and completed a two-hour synthetic rehearsal through public HTTPS. No official reservation was made. The official profile UI exposes a disabled Person id input (`data-test-id="id-field"`). The new opt-in `PROVIDER_IDENTITY_SOURCE=profile-person-id` reads this visible field from a separate profile page in the same isolated context, hashes it, and rechecks it before submission. A local browser fixture verifies changed identities are rejected even when the display name matches, with no final booking clicks. Rehearsal/live overlap checks are now separated. The suites passed 21 unit/integration checks and 8 browser checks.

The personal host has moved to connection-only setup (`BOOKING_MODE=live`, `LIVE_BOOKING_ENABLED=false`) so the owner can authenticate in the isolated browser. Actual saved-session validation remains pending. Remote typing controls now appear above the website image and stay visible while scrolling. Automatic booking remains disabled.

### Windows personal host check — 20 November 2026

The personal Windows host passed all 20 unit/integration checks, all 7 browser checks and syntax validation of 23 JavaScript files. Its limited per-user startup task was registered and observed running. The actual task opened a sandboxed Edge browser and verified two isolated contexts using entirely synthetic intercepted pages. A graceful stop/start was observed in the host log and followed by a healthy local `/healthz` response with the scheduler running in rehearsal. This verifies the current logged-in session; an actual reboot has not been tested.

After owner approval, Tailscale Funnel was activated in background mode, proxying only to `127.0.0.1:4318`. The HTTPS health/config endpoints returned 200, unauthenticated account access returned 401, private environment/database paths returned 404, and a cross-origin login request returned 403 with production security headers. Chrome loaded the rehearsal interface and invitation registration form over HTTPS. These checks were made from the host using the hostname's public IP addresses; physical smartphones and corporate networks still need their own connectivity checks. See [personal server operation](PERSONAL-SERVER.md).

The default configuration remains **rehearsal**, with live booking disabled. Production requires HTTPS configuration and a private encryption key. Live arming additionally checks explicit activation, an owned connected account, a configured stable identity, a successful recent test and the user's final authorization for the exact sessions.

These controls reduce accidental or duplicate submissions; they do not guarantee court availability, exact-time execution, provider uptime or zero-cost hosting reliability. Keep the service in rehearsal until the live integration and chosen host have been validated.
