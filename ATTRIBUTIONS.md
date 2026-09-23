# Third-party attributions

## sophos-mcp (formerly sophos-central-mcp)

Portions of `backend/src/sophos/` are vendored from the
[sophos-mcp](https://github.com/Aaronjacobs000/sophos-mcp) project (formerly sophos-central-mcp)
(MIT License).

### Files vendored

| Upstream path | Local path |
| --- | --- |
| `src/auth/token-manager.ts` | `backend/src/sophos/auth/token-manager.ts` |
| `src/client/sophos-client.ts` | `backend/src/sophos/client/sophos-client.ts` |
| `src/client/tenant-resolver.ts` | `backend/src/sophos/client/tenant-resolver.ts` |
| `src/types/sophos.ts` | `backend/src/sophos/types/sophos.ts` |

### Upstream commit

Vendored from the `main` branch. See each file's header comment for the
exact commit SHA at the time of the copy.

### Refreshing the vendored files

1. `git clone https://github.com/Aaronjacobs000/sophos-mcp /tmp/mcp`
2. Copy the four files above from `/tmp/mcp/src/...` to their local paths.
3. Re-apply the constants tweak: replace imports of `SOPHOS_AUTH_URL` and
   `SOPHOS_GLOBAL_API` from `../config/config.js` with
   `../constants.js`.
4. Update the attribution header comment in each vendored file with the
   new upstream commit SHA.
5. Run `npm run build` and fix any type mismatches.

### Local modifications

- Import paths for constants redirected to `backend/src/sophos/constants.ts`.
- Attribution header block added to each file.
- **`tenant-resolver.ts`** is a fork: removed all partner / organization
  credential handling (loadTenants, getCachedTenants, getIdHeader). The
  resolver now only accepts tenant-scoped credentials and pulls the
  regional API host straight from `/whoami/v1`.
- **`sophos-client.ts`**: `globalRequest()` skips the caller's identity
  header when the request sets its own `X-Tenant-ID` or `X-Distributor-ID`,
  ported from upstream commit 89a43af. The Licensing API needs it.
- **`sophos.ts` (types)** is a fork: removed `SophosTenant`,
  `SophosTenantPage`, and `SophosIdType` (unused after the resolver fork).
