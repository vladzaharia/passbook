# UI Cohesiveness Audit

**Scope:** Read-only review of shared UI controls, styles, helpers, copy, SSR/email generation, and selected admin/portal consumers. No assigned-surface working-tree diff was present; findings describe baseline behavior, not patch introduction.

No P0/P1 issue was established in this slice. All acceptance scenarios below are proposed, not executed.

## Findings

### 1. Preserve loaded passes when pagination fails
**P2 · confirmed-source**

`src/web/portal/my-passes-page.tsx:170,187-188` replaces the entire list on any query error, even when cached pages exist. A failed **Load more** therefore hides already-loaded passes and bypasses the shared footer’s retry handling (`src/web/ui/pagination.tsx:58-76`). Admin connections retain existing rows (`src/web/admin/connections/list-page.tsx:159`).

**Fix:** Reserve the full-page error for absent data; retain cards and show pagination/refetch feedback separately.

**Acceptance:** Load one page, fail the next request, and confirm existing cards remain with **Try again** in the footer.

### 2. Show clipboard failures visually
**P2 · confirmed-source**

`src/web/ui/copy-button.tsx:23-25,33-43` reports failure only inside `sr-only` content; its visible icon and label remain unchanged. This affects one-time secrets through `src/web/ui/secret-reveal.tsx:66`. The equivalent menu action already provides an actionable error toast (`src/web/lib/clipboard.ts:11-13`).

**Fix:** Give `CopyButton` equivalent visible failure feedback while retaining its live announcement.

**Acceptance:** Deny clipboard access and confirm both sighted and screen-reader users receive a failure message, with no success indication.

### 3. Distinguish failed searches from empty results
**P2 · confirmed-source**

`src/web/ui/entity-picker.tsx:47-82` discards query errors and turns missing data into empty options. Organization, template and connection queries also omit loading state. Consequently, `src/web/ui/combobox.tsx:98-101` presents **No results** during initial loading or after request failure.

**Fix:** Propagate the selected query’s loading/error states and provide retry feedback distinct from genuine empty results.

**Acceptance:** Delay, then fail an organization lookup used by the message composer; show searching followed by an actionable error—not **No results**.

### 4. Protect connection-binding edits on dismissal
**P2 · confirmed-source**

The binding dialog omits `dirty` (`src/web/admin/passes/detail/connection-tab.tsx:69`), unlike the shared dialog contract. Escape, the close button or an outside click closes it without confirmation; reopening changes its key and resets the entered record ID (`:217-219,242`).

**Fix:** Pass a dirty comparison against the initial connection/ref/takeover values. Preserve the established explicit-Cancel discard behavior.

**Acceptance:** Enter a record ID, press Escape, choose **Keep editing**, and confirm the value remains.

### 5. Clear confirmation errors between operations
**P2 · confirmed-source**

`src/web/ui/alert-dialog.tsx:46-57` clears its error only when another confirmation starts. The persistent API-key dialog changes targets without remounting (`src/web/admin/api-keys/api-keys-page.tsx:111-114`), so failing to revoke key A, cancelling, then opening key B displays A’s error before B has been attempted.

**Fix:** Reset transient errors when the dialog closes or starts a new operation, matching `TypedConfirmDialog` (`src/web/ui/typed-confirm-dialog.tsx:51-56`).

**Acceptance:** Fail A, cancel, open B, and confirm B starts without stale feedback.

### 6. Make “Today” match calendar-day semantics
**P2 · confirmed-source**

**Today** invokes a rolling 24-hour subtraction (`src/web/ui/filter-bar.tsx:24,31-33`; `src/web/admin/audit/date-filter.tsx:18,65`). At an afternoon audit review, this includes yesterday afternoon. The adjacent manual **From** control instead uses local midnight (`src/web/admin/audit/audit-search.ts:64-68`).

**Fix:** Use local calendar-day start for Today, or explicitly label the rolling window **Last 24 hours**.

**Acceptance:** Freeze time mid-afternoon; Today must exclude yesterday’s records and agree with manually selecting today.

### 7. Validate the committed connector, not stale React state
**P2 · confirmed-source**

`OptionTile` selects and commits within one keyboard event (`src/web/ui/option-tile.tsx:60-64`). The connector consumer sets the type, then calls `next()` (`src/web/admin/connections/wizard-steps.tsx:96-98`), which still reads the previous `type` (`src/web/admin/connections/create-wizard.tsx:169-172`). On an initially unselected tile, the first Enter selects but fails to advance.

**Fix:** Pass the committed connector into transition validation rather than relying on the pending state update.

**Acceptance:** With an organization selected, Tab to the first unselected connector and press Enter once; Configuration should open.

## Product recommendations—not established implementation bugs

- **P3 · confirmed-source — Formalize holder status exceptions.** Voided/Removed are neutral in the shared map and portal tiles (`src/web/lib/status.ts:66-69`; `src/web/portal/my-passes-page.tsx:112`) but warning-toned in detail/public-bundle views (`src/web/portal/pass-header.tsx:27-29`; `src/worker/ssr/bundle-page.tsx:62-70`). Bundle summaries also call every inactive member “voided” (`:29-30,76-77,113`). **Counter-control:** Removed members deliberately normalize to voided in the bundle API, with explicit coverage (`src/worker/modules/bundles/repo.ts:107-109`; `bundles.test.ts:283-301`). Document that policy or preserve distinct holder wording; compare mixed active/voided/removed bundles across list, detail and email.

- **P3 · confirmed-source — Name individual email actions.** Every bundle-email item link reads only **Add**, without a pass-specific accessible name (`src/worker/email/bundle.ts:44-48`). The plain-text part includes titles, and public-page badges reference their titles (`src/worker/ssr/bundle-page.tsx:128-138`). Prefer visible **Add {pass title}** wording; inspect a two-pass email’s link list for distinguishable destinations.

## Strengths and limitations

Shared token/control/holder generation substantially reduces independent visual implementations. Shared state copy, semantic status maps, sanitized error messages, blocked-submit focus, opener restoration and dirty-dialog handling provide useful counter-controls. Source parity tests exist; none were run.

No edits, builds, tests, lint, formatters, production calls or runtime checks were performed. Browser/VoiceOver behavior, 195-CSS-pixel reflow, short-screen menus, and email-client dark-mode rendering remain unverified. In particular, shared buttons still impose `whitespace-nowrap` (`src/web/ui/button.tsx:25`), warranting narrow-screen checks with long dialog actions.
