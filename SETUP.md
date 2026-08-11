# Setup

## Install

Requirements: Node.js 22.13 or newer and pnpm 10.28.1.

```sh
pnpm install
```

## Authentication

Email and password authentication is the safe default. Copy `.env.example` to
`.env`, keep `AUTH_MODE=credentials`, set `BETTER_AUTH_URL` to the externally
reachable URL, and generate a strong `BETTER_AUTH_SECRET`:

```sh
openssl rand -base64 32
```

For a trusted, single-user local workstation, no-auth mode remains available
with a forced loopback binding:

```sh
pnpm solo
```

The command applies database migrations, prepares the generated client, prints
the local URL and data file, and starts without a sign-in step. It always binds
Next.js to `127.0.0.1`; hostname overrides are rejected. Open
`http://127.0.0.1:3000` on the same computer and stop with Ctrl+C.

For an already-built production app, use `pnpm start:local-solo`.
`pnpm dev:local-solo` remains an alias for `pnpm solo`. The application refuses
no-auth mode outside isolated tests when `APP_BIND_HOST` is missing, wildcard,
LAN-facing, malformed, or otherwise non-loopback. Do not place solo mode behind
a reverse proxy or expose it through port forwarding.

In credential mode, create the first account at `/sign-up`. Set
`BETTER_AUTH_DISABLE_SIGN_UP=true` and restart the application if additional
accounts must not be registered. Existing users can continue to sign in. Local
solo mode opens the application directly with its fixed `local` owner and has no
account-creation step.

### Company users and roles

In credential mode, the first account is the permanent administrator of its
own company workspace. Open **Users** (`/access`) to grant an already registered
user one of these tenant-scoped roles:

- **Administrator** can work in the books and manage company access.
- **Accountant** can read and change operational accounting data but cannot
  grant roles.
- **Read only** can inspect company data but receives HTTP 403 for protected
  accounting mutations.

Every grant, role change, and revocation requires a reason and is retained in
the company's integrity-chained audit trail. A member uses `/access` to switch
between their own workspace and explicitly assigned companies; a forged tenant
cookie falls back to the user's own isolated workspace. Sign-up is registration,
not access to another company: an administrator must still grant membership.

`pnpm solo` deliberately does not show user management. Its fixed `local`
principal is an implicit administrator, performs no session or membership
lookup, and remains the simplest supported single-user deployment.

Authenticated deployments remain the default: use `pnpm dev` while developing,
or `pnpm build` followed by `pnpm start`, with `AUTH_MODE=credentials`, a strong
`BETTER_AUTH_SECRET`, and the externally reachable `BETTER_AUTH_URL`.

## Database and safe migrations

SQLite is used by default and the company database remains at
`accounting.db` in the workspace for compatibility with existing installations.
The normal startup command is still:

```sh
pnpm run solo
```

`pnpm run solo` explicitly selects that company file, prints its resolved path,
creates and verifies a pre-migration snapshot, applies migrations, and then
starts the loopback-only local-solo server. Snapshots are stored outside the
repository in `%LOCALAPPDATA%\Sanjo Accounting\backups` on Windows (or
`$XDG_DATA_HOME/Sanjo Accounting/backups`, with an OS app-data fallback) and
the newest 14 snapshots are retained. Set `COMPANY_BACKUP_DIR` only when an
operator has deliberately selected another durable location. A first start with
no existing database has no file to snapshot; the migration creates it.

To restore safely, stop the application, copy a verified `accounting-*.db`
snapshot back to a separately named staging file, inspect it, and only after
confirming the timestamp and `.json` manifest replace the live `accounting.db`
using the operating system's recoverable file operation. Keep the original live
file until the restored application has been checked. Never restore a snapshot
while the application is running.

