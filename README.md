# Accounting

This work is devoted to God.

## Development

Requirements: Node.js 22.13 or newer and pnpm 10.28.1.

```sh
pnpm install
pnpm db:migrate
pnpm dev
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

SQLite is used by default and stores its data in `accounting.db`. Override
`DATABASE_URL` for another location. Persistence is accessed through repository
interfaces under `src/server/persistence`, so another Prisma-supported SQL
database can be added without changing the application services. Because a
Prisma schema targets one SQL dialect, changing database engines also requires
the corresponding Prisma datasource provider, driver adapter, and migrations.

The repository root is one full-stack Next.js application. The App Router UI,
API route handlers, domain model, and server-only persistence services all live
under `src`.

- `pnpm dev` starts the development server.
- `pnpm build` creates the production build.
- `pnpm start` starts the production server.
- `pnpm db:migrate` creates and applies development database migrations.
- `pnpm db:deploy` applies existing migrations in production.
- `pnpm test` runs the Vitest suite.
