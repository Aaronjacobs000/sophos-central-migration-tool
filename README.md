# Sophos Central Migration Tool

A locally-run web tool for migrating configuration and devices between two Sophos Central tenants.

Connects to a **source** and a **destination** tenant via the official Sophos Central
APIs, gives you a side-by-side view of policies, groups, exclusions and devices,
and lets you migrate selected items in a controlled, auditable way — including
the actual two-tenant device migration flow with live progress.

## Features

- **First-run welcome wizard** — guides you through entering Super Admin API
  credentials for both tenants and tests each connection before saving.
- **Live tenant dashboard** with status pills (caller type, tenant ID, data region).
- **Endpoint policies** — list, view, deep-diff, clone, or overwrite on the destination.
- **Endpoint groups** — mirror by name and metadata (membership recreates after device migration).
- **Exclusions, allow lists, block lists** — copy individual items or entire categories.
- **Source-side endpoint browser** with hostname filter, OS / health columns, and a 14-day staleness check.
- **Two-tenant device migration** via the official `/endpoint/v1/migrations` API:
  destination receives, source sends, server polls both sides, browser sees live updates over Server-Sent Events.
- **Dry-run mode** on every migration action — see exactly what would happen without touching the destination.
- **Audit log** at `data/audit.log` capturing every mutation with timestamp, request ID, side, resource, and result.
- **Credentials management page** for editing or rotating credentials at any time, with live tenant reconnection.
- **Help page** explaining prerequisites, the 14-day window, the migration workflow, and security notes.

## Prerequisites

- Node.js 20 or newer (Node 24 is what this was developed against)
- Direct-tenant Sophos Central API credentials for **both** tenants:
  - Sign in to each tenant as a Super Admin
  - Sophos Central → **Global Settings → API Credentials → Add Credential**
  - Pick a Super Admin role, then copy the Client ID and Client Secret
  - Partner and organization-scoped credentials are not supported
- On the **destination** tenant, ensure **Device Migration** is enabled in
  *Global Settings → Device Migration* before running a migration.

## Setup

```bash
npm install
npm start
```

`npm start` runs `tsc` then launches the server. Open
http://127.0.0.1:3100 in your browser. On first launch you'll be redirected
to the welcome wizard.

To use a different port:

```bash
PORT=3199 npm start
```

## Project layout

```
backend/
  src/
    server.ts                  # Express bootstrap
    state.ts                   # AppState singleton + rebuildContexts
    log.ts                     # Console wrapper with secret masking
    config/
      env-file.ts              # Atomic .env read/write
      validate.ts              # Field validation + masking helpers
    sophos/
      constants.ts             # Sophos auth + global API URLs
      tenant-context.ts        # Dual-client factory
      auth/token-manager.ts    # VENDORED from sophos-central-mcp
      client/
        sophos-client.ts       # VENDORED
        tenant-resolver.ts     # VENDORED
      types/
        sophos.ts              # VENDORED
        migration.ts           # Local types for policies/groups/migrations/etc.
      api/
        policies.ts            # Async wrappers around /endpoint/v1/policies
        groups.ts              # /endpoint/v1/endpoint-groups
        exclusions.ts          # /endpoint/v1/settings/(exclusions|allowed-items|blocked-items)
        endpoints.ts           # /endpoint/v1/endpoints (list/get only)
        migrations.ts          # /endpoint/v1/migrations
        software.ts            # /endpoint/v1/software/packages
    routes/
      status.ts                # /api/status
      credentials.ts           # /api/credentials, /api/credentials/test
      policies.ts              # /api/:side/policies
      groups.ts                # /api/:side/groups
      exclusions.ts            # /api/:side/exclusions/...
      endpoints.ts             # /api/:side/endpoints
      compare.ts               # /api/compare/...
      migrate-config.ts        # /api/migrate/(policies|groups|exclusions)
      migrate-devices.ts       # /api/migrate/devices/...  + SSE stream
    services/
      policy-migrator.ts
      group-mirror.ts
      exclusion-copier.ts
      device-migrator.ts       # Two-tenant orchestration
      migration-store.ts       # data/migration-jobs.json
      audit-log.ts             # data/audit.log
    compare/
      json-diff.ts             # Tiny structural deep-diff
    middleware/
      require-configured.ts    # 409 → wizard redirect
      side-param.ts            # validates :side ∈ {source,dest}
      error-handler.ts

frontend/
  *.html                       # 13 vanilla HTML pages
  js/                          # ES modules, no build step
  css/base.css, components.css
  sophos-logo-white.svg

data/                          # gitignored runtime state
  migration-jobs.json
  audit.log

.env                           # gitignored credentials, managed by the UI
.env.example                   # committed template
```

The frontend is plain HTML + ES modules served statically — there is **no**
build step for the UI. Edit a `.html` or `.js` file in `frontend/`, refresh
the browser. Backend changes need `npm run build` or `npm start`.

## Security notes

- The server binds to **127.0.0.1 only** and is unreachable from the network.
- Sophos credentials are stored in plain `.env` at the repo root. Run only on
  a trusted workstation with full-disk encryption (BitLocker). Do not commit,
  back up, or sync `.env` to cloud drives. `.gitignore` excludes it.
- Secrets are never returned by the API. The credentials page shows masked
  values until you click Reveal.
- Every migration action supports a `dryRun=true` query param or body field
  that returns the planned API calls without touching the destination.
- Every mutation against either tenant is recorded to `data/audit.log` with a
  timestamp, request ID, side, resource ID, and result.
- Destructive actions (delete, overwrite, cancel migration) require explicit
  confirmation in the UI.

## License

MIT. See [LICENSE](LICENSE) and [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the
sophos-central-mcp upstream credit.