`pnpm db:migrate`, `pnpm db:deploy`, `pnpm db:push`, and `pnpm dev` are guarded:
they refuse the protected company file unless `ALLOW_PROTECTED_DATABASE=true`
is explicitly supplied; the guard creates a verified backup before the Prisma
command. E2E commands always set both `E2E_DATABASE_FILE` and `DATABASE_URL`,
and reject `accounting.db`, its SQLite sidecars, missing targets, and paths
outside the workspace root. Unit tests receive a private temporary URL and
cannot open the company file.

Override `DATABASE_URL` for another location when running an authenticated or
disposable environment. Persistence is accessed through repository interfaces
under `src/server/persistence`, so another Prisma-supported SQL database can be
added without changing application services. Because a Prisma schema targets
one SQL dialect, changing database engines also requires the corresponding
Prisma datasource provider, driver adapter, and migrations.

## Document storage

Uploaded PDF documents are stored through [Apache OpenDAL](https://opendal.apache.org/).
The application uses the local `./storage` directory by default. Files are private and
are served through the application instead of exposing provider URLs or credentials.

Copy `.env.example` to `.env.local` and set `DOCUMENT_STORAGE_DRIVER` to select a
backend:

- `fs` for the local filesystem
- `s3` for Amazon S3 and S3-compatible services
- `gcs` for Google Cloud Storage
- `azblob` for Azure Blob Storage

The corresponding bucket or container and credentials are documented in
`.env.example`. `DOCUMENT_STORAGE_OPTIONS` accepts additional OpenDAL options as a
JSON object and can also override the named settings. Keep all storage configuration
server-side; none of these variables may use Next.js's `NEXT_PUBLIC_` prefix.

Cloud deployments must include the platform-specific optional dependency installed
with `opendal`. The package is listed in `serverExternalPackages` so Next.js does not
bundle its native binary.

Compliance backups are encrypted before they are written through the same OpenDAL
object-storage interface, while the operational database stores only the payload
locator and authenticated manifest metadata. Configure `AUDIT_INTEGRITY_KEYS`,
`AUDIT_INTEGRITY_KEY_ID`, and `COMPLIANCE_BACKUP_KEYS_BASE64` as server-side secrets.
Each audit event records its key ID; retain historical audit keys for the life of the
audit log. A single audit key can instead use `AUDIT_INTEGRITY_SECRET`. The backup keyring is keyed by
the policy's key ID; keep historical keys available until every backup encrypted with
them has expired. A single-key deployment can use the paired
`COMPLIANCE_BACKUP_KEY_ID` and `COMPLIANCE_BACKUP_KEY_BASE64` variables instead.
`DOCUMENT_STORAGE_REGION` is the deployment-authoritative region used for the storage
backend; backup requests and the compliance allowlist must match it exactly. For S3,
this is also the provider region passed to OpenDAL.

## Reminder email delivery

Set `REMINDER_EMAIL_GATEWAY_URL` and `REMINDER_EMAIL_GATEWAY_CREDENTIAL` to enable
operator-approved delivery of an already-issued receivables reminder. The URL must
use HTTPS; plain HTTP is accepted only for a loopback development gateway. The
gateway receives a versioned JSON message with exactly one reviewed recipient,
fixed text/HTML content, the immutable reminder as a hash-bound HTML attachment,
and an `Idempotency-Key` header. It must honor that key across retries and return
`{"messageId":"provider-id"}` with a successful HTTP response.

The application never selects or sends to a customer address automatically. An
operator must type the exact recipient, provide a reason, and explicitly approve
each attempt. Attempts and provider results are append-only. Failed results remain
visible and require a new approval to retry; none of these operations allocate or
otherwise change an open item.

## Start

```sh
pnpm start
```

## Optional manual ERiC validation evidence

The proprietary ERiC runtime is not downloaded by this repository. Authorized
operators can use the manual `ERiC Bilanz validation contract` GitHub workflow
on an approved self-hosted Windows runner. See
`documentation/tax-operations-runbook.md` for the required Bilanz_6.9 plugin,
test-only inputs, expected-outcome contract, redaction rules and evidence limits.
The workflow never supplies a certificate or PIN and never submits data.
