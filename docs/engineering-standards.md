# Engineering standards

Rules `npm run check` enforces, and where.

| Rule | Enforced by |
| --- | --- |
| Warnings are errors; no floating or misused promises; no import cycles | `biome ci --error-on-warnings` (`biome.json`) |
| Every `log.warn` / `log.error` carries a `code` or an `error` | `tools/check-log-codes.ts` |
| Source files stay under 330 lines; production code never imports `test-kit`, `test-support`, `test-oidc`, `test-utils`, `test-fixtures` or `testing` modules | `tools/check-sizes.ts` (allowlist entries name an owner and a reason) |
| No unused files, dependencies or binaries | `knip` (`knip.json`) |
| Initial web load stays under its gzip budget and carries no table, virtual or cmdk code | `tools/check-bundle.ts`, after `vite build` |
| List and search queries use an index | `test/query-plans.test.ts` |
| Web code uses the kit: toasts (`ui/toaster.tsx`), copying (`CopyButton`, `lib/clipboard.ts`), dates and numbers (`lib/format.ts`), emails (`strictEmail`), motion tokens, `Spinner` only in buttons | `src/web/ui/kit-lint.test.ts` |
| SSR tokens, controls, fonts and holder CSS equal the SPA's (`npm run gen` output is current) | `tools/ssr-parity.test.ts`, `tools/ssr-holder.test.ts` |
| `run_worker_first` negations match `public/` | `tools/wrangler-config.test.ts` |

## Code

- D1 errors are classified with `classifyD1Error` (`platform/db.ts`). Never match SQLite message text elsewhere.
- Errors are logged as the `error` value: the logger keeps `name`, `message`, `code`, two levels of `cause` and (error level) eight stack frames, all redacted. Do not pass `error.name`.
- Workflow code writes and reads the clock only inside `step.do` callbacks. `test/helpers/guarded-step.ts` fails a test that writes outside one.
- A cron hook that can run many queries must stay inside the daily budget (`jobs/query-counter.ts`); hooks that would start past 900 queries are skipped and logged as `cron.budget_skipped`.
- Routers cap bodies at 256 KB by default (`createRouter`). A module with larger uploads passes `{ bodyLimit: false }`, applies `defaultBodyLimit(uploadPath)` and its own cap.
- `routes.ts` and `*-handlers.ts` never import a repo; they call the module's service.
- Auth stores are built per request from `c.env`; the module-level app holds no request state.
- Barcode encoders come through `shared/pass-view/barcode-svg.ts`. Never import `bwip-js` elsewhere.
- One module owns each shared table: `platform/counters.ts` (`counters`), `platform/workflow-runs.ts` (`workflow_runs`), `orgs/repo.ts` (org state: `orgIsActive` to create, `orgIsReadable` to read).
- A mutation and its audit row go in one `db.batch` with `auditStmt` (`audit/repo.ts`); `recordAudit` is for audits that follow an external call.
- Router links use typed `to` and `params`. No `as never`.

## Indexes

`LIKE` is case-insensitive, so a prefix search needs a `COLLATE NOCASE` index. Search several columns with one indexed lookup each, merged by `id IN (... UNION ...)`, not an `OR` of `LIKE`s.
