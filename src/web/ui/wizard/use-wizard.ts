import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { attentionLine, useServerFields } from '../form.tsx';
import type { SaveResult } from '../save-bar.tsx';
import { useWizardNav } from './wizard-nav.ts';
import { mapServerError } from './wizard-server.ts';
import type { WizardModel, WizardOptions, WizardStepState } from './wizard-types.ts';

/** `wait` is a load in flight: it holds Next on its own step, and marks no other step invalid. */
const WAIT = 'wait';
const has = (found: Partial<Record<string, string>> | undefined, waiting = true) =>
  Boolean(
    found && Object.entries(found).some(([key, value]) => value && (waiting || key !== WAIT)),
  );

/**
 * The step model of a wizard: where it is, what is done, what blocks Next, and where a server's
 * field errors land. No JSX; WizardDialog and the page Wizard draw it.
 */
export function useWizard<Id extends string>(options: WizardOptions<Id>): WizardModel<Id> {
  const {
    steps,
    errors,
    hints,
    fieldStep,
    onFinish,
    mode = 'create',
    open,
    dirty,
    lockedBefore,
    lockedReason,
  } = options;
  const edit = mode === 'edit';
  const formId = useId();
  const lockedAt = lockedBefore ? steps.findIndex((s) => s.id === lockedBefore) : -1;
  const isLocked = (i: number) => i < lockedAt && !steps[i]?.skip;
  // A locked step is hopped like a skipped one: Back stops at the first open step.
  const reachable = steps.map((s, i) => ({ skip: s.skip || isLocked(i) }));
  const firstIndex = Math.max(
    0,
    reachable.findIndex((s) => !s.skip),
  );
  const [passed, setPassed] = useState<ReadonlySet<Id>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<Id>>(new Set());
  const [formError, setFormError] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const [refused, setRefused] = useState(0);
  const nav = useWizardNav(reachable, firstIndex, () => setFormError(undefined));
  const { index, reached, motion, move, hop } = nav;
  const running = useRef(false);
  const server = useServerFields();

  const current = steps[index] ?? steps[firstIndex];
  const lockedIds = new Set(steps.filter((_, i) => isLocked(i)).map((s) => s.id));
  const bad = (id: Id) => !lockedIds.has(id) && has(errors[id], id === current?.id);
  const serverSteps = new Set<string>();
  for (const field of Object.keys(server.fields)) {
    const at = fieldStep[field];
    if (at) serverSteps.add(at);
  }
  const lastIndex = steps.reduce((at, s, i) => (s.skip ? at : i), 0);
  const reviewIndex = steps.findIndex((s) => s.id === 'review');
  const stateOf = (i: number): WizardStepState => {
    const s = steps[i];
    if (!s) return 'todo';
    if (s.skip && i !== index) return 'skipped';
    if (i === index) return 'current';
    if (isLocked(i)) return 'done';
    const visited = edit || passed.has(s.id);
    if (serverSteps.has(s.id) || (visited && bad(s.id))) return 'invalid';
    return visited ? 'done' : 'todo';
  };
  const views = steps.map((s, i) => ({
    ...s,
    ...(isLocked(i) ? { locked: true } : {}),
    state: stateOf(i),
  }));
  const last = edit || index >= lastIndex;
  // The step that finishes answers for every step: an earlier one may have turned invalid since.
  const firstBad = steps.findIndex((s) => !s.skip && bad(s.id));
  const withErrors = last ? firstBad >= 0 : current ? bad(current.id) : false;
  const unchanged = edit && dirty === false && !withErrors;
  const blocked = withErrors || unchanged;
  const hintStep = last ? steps[firstBad] : current;
  const count = hintStep ? Object.values(errors[hintStep.id] ?? {}).filter(Boolean).length : 0;
  const base = hintStep ? (hints?.[hintStep.id] ?? attentionLine(Math.max(count, 1))) : undefined;
  const hint = withErrors
    ? hintStep && hintStep !== current && base
      ? `${hintStep.title}: ${base}`
      : base
    : unchanged
      ? 'No changes.'
      : undefined;
  const laterDone =
    reviewIndex > index &&
    views.slice(index + 1, reviewIndex).every((s) => s.skip || s.state === 'done');
  const primary: WizardModel<Id>['primary'] = last
    ? 'finish'
    : reviewIndex > index && reached >= reviewIndex && !blocked && laterDone && firstBad < 0
      ? 'review'
      : 'next';

  function pass() {
    if (current) setPassed((p) => new Set(p).add(current.id));
  }

  function refuse() {
    const at = last ? firstBad : index;
    const step = steps[at];
    if (!step) return;
    setShown((s) => new Set(s).add(step.id));
    if (at !== index) move(at);
  }

  function go(to: number | Id) {
    const at = typeof to === 'number' ? to : steps.findIndex((s) => s.id === to);
    const target = steps[at];
    if (!target || at === index || target.skip || isLocked(at)) return;
    if (!edit && at > index) {
      if (current && bad(current.id)) return refuse();
      if (stateOf(at) !== 'done' && stateOf(at) !== 'invalid') return;
    }
    move(at);
  }

  function jump(to: number | Id) {
    const at = typeof to === 'number' ? to : steps.findIndex((s) => s.id === to);
    const target = steps[at];
    if (!target || target.skip || at === index || isLocked(at)) return;
    setPassed((p) => {
      const next = new Set(p);
      for (const s of steps.slice(0, at)) if (!s.skip) next.add(s.id);
      return next;
    });
    move(at);
  }

  function back() {
    const to = hop(index, -1);
    if (to >= 0) move(to);
  }

  async function finish(): Promise<SaveResult | undefined> {
    // Enter, a second press or a double submit while one is in flight must not send twice.
    if (running.current) return undefined;
    running.current = true;
    setFormError(undefined);
    server.reset();
    setFinishing(true);
    try {
      await onFinish();
      return 'saved';
    } catch (cause) {
      const out = mapServerError(cause, steps, fieldStep);
      if (out.kind === 'message') {
        setFormError(out.message);
        return 'failed';
      }
      server.set(out.fields);
      if (out.to >= 0 && out.to !== index) move(out.to);
      // A field no step owns would otherwise show nowhere.
      if (out.orphan) setFormError(out.orphan);
      if (out.to >= 0) setRefused((n) => n + 1);
      return out.to >= 0 ? 'refused' : 'failed';
    } finally {
      running.current = false;
      setFinishing(false);
    }
  }

  function onValid() {
    if (last) return finish();
    pass();
    const to = primary === 'review' ? reviewIndex : hop(index, 1);
    // Review is not reachable past a step that has gone invalid: land on that step, errors shown.
    const badStep = steps[firstBad];
    if (to === reviewIndex && badStep && firstBad !== index) {
      setShown((shown) => new Set(shown).add(badStep.id));
      move(firstBad);
      return undefined;
    }
    move(to);
    return undefined;
  }

  // A refused submit whose errors no control shows (a field the step does not draw) says so.
  const fieldsRef = useRef(server.fields);
  fieldsRef.current = server.fields;
  useEffect(() => {
    if (refused === 0) return;
    const form = document.getElementById(formId);
    if (!form || form.querySelector('[aria-invalid="true"]')) return;
    const first = Object.values(fieldsRef.current)[0];
    if (first) setFormError(first);
  }, [refused, formId]);

  function reset() {
    running.current = false;
    nav.reset();
    setPassed(new Set());
    setShown(new Set());
    setFormError(undefined);
    setFinishing(false);
    server.reset();
  }
  // Reset as the dialog opens again, not as it closes: the closing frames keep the step they show.
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (open && wasOpen.current === false) resetRef.current();
    wasOpen.current = open;
  }, [open]);

  const visible: Record<string, string | undefined> = { ...server.fields };
  for (const s of steps) {
    if (shown.has(s.id) && (edit || s.id === current?.id)) Object.assign(visible, errors[s.id]);
  }

  return {
    steps: views,
    mode,
    index,
    id: (current?.id ?? '') as Id,
    first: index <= firstIndex,
    last,
    go,
    jump,
    next() {
      const form = typeof document === 'undefined' ? null : document.getElementById(formId);
      if (form instanceof HTMLFormElement) form.requestSubmit();
      else if (blocked) refuse();
      else void onValid();
    },
    back,
    blocked,
    hint,
    errors: visible,
    formError,
    clearServer: server.clear,
    primary,
    finishing,
    lockedReason,
    form: {
      id: formId,
      invalid: blocked,
      blockedHint: hint,
      onInvalid: refuse,
      onValid,
      onInput(event) {
        const name = (event.target as HTMLInputElement).name;
        for (const field of Object.keys(server.fields)) {
          if (field === name || (current && fieldStep[field] === current.id)) server.clear(field);
        }
      },
    },
    frame: {
      steps: steps.map((s, i) => (isLocked(i) ? { ...s, locked: true } : s)),
      lockedReason,
      current: index,
      onStep: go,
      skipped: steps.filter((s) => s.skip).map((s) => s.id),
      onBack: index <= firstIndex ? undefined : back,
      formId,
      nextDisabled: blocked,
      nextHint: hint,
      busy: finishing,
      states: views.map((s) => s.state),
      formError,
      onBlocked() {
        const form = typeof document === 'undefined' ? null : document.getElementById(formId);
        if (form instanceof HTMLFormElement) form.requestSubmit();
        else refuse();
      },
    },
    motion,
    reset,
  };
}
