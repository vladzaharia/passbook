import { useMemo } from 'react';
import { filterDoc, renderScanDisplay } from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc, ScanPanelDoc } from '@/passkit/template/scan-display/schema.ts';
import type { Json, ScanAction, ScanRole } from '@/passkit/types.ts';
import type { ScanDisplay, ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { type DesignDoc, isRecord, styleOf } from '../model.ts';
import {
  cutRows,
  displayForPreview,
  type PreviewFit,
  previewActions,
  previewFit,
  safeRealScope,
  scopeForOutcome,
  syntheticScope,
} from './scan-preview.ts';
import { hasUnsafeRenderedText, previewManifest, safePreviewText } from './scan-preview-policy.ts';
import type { PreviewTab } from './scan-stage-types.ts';

function tabsFor(actions: ScanAction[], event: boolean): PreviewTab[] {
  return [
    { id: 'ready', label: 'Card', screen: 'ready' },
    ...actions.map((action) => ({
      id: `action:${action.id}`,
      label:
        event && action.kind === 'check_in'
          ? 'Checked in'
          : safePreviewText(action.label)
            ? action.label
            : 'Action',
      screen: 'ok' as const,
      action,
    })),
    { id: 'heads_up', label: event ? 'Already checked in' : 'Heads-up', screen: 'heads_up' },
    { id: 'refused', label: 'Refused', screen: 'refused' },
  ];
}

export function useStagePreview({
  doc,
  display,
  screen,
  tabId,
  role,
  now,
  overrides,
  source,
  real,
}: {
  doc: DesignDoc;
  display: ScanDisplayDoc | null;
  screen: ScanDisplayScreen;
  tabId: string | null;
  role: ScanRole;
  now: number;
  overrides: Record<string, Json>;
  source: 'synthetic' | 'real';
  real: { scope: Record<string, Json> | null };
}) {
  const manifest = previewManifest(doc);
  const actions = previewActions(manifest);
  const event = styleOf(doc.passJson) === 'eventTicket';
  const tabs = tabsFor(actions, event);
  const tab =
    tabs.find((item) => item.id === tabId && item.screen === screen) ??
    tabs.find((item) => item.screen === screen) ??
    (tabs[0] as PreviewTab);
  const invalidDisplay =
    display === null && isRecord(doc.manifest.scan) && Object.hasOwn(doc.manifest.scan, 'display');
  const authored = useMemo(() => {
    if (invalidDisplay) return null;
    try {
      return displayForPreview(doc, display);
    } catch {
      return null;
    }
  }, [doc, display, invalidDisplay]);
  const synthetic = useMemo(() => {
    try {
      return syntheticScope(doc, role, now, overrides);
    } catch {
      return null;
    }
  }, [doc, role, now, overrides]);
  const usingReal = source === 'real' && real.scope !== null;
  const options = {
    screen: tab.screen,
    role,
    locale: 'en',
    timeZone: 'UTC',
    now,
    ...(tab.action ? { actionId: tab.action.id } : {}),
  };
  let rendered: ScanDisplay | null = null;
  let cuts = new Set<string>();
  let fit: PreviewFit | null = null;
  let hiddenPanels: ScanPanelDoc[] = [];
  try {
    const scope = usingReal && real.scope ? safeRealScope(doc, role, real.scope) : synthetic;
    if (authored && scope) {
      const outcomeScope = scopeForOutcome(scope, tab.screen, tab.action, now);
      const filtered = filterDoc(authored, role);
      rendered = renderScanDisplay(authored, outcomeScope, options);
      cuts = cutRows(filtered, outcomeScope, options, rendered);
      if (tab.screen !== 'refused') {
        const shown = new Set(rendered.panels.map((panel) => panel.id));
        hiddenPanels = (filtered.panels ?? []).filter(
          (panel) =>
            panel.when &&
            !shown.has(panel.id) &&
            (panel.on ?? ['ready', 'ok', 'heads_up']).includes(
              tab.screen as 'ready' | 'ok' | 'heads_up',
            ) &&
            (!panel.actions || !tab.action || panel.actions.includes(tab.action.id)) &&
            !panel.rows.some((row) => cuts.has(row.id)),
        );
      }
      fit = previewFit(filtered, tab.screen, manifest.scan?.flags?.length ?? 0);
      if (hasUnsafeRenderedText(rendered)) rendered = null;
    }
  } catch {
    /* Invalid in-progress documents cannot be painted. */
  }
  return {
    actions,
    tabs,
    tab,
    invalidDisplay,
    synthetic,
    usingReal,
    rendered,
    cuts,
    fit,
    hiddenPanels,
  };
}
