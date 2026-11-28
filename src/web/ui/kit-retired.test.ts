import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Retired modules: one row per module. A non-test file that imports a retired path fails, unless it
 * is in the row's `pending` set, which only shrinks: when an importer moves, delete it here (this
 * test fails on a stale entry). A package that retires something appends its row in the same PR.
 */
interface Retired {
  /** The module's path from src/web, as an import specifier ends. */
  path: string;
  /** The names it exports; importing one from the ui barrel counts as importing the module. */
  symbols: readonly string[];
  replacement: string;
  /** src/web-relative importers still to move. */
  pending: readonly string[];
}

const RETIRED: readonly Retired[] = [
  {
    path: 'ui/empty-state',
    symbols: ['EmptyState'],
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: [
      'admin/api-keys/api-keys-page.tsx',
      'admin/api-keys/key-detail-page.tsx',
      'admin/audit/audit-table.tsx',
      'admin/blueprints/blueprint-page.tsx',
      'admin/blueprints/blueprints-page.tsx',
      'admin/connections/connector-picker.tsx',
      'admin/connections/health-panel.tsx',
      'admin/connections/list-page.tsx',
      'admin/connections/live-only.tsx',
      'admin/connections/webhook-failures.tsx',
      'admin/connections/webhooks/detail-page.tsx',
      'admin/connections/webhooks/outbound-resume.tsx',
      'admin/connections/webhooks/webhooks-tab.tsx',
      'admin/idp/claims/claims-card.tsx',
      'admin/mapping/mapping-editor.tsx',
      'admin/messages/messages-page.tsx',
      'admin/messages/rules-section.tsx',
      'admin/orgs/developers/developers-section.tsx',
      'admin/orgs/org-access.tsx',
      'admin/orgs/orgs-page.tsx',
      'admin/overview/org-overview.tsx',
      'admin/overview/recent-activity.tsx',
      'admin/overview/sandbox-card.tsx',
      'admin/passes/bundles-card.tsx',
      'admin/passes/change/change-page.tsx',
      'admin/passes/detail/connection-tab.tsx',
      'admin/passes/detail/delivery-tab.tsx',
      'admin/passes/detail/devices-tab.tsx',
      'admin/passes/detail/images-tab.tsx',
      'admin/passes/detail/info-tabs.tsx',
      'admin/passes/detail/print-card.tsx',
      'admin/passes/detail/sync-tab.tsx',
      'admin/passes/detail/tags-card.tsx',
      'admin/passes/import/detail-page.tsx',
      'admin/passes/import/import-page.tsx',
      'admin/passes/import/recent.tsx',
      'admin/passes/list-page.tsx',
      'admin/passes/new-pass-preview.tsx',
      'admin/passes/new-pass-steps.tsx',
      'admin/passes/photos/photos-page.tsx',
      'admin/platform/groups/group-detail-page.tsx',
      'admin/platform/groups/group-members-card.tsx',
      'admin/platform/groups/group-rules-card.tsx',
      'admin/platform/groups/groups-page.tsx',
      'admin/retention/holds-card.tsx',
      'admin/retention/receipts-card.tsx',
      'admin/scanning/events-tab.tsx',
      'admin/scanning/scanners/scanners-tab.tsx',
      'admin/scanning/scans-tab.tsx',
      'admin/scanning/sessions/session-detail.tsx',
      'admin/scanning/setup/setup-wizard.tsx',
      'admin/scanning/staff-tab.tsx',
      'admin/scanning/tags/keysets/keysets-view.tsx',
      'admin/scanning/zones/inside-sheet.tsx',
      'admin/scanning/zones/zones-tab.tsx',
      'admin/settings/idp/idp-calls-card.tsx',
      'admin/settings/idp/idp-drift-card.tsx',
      'admin/status/incidents.tsx',
      'admin/status/status-page.tsx',
      'admin/status/workflow-runs.tsx',
      'admin/tags/assign-manual.tsx',
      'admin/tags/scanner-picker.tsx',
      'admin/tags/tags-tab.tsx',
      'admin/tags/user-tags-card.tsx',
      'admin/templates/designer/admin/designer-page.tsx',
      'admin/templates/designer/paper-preview.tsx',
      'admin/templates/join/join-sign.tsx',
      'admin/templates/list-page.tsx',
      'admin/templates/releases/wallet-review-dialog.tsx',
      'admin/templates/template-stage.tsx',
      'admin/templates/upload-page.tsx',
      'admin/test-inbox/inbox-page.tsx',
      'admin/users/access/groups-card.tsx',
      'admin/users/invite/platform-invite.tsx',
      'admin/users/user-passes-card.tsx',
      'admin/users/user-sections.tsx',
      'admin/users/users-page.tsx',
      'admin/wallet-accounts/apple/apple-api-tab.tsx',
      'admin/wallet-accounts/apple/identities-page.tsx',
      'admin/wallet-accounts/apple/identity-history.tsx',
      'admin/wallet-accounts/apple/platform-moves.tsx',
      'admin/wallet-accounts/apple/platform-section.tsx',
      'admin/wallet-accounts/enrolment-table.tsx',
      'admin/wallet-accounts/migration-section.tsx',
      'admin/wallet-accounts/release-apply.tsx',
      'admin/wallet-accounts/release-mode.tsx',
      'channel-previews/channel-previews.tsx',
      'channel-previews/wallet-channel.tsx',
      'portal/my-passes-page.tsx',
      'scan/inside/inside-panel.tsx',
      'scan/roll-call/roll-call-panel.tsx',
      'ui/detail-error.tsx',
      'ui/index.ts',
      'ui/layout/org-chooser.tsx',
      'ui/webhooks/delivery-list.tsx',
      'workbench/design/blueprint-picker.tsx',
      'workbench/design/design-loaded.tsx',
      'workbench/design/design-page.tsx',
      'workbench/keys/keys-list.tsx',
      'workbench/states/states.tsx',
      'workbench/tools/placeholder.tsx',
    ],
  },
  {
    path: 'ui/error-state',
    symbols: ['ErrorState'],
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: [
      'admin/api-keys/api-keys-page.tsx',
      'admin/api-keys/key-detail-cards.tsx',
      'admin/api-keys/key-detail-page.tsx',
      'admin/audit/audit-table.tsx',
      'admin/blueprints/blueprint-page.tsx',
      'admin/blueprints/blueprints-page.tsx',
      'admin/brand/brand-color-sheet.tsx',
      'admin/brand/brand-image-sheet.tsx',
      'admin/brand/review-dialog.tsx',
      'admin/channels/settings-channels.tsx',
      'admin/connections/create-wizard.tsx',
      'admin/connections/files/file-tab.tsx',
      'admin/connections/list-page.tsx',
      'admin/connections/webhook-failures.tsx',
      'admin/connections/webhooks/webhooks-tab.tsx',
      'admin/connections/wizard-body.tsx',
      'admin/idp/claims/claims-card.tsx',
      'admin/messages/composer-page.tsx',
      'admin/messages/detail-page.tsx',
      'admin/messages/detail-passes.tsx',
      'admin/messages/messages-page.tsx',
      'admin/orgs/features/apple-card.tsx',
      'admin/orgs/features/channels-card.tsx',
      'admin/orgs/features/features-tab.tsx',
      'admin/orgs/features/preset-editor.tsx',
      'admin/orgs/org-access.tsx',
      'admin/orgs/orgs-page.tsx',
      'admin/overview/developer-funnel.tsx',
      'admin/overview/health.tsx',
      'admin/overview/org-overview.tsx',
      'admin/overview/overview-page.tsx',
      'admin/overview/recent-activity.tsx',
      'admin/passes/bundles-card.tsx',
      'admin/passes/change/change-page.tsx',
      'admin/passes/change/run-page.tsx',
      'admin/passes/detail/channels-card.tsx',
      'admin/passes/detail/check-in-card.tsx',
      'admin/passes/detail/connection-tab.tsx',
      'admin/passes/detail/delivery-tab.tsx',
      'admin/passes/detail/devices-tab.tsx',
      'admin/passes/detail/images-tab.tsx',
      'admin/passes/detail/info-tabs.tsx',
      'admin/passes/detail/member-photo-card.tsx',
      'admin/passes/detail/pass-tabs.tsx',
      'admin/passes/detail/print-card.tsx',
      'admin/passes/detail/sync-tab.tsx',
      'admin/passes/detail/tags-card.tsx',
      'admin/passes/detail/versions-tab.tsx',
      'admin/passes/detail/wallet-provider-status.tsx',
      'admin/passes/import/detail-page.tsx',
      'admin/passes/import/match-step.tsx',
      'admin/passes/import/recent.tsx',
      'admin/passes/list-page.tsx',
      'admin/passes/new-pass-preview.tsx',
      'admin/passes/new-pass-step-bodies.tsx',
      'admin/passes/new-pass-steps.tsx',
      'admin/plan/plan-page.tsx',
      'admin/platform/groups/group-members-card.tsx',
      'admin/platform/groups/group-rules-card.tsx',
      'admin/platform/groups/groups-page.tsx',
      'admin/retention/holds-card.tsx',
      'admin/retention/receipts-card.tsx',
      'admin/retention/windows-card.tsx',
      'admin/scanning/eligible-template-picker.tsx',
      'admin/scanning/events-tab.tsx',
      'admin/scanning/scanners/scanners-tab.tsx',
      'admin/scanning/scanning-page.tsx',
      'admin/scanning/scans-tab.tsx',
      'admin/scanning/sessions/admits-picker.tsx',
      'admin/scanning/sessions/session-tonight.tsx',
      'admin/scanning/sessions/sessions-tab.tsx',
      'admin/scanning/setup/review-step.tsx',
      'admin/scanning/setup/setup-wizard.tsx',
      'admin/scanning/staff-tab.tsx',
      'admin/scanning/tags/keysets/keyset-sheet.tsx',
      'admin/scanning/tags/keysets/keysets-view.tsx',
      'admin/scanning/zones/inside-sheet.tsx',
      'admin/scanning/zones/zones-tab.tsx',
      'admin/settings/idp/idp-calls-card.tsx',
      'admin/settings/idp/idp-drift-card.tsx',
      'admin/settings/idp/setup-card.tsx',
      'admin/settings/org-settings-page.tsx',
      'admin/settings/settings-form.tsx',
      'admin/status/incidents.tsx',
      'admin/status/status-page.tsx',
      'admin/status/workflow-runs.tsx',
      'admin/tags/assign-manual.tsx',
      'admin/tags/assign-steps.tsx',
      'admin/tags/scanner-picker.tsx',
      'admin/tags/tag-history.tsx',
      'admin/tags/tag-sheet.tsx',
      'admin/tags/tags-tab.tsx',
      'admin/tags/user-tags-card.tsx',
      'admin/templates/channels/channels-panel.tsx',
      'admin/templates/designer/goal-change.tsx',
      'admin/templates/list-page.tsx',
      'admin/templates/releases/release-dialog.tsx',
      'admin/templates/releases/release-flow-dialog.tsx',
      'admin/templates/releases/rollout-card.tsx',
      'admin/templates/releases/template-releases-panel.tsx',
      'admin/templates/template-stage.tsx',
      'admin/templates/upload-form.tsx',
      'admin/templates/upload-page.tsx',
      'admin/templates/version-sheet.tsx',
      'admin/test-inbox/inbox-page.tsx',
      'admin/test-inbox/preview.tsx',
      'admin/users/user-passes-card.tsx',
      'admin/users/users-page.tsx',
      'admin/wallet-accounts/apple/apple-api-tab.tsx',
      'admin/wallet-accounts/apple/identities-page.tsx',
      'admin/wallet-accounts/apple/identity-history.tsx',
      'admin/wallet-accounts/apple/platform-moves.tsx',
      'admin/wallet-accounts/apple/platform-section.tsx',
      'admin/wallet-accounts/enrolment-table.tsx',
      'admin/wallet-accounts/migration-section.tsx',
      'admin/wallet-accounts/provider-tab.tsx',
      'admin/wallet-accounts/release-card.tsx',
      'admin/wallet-accounts/wallet-health.tsx',
      'portal/account-emails.tsx',
      'portal/account-sessions.tsx',
      'portal/my-passes-page.tsx',
      'routes/admin/all/route.tsx',
      'routes/admin/o/$orgId/route.tsx',
      'scan/ui/shift-sheet.tsx',
      'ui/detail-error.tsx',
      'ui/index.ts',
      'ui/layout/error-pages.tsx',
      'ui/layout/org-chooser.tsx',
      'ui/webhook-setup/listen-check.tsx',
      'ui/webhooks/delivery-inspector.tsx',
      'ui/webhooks/delivery-list.tsx',
      'workbench/design/anon/handoff-save.tsx',
      'workbench/keys/recent-calls.tsx',
      'workbench/states/states.tsx',
    ],
  },
  {
    path: 'ui/no-access-state',
    symbols: ['NoAccessState'],
    replacement: 'StateView (ui/state-view.tsx); the adapter goes in U-R1',
    pending: ['ui/index.ts', 'workbench/states/states.tsx'],
  },
];

