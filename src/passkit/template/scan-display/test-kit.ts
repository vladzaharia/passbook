/** Test helpers for the display: manifests, scopes and a one-call render. Tests only. */
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { Json, ScanAction, ScanRole, TemplateManifest } from '../../types.ts';
import { renderScanDisplay } from './render.ts';
import type { ScanDisplayDoc } from './schema.ts';
import type { EvalCtx, ScanDisplayScope } from './text.ts';

export const NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
export const FORMAT = { locale: 'en', timeZone: 'America/New_York', now: NOW } as const;

export function manifestOf(
  inputs: Record<string, Record<string, Json>>,
  scan: { actions?: ScanAction[]; flags?: { input: string; label: string }[] } = {},
  display?: ScanDisplayDoc,
): TemplateManifest {
  return {
    schema: 1,
    name: 'Test',
    inputs: { type: 'object', properties: inputs },
    sample: {},
    bindings: [],
    display: { title: '{{holder}}' },
    scan: {
      actions: scan.actions ?? [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      ...(scan.flags ? { flags: scan.flags } : {}),
      ...(display ? { display } : {}),
    },
  };
}

export const scopeOf = (
  inputs: Record<string, Json> = {},
  extra: ScanDisplayScope = {},
): ScanDisplayScope => ({
  inputs,
  pass: { title: 'Anna Meyer', templateName: 'Gala' },
  ...extra,
});

export const ctxOf = (scope: ScanDisplayScope = {}): EvalCtx => ({ ...FORMAT, scope });

export function renderDoc(
  doc: ScanDisplayDoc,
  scope: ScanDisplayScope = scopeOf(),
  options: Partial<{
    screen: ScanDisplay['screen'];
    role: ScanRole;
    terminal: boolean;
    actionId: string;
    amountOpen: boolean;
  }> = {},
): ScanDisplay {
  return renderScanDisplay(doc, scope, { screen: 'ok', role: 'desk', ...FORMAT, ...options });
}
