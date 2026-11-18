import { scanIssues } from '@/passkit/template/scan.ts';
import type { TemplateManifest, ValidationIssue } from '@/passkit/types.ts';
import type { DesignDoc } from '../../model.ts';

const MINE = /^scan\.(actions|window|flags)\b/;
const ACTION = /^scan\.actions\.(\d+)/;

/** What the engine says about actions, window and flags, for the open draft; the dry run says the same. */
export function actionLocalIssues(doc: DesignDoc): ValidationIssue[] {
  if (doc.manifest.scan === undefined) return [];
  return scanIssues(doc.manifest as unknown as TemplateManifest).filter((i) =>
    MINE.test(i.path ?? ''),
  );
}

export function actionIndexOf(path: string | undefined): number | null {
  const m = ACTION.exec(path ?? '');
  return m ? Number(m[1]) : null;
}

export const forAction = (issues: readonly ValidationIssue[], index: number) =>
  issues.filter((i) => actionIndexOf(i.path) === index);

export const forPart = (issues: readonly ValidationIssue[], part: 'window' | 'flags') =>
  issues.filter((i) => (i.path ?? '').startsWith(`scan.${part}`));

/** Issues about the list as a whole, such as too many actions. */
export const forList = (issues: readonly ValidationIssue[]) =>
  issues.filter((i) => i.path === 'scan.actions');
