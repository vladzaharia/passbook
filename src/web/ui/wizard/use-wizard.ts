import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { attentionLine, useServerFields } from '../form.tsx';
import type { SaveResult } from '../save-bar.tsx';
import { mapServerError } from './wizard-server.ts';

export interface WizardStepDef<Id extends string = string> {
  id: Id;
  /** Rail label: a noun, one or two words ("Basics", "Who gets in"). */
  title: string;
  /** The visible heading, an instruction of four words or fewer ("Name the key"). Without it the title is the heading, for screen readers only. */
  heading?: string;
  /** What was chosen, under a done step on the rail ("Box office sync", "3 scopes"). */
  summary?: string | undefined;
  /** Not needed this run because of an earlier choice: hopped by Next and Back, no Review section. */
  skip?: boolean;
}

export type WizardStepState = 'done' | 'current' | 'todo' | 'skipped' | 'invalid';

export interface WizardOptions<Id extends string> {
  /** Computed each render: summaries change with the draft. */
  steps: readonly WizardStepDef<Id>[];
  /** Blocking problems per step, a pure function of the draft: field to message. */
  errors: Partial<Record<Id, Partial<Record<string, string>> | undefined>>;
  /** Why Next is off, four words or fewer with a period ("Name the key."). Falls back to the count. */
  hints?: Partial<Record<Id, string>>;
  /** Server field to the step that fixes it. */
  fieldStep: Partial<Record<string, Id>>;
  /** The last step's Next. Throw the ApiError; the hook maps it. */
  onFinish: () => Promise<unknown> | unknown;
  /** Create is linear and ends in a Review; edit reaches every step and ends in Save. */
  mode?: 'create' | 'edit';
  /** Dialogs pass `open`: the wizard resets when it opens again. */
  open?: boolean;
  /** Edit mode: the draft differs from what was loaded. Save is blocked with "No changes." until it does. */
  dirty?: boolean;
}

export interface WizardModel<Id extends string = string> {
  steps: (WizardStepDef<Id> & { state: WizardStepState })[];
  mode: 'create' | 'edit';
  index: number;
  id: Id;
  first: boolean;
  /** No later step is left to do: Next finishes. */
  last: boolean;
  /** Create: a step that was passed, or any step behind. Edit: any step. */
  go(to: number | Id): void;
  /** Same as pressing Next: a blocked step shows its errors instead. */
  next(): void;
  back(): void;
  blocked: boolean;
  /** Why the step is blocked, while it is. */
  hint: string | undefined;
  /** What the step's fields render: shown client errors, then the server's. */
  errors: Record<string, string | undefined>;
  /** One line at the foot of the step. */
  formError: string | undefined;
  /** Call from a field's onChange. */
  clearServer(field?: string): void;
  /** 'review' jumps back to Review when every step after this one is still done. */
  primary: 'next' | 'review' | 'finish';
  finishing: boolean;
  form: {
    id: string;
    invalid: boolean;
    blockedHint: string | undefined;
    onInvalid(): void;
    onValid(): Promise<SaveResult | undefined> | undefined;
    /** Typing clears the server's errors on the fields this step owns. */
    onInput(event: FormEvent<HTMLFormElement>): void;
  };
  /** The step changed `key` times; WizardStep animates from `direction`. */
  motion: { key: number; direction: 1 | -1 };
  reset(): void;
}

const has = (found: Partial<Record<string, string>> | undefined) =>
  Boolean(found && Object.values(found).some(Boolean));

/**
 * The step model of a wizard: where it is, what is done, what blocks Next, and where a server's
 * field errors land. No JSX; WizardDialog and the page Wizard draw it.
 */
export function useWizard<Id extends string>(options: WizardOptions<Id>): WizardModel<Id> {
  const { steps, errors, hints, fieldStep, onFinish, mode = 'create', open, dirty } = options;
  const edit = mode === 'edit';
  const formId = useId();
  const firstIndex = Math.max(
    0,
    steps.findIndex((s) => !s.skip),
  );
  const [index, setIndex] = useState(firstIndex);
  const [reached, setReached] = useState(0);
  const [passed, setPassed] = useState<ReadonlySet<Id>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<Id>>(new Set());
  const [formError, setFormError] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const [refused, setRefused] = useState(0);
  const [motion, setMotion] = useState<{ key: number; direction: 1 | -1 }>({
    key: 0,
    direction: 1,
  });
  const running = useRef(false);
  const server = useServerFields();

  const current = steps[index] ?? steps[firstIndex];
  const bad = (id: Id) => has(errors[id]);
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
    const visited = edit || passed.has(s.id);
    if (serverSteps.has(s.id) || (visited && bad(s.id))) return 'invalid';
    return visited ? 'done' : 'todo';
  };
  const views = steps.map((s, i) => ({ ...s, state: stateOf(i) }));
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
    : reviewIndex > index && reached >= reviewIndex && !blocked && laterDone
      ? 'review'
      : 'next';

  function move(to: number) {
    if (!steps[to] || steps[to]?.skip) return;
    const direction = to >= index ? 1 : -1;
    setMotion((m) => ({ key: m.key + 1, direction }));
    setFormError(undefined);
    setReached((r) => Math.max(r, to));
    setIndex(to);
  }

  /** The nearest step that is not skipped, or -1. */
  function hop(from: number, step: 1 | -1) {
    let at = from + step;
    while (steps[at]?.skip) at += step;
    return steps[at] ? at : -1;
  }

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
    if (!target || at === index || target.skip) return;
    if (!edit && at > index) {
      if (current && bad(current.id)) return refuse();
      if (stateOf(at) !== 'done' && stateOf(at) !== 'invalid') return;
    }
    move(at);
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
    move(primary === 'review' ? reviewIndex : hop(index, 1));
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
    setIndex(firstIndex);
    setReached(0);
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
    next() {
      const form = typeof document === 'undefined' ? null : document.getElementById(formId);
      if (form instanceof HTMLFormElement) form.requestSubmit();
      else if (blocked) refuse();
      else void onValid();
    },
    back() {
      const to = hop(index, -1);
      if (to >= 0) move(to);
    },
    blocked,
    hint,
    errors: visible,
    formError,
    clearServer: server.clear,
    primary,
    finishing,
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
    motion,
    reset,
  };
}
