# Development

Requirements: Node.js 22.13 or newer and pnpm 11.16.0.

```sh
pnpm install
pnpm dev
```

## Lighthouse QA

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:lighthouse
```

`test:lighthouse` migrates a new disposable SQLite database, builds the production
app, starts it on `http://127.0.0.1:3234`, and runs Lighthouse CI sequentially.
On Linux, install Chromium's system dependencies with
`pnpm exec playwright install --with-deps chromium`.
Use `LIGHTHOUSE_PORT` to choose a different unused port (PowerShell:
`$env:LIGHTHOUSE_PORT = '3235'`). Port 3000 is rejected, and an existing server is
never reused. Both build and server receive explicit disposable database and
document-storage paths inside a fresh `.playwright/lighthouse-*` directory.
Fixtures remain there for debugging; each run creates its own directory.

The audit covers the dashboard, bookings and settings in local solo
mode, using an empty synthetic company and the fixed fiscal year 2026. It uses
the Chromium version installed by the locked Playwright dependency, Lighthouse
CI pinned in `package.json`, and three desktop runs per URL. These checks cover
page loading and automated accessibility, not authenticated flows or populated
business workflows; Playwright covers those separately. SEO is excluded because
these are private application pages.

`lighthouserc.cjs` and `tools/lighthouse-config.cjs` define the enforced gates:

| Gate | Minimum | Aggregation |
| --- | --- | --- |
| Performance | 80 | Median of three runs |
| Accessibility | 90 | Worst run |
| Best practices | 95 | Worst run |
| Successful HTTP status and no browser console errors | 100 | Every run |

The performance threshold allows for shared CI runner variance. Accessibility
and best-practice checks are deterministic and use the worst run. Change these
budgets only with reviewed report evidence; do not suppress failures to make CI
green. Layout still requires visual review, as described in `AGENTS.md`.

The **Quality / lighthouse** job runs on pushes and pull requests. Any failed
gate fails the job. HTML and JSON reports are saved in `lighthouse-reports/`,
with raw results and assertion details in `.lighthouseci/`. Download the
`lighthouse-reports` Actions artifact to inspect failures; it is retained for
14 days even when assertions fail. Reports stay local or in the repository's
Actions artifacts; no Lighthouse server, public report upload, or token is used.

Configuration reference: [Lighthouse CI](https://googlechrome.github.io/lighthouse-ci/docs/configuration.html).