const WEB = join(process.cwd(), 'src/web');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !name.includes('.test.') && !name.endsWith('.gen.ts')
      ? [path]
      : [];
  });
const files = walk(WEB).map((path) => ({
  path: relative(WEB, path),
  text: readFileSync(path, 'utf8'),
}));

/** The module names this file imports or re-exports, as written. */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');

/** Does `own` import one of `symbols` from the ui barrel (src/web/ui/index.ts)? */
const viaBarrel = (own: string, text: string, symbols: readonly string[]): boolean =>
  [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)].some((m) => {
    const spec = (m[2] ?? '').replace(/\.tsx?$/, '');
    const target = spec.startsWith('@/web/')
      ? spec.slice('@/web/'.length)
      : spec.startsWith('.')
        ? normalize(join(dirname(own), spec))
        : '';
    if (target !== 'ui/index' && target !== 'ui') return false;
    const names = (m[1] ?? '').split(',').map(
      (n) =>
        n
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0],
    );
    return names.some((n) => n !== undefined && symbols.includes(n));
  });

const importers = (path: string, symbols: readonly string[]): string[] =>
  files
    .filter(
      ({ path: own, text }) =>
        (own !== 'ui/index.ts' && viaBarrel(own, text, symbols)) ||
        specifiers(text).some(
          (s) =>
            /^[./@]/.test(s) &&
            s.replace(/\.tsx?$/, '').endsWith(`/${path.split('/').pop()}`) &&
            !own.endsWith(`${path}.tsx`),
        ),
    )
    .map((f) => f.path)
    .sort();

describe('retired modules', () => {
  for (const row of RETIRED) {
    it(`${row.path}: only the pending files import it; use ${row.replacement}`, () => {
      const found = importers(row.path, row.symbols);
      expect(
        found.filter((f) => !row.pending.includes(f)),
        `new importers of ${row.path}`,
      ).toEqual([]);
      expect(
        row.pending.filter((f) => !found.includes(f)),
        `moved: delete from pending`,
      ).toEqual([]);
    });
  }
});
