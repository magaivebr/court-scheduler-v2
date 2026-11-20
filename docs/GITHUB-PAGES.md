# GitHub Pages

Use a public `court-scheduler-v2` repository for GitHub Free Pages. Upload only reviewed source; never `.env`, `.data`, invitations, logs or provider sessions.

1. Push source including `.github/workflows/pages.yml` and `package-lock.json`.
2. Repository Settings → Pages → Source: **GitHub Actions**.
3. When the private backend has working HTTPS, set Actions repository variable `PUBLIC_BACKEND_URL` to its origin. This setting is public, not a secret.
4. Run **Publish Court Scheduler** or push to `main`.

The workflow checks/tests source and publishes only `dist/`. Until a backend URL is configured, the public page shows service-not-connected rather than pretending schedules are armed. Account login opens the private service's own origin to avoid third-party-cookie issues on smartphones.

GitHub Actions builds and deploys the interface; it does not run release-time bookings.
