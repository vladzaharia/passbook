import {
  type Dispatch,
  Fragment,
  type ReactNode,
  type SetStateAction,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type GroupedForm,
  SaveBar,
  type SaveBarGroupApi,
  SaveBarGroupContext,
  type SaveBarMember,
  type SaveResult,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from './save-bar.tsx';
import { toast } from './toaster.tsx';

type Registry<T> = Dispatch<SetStateAction<ReadonlyMap<string, T>>>;

/** Sets or removes one entry, keeping the map when nothing changed. */
const entry =
  <T,>(set: Registry<T>) =>
  (id: string, value: T | null) =>
    set((prev) => {
      if (value === null ? !prev.has(id) : prev.get(id) === value) return prev;
      const next = new Map(prev);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });

/** Top to bottom on the page; a bar without a form keeps its place. */
function inPageOrder(members: SaveBarMember[]): SaveBarMember[] {
  const at = (m: SaveBarMember) => {
    const id = m.props.current.formId;
    return id ? document.getElementById(id) : null;
  };
  return members.sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (!x || !y) return 0;
    return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

/**
 * One page, one save affordance. Every SaveBar inside reports here and the group shows a single
 * bar: Save submits each dirty form top to bottom, one after another so writes to a shared
 * resource land in order; Discard resets them all; one route guard asks once. A refused form
 * keeps its errors and takes focus while the others save; all saved shows one "Saved".
 */
export function SaveBarGroup({ children }: { children: ReactNode }) {
  const [members, setMembers] = useState<ReadonlyMap<string, SaveBarMember>>(() => new Map());
  const [guards, setGuards] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const live = useRef(members);
  live.current = members;
  const forms = useRef(new Map<string, { readonly current: GroupedForm }>());
  const running = useRef(false);

  const api = useMemo<SaveBarGroupApi>(() => {
    async function submit(member: SaveBarMember): Promise<SaveResult> {
      const { formId, onSave } = member.props.current;
      const form = formId ? forms.current.get(formId)?.current : undefined;
      if (form?.invalid) {
        form.onInvalid?.();
        return 'refused';
      }
      try {
        if (form) return (await form.onValid()) ?? 'saved';
        // formId names a kit Form; without one there is nothing to submit.
        return formId ? 'failed' : ((await onSave?.()) ?? 'saved');
      } catch (cause) {
        toast.error(cause, 'Could not save');
        return 'failed';
      }
    }
    async function save() {
      if (running.current) return;
      running.current = true;
      const dirty = inPageOrder([...live.current.values()].filter((m) => m.dirty));
      const results: { formId?: string; result: SaveResult }[] = [];
      for (const m of dirty)
        results.push({ formId: m.props.current.formId, result: await submit(m) });
      running.current = false;
      const refused = results.find((r) => r.result === 'refused');
      if (refused?.formId) forms.current.get(refused.formId)?.current.block();
      else if (results.length > 0 && results.every((r) => r.result === 'saved'))
        toast.success('Saved');
    }
    return {
      member: entry(setMembers),
      guard: entry(setGuards),
      form: (id, form) => {
        if (form) forms.current.set(id, form);
        else forms.current.delete(id);
      },
      has: (formId) => live.current.has(formId),
      save: () => void save(),
    };
  }, []);

  const all = [...members];
  const dirty = all.some(([, m]) => m.dirty);
  const blocker = useUnsavedChangesGuard(dirty || [...guards.values()].some(Boolean));
  return (
    <>
      <SaveBarGroupContext.Provider value={api}>{children}</SaveBarGroupContext.Provider>
      <SaveBar
        dirty={dirty}
        saving={all.some(([, m]) => m.saving)}
        paused={all.some(([, m]) => m.paused)}
        extra={
          all.some(([, m]) => m.extra)
            ? all.map(([id, m]) => <Fragment key={id}>{m.extra}</Fragment>)
            : undefined
        }
        onSave={api.save}
        onDiscard={() => {
          for (const m of live.current.values()) if (m.dirty) m.props.current.onDiscard();
        }}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

/** A form's own confirmation. Inside a SaveBarGroup the group says "Saved" once instead. */
export function useSavedToast(): (message: string) => void {
  const grouped = useContext(SaveBarGroupContext) !== null;
  return (message) => {
    if (!grouped) toast.success(message);
  };
}
