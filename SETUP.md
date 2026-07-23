# Setup

## Install

Requirements: Node.js 22.13 or newer and pnpm 10.28.1.

```sh
pnpm install
```

## Authentication

Authentication is disabled by default for a single user running the application
locally. In this mode, leave `AUTH_MODE=none`. Do not expose a no-auth instance to
an untrusted network.

To require email and password authentication, copy `.env.example` to `.env`, set
`AUTH_MODE=credentials`, set `BETTER_AUTH_URL` to the externally reachable URL,
and generate a strong `BETTER_AUTH_SECRET`:

```sh
openssl rand -base64 32
```

After starting the application, create the first account at `/sign-up`. Set
`BETTER_AUTH_DISABLE_SIGN_UP=true` and restart the application if additional
accounts must not be registered. Existing users can continue to sign in.

## Database

SQLite is used by default and stores its data in `accounting.db`. Override
`DATABASE_URL` for another location. Persistence is accessed through repository
interfaces under `src/server/persistence`, so another Prisma-supported SQL
database can be added without changing the application services. Because a
Prisma schema targets one SQL dialect, changing database engines also requires
the corresponding Prisma datasource provider, driver adapter, and migrations.

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

## Start

```sh
pnpm start
```
