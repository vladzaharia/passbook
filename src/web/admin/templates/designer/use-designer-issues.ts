import { useEffect, useMemo, useState } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import type { DesignDoc } from './model.ts';

type Validators = typeof import('./issue-validators.ts');

let loading: Promise<Validators> | undefined;
let loaded: Validators | null = null;
const loadValidators = () => {
  loading ??= import('./issue-validators.ts').then(
    ({ localIssues, scanIssues, serverDuplicate }) => {
      loaded = { localIssues, scanIssues, serverDuplicate };
      return loaded;
    },
  );
  return loading;
};

/** The local validators, once their chunk has arrived; `failed` when it could not be fetched. */
function useValidators() {
  const [validators, setValidators] = useState(loaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (validators) return;
    let live = true;
    loadValidators().then(
      (m) => live && setValidators(m),
      () => {
        loading = undefined;
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [validators]);
  return { validators, failed };
}

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

/**
 * Combine validation from the pass, scan screen and server for display and save gating. `ready` is
 * false until the local validators have loaded: nothing may be saved on a partial list.
 */
export function useDesignerIssues(
  doc: DesignDoc,
  readOnly: { issues: readonly ValidationIssue[] } | undefined,
  serverIssues: readonly ValidationIssue[] | undefined,
) {
  const { validators, failed } = useValidators();
  const scanValidation = useMemo(() => validators?.scanIssues(doc) ?? [], [validators, doc]);
  const local = useMemo(() => validators?.localIssues(doc) ?? [], [validators, doc]);
  const issues = useMemo(
    () =>
      mergeIssues(
        readOnly
          ? [...readOnly.issues, ...scanValidation]
          : [
              ...local,
              ...scanValidation,
              ...(serverIssues ?? []).filter((i) => !validators?.serverDuplicate(i, local)),
            ],
      ),
    [readOnly, validators, local, scanValidation, serverIssues],
  );
  const blocking = issues.filter((i) => i.severity === 'error').length;
  return { issues, blocking, ready: validators !== null, loadFailed: failed };
}
