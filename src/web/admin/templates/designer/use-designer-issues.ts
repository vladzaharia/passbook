import { useMemo } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { localIssues } from './local-issues.ts';
import type { DesignDoc } from './model.ts';
import { scanIssues } from './scan/document.ts';

/** Local and server validation may report the same problem; retain the strongest severity. */
function mergeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const rank = { info: 0, warning: 1, error: 2 } as const;
  const unique = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.code, issue.path ?? '', issue.message]);
    const previous = unique.get(key);
    if (!previous || rank[issue.severity] > rank[previous.severity]) unique.set(key, issue);
  }
  return [...unique.values()];
}

/** Combine validation from the pass, scan screen and server for display and save gating. */
export function useDesignerIssues(
  doc: DesignDoc,
  readOnly: { issues: readonly ValidationIssue[] } | undefined,
  serverIssues: readonly ValidationIssue[] | undefined,
) {
  const scanValidation = useMemo(() => scanIssues(doc), [doc]);
  const issues = useMemo(
    () =>
      mergeIssues(
        readOnly
          ? [...readOnly.issues, ...scanValidation]
          : [...localIssues(doc), ...scanValidation, ...(serverIssues ?? [])],
      ),
    [readOnly, doc, scanValidation, serverIssues],
  );
  const blocking = issues.filter((i) => i.severity === 'error').length;
  return { issues, blocking };
}
