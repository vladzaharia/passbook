import { useSyncExternalStore } from 'react';
import type { Draft } from './fields.ts';

/**
 * The unsaved values of every SettingsForm on the page, by scope, so a view outside a form can
 * follow it (org detail: the pass email preview follows the support contacts form).
 */
const forms = new Map<string, Map<string, Draft>>();
const merged = new Map<string, Draft>();
const listeners = new Set<() => void>();
const NONE: Draft = {};

/** `null` when the form leaves the page. */
export function publishUnsaved(scope: string, formId: string, unsaved: Draft | null): void {
  const byForm = forms.get(scope) ?? new Map<string, Draft>();
  if (unsaved) byForm.set(formId, unsaved);
  else byForm.delete(formId);
  if (byForm.size > 0) {
    forms.set(scope, byForm);
    merged.set(scope, Object.assign({}, ...byForm.values()));
  } else {
    forms.delete(scope);
    merged.delete(scope);
  }
  for (const notify of listeners) notify();
}

/** The scope's changed fields, as their inputs hold them; saved fields are absent. */
export function useUnsaved(scope: string): Draft {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => merged.get(scope) ?? NONE,
    () => NONE,
  );
}
