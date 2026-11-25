import { Nfc } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { ApiError, errorMessage, UserMessageError } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Button, toast, useWizard, WizardDialog } from '@/web/ui/index.ts';
import { useTag, useTagMutations } from './api.ts';
import { type OrgChoice, OrgStep, type TagDraft, TagStep, TapStep } from './assign-steps.tsx';
import { ASSIGN_HINTS, ASSIGN_STEPS, FIELD_STEP } from './assign-words.ts';
import { endedOutcome } from './enroll-face.tsx';
import { ResultFace } from './enroll-result.tsx';
import { useTagRequest } from './use-tag-request.ts';
import { fill, lcFirst, tagErrorText } from './words.ts';

const D = TAG_COPY.dialog;

export type { OrgChoice };

export interface AssignTarget {
  /** A pass of the holder: the request rides on it, and a person-wide tag anchors to it. */
  passId: string;
  orgId: string;
  holderName: string;
  hasAccount: boolean;
}

/** One line of what was chosen, for the rail. */
function tagSummary(draft: TagDraft, scannerName: string): string {
  if (draft.method === 'type') return 'Typed ID';
  if (draft.method === 'spare') return 'Spare tag';
  return scannerName;
}

/** What blocks each step, as field to message. */
function problems(
  draft: TagDraft,
  org: OrgChoice | undefined,
  tap: string | undefined,
): Record<'org' | 'tag' | 'tap', Record<string, string> | undefined> {
  const tag: Record<string, string> = {};
  if (draft.method === 'scanner' && !draft.scannerId) tag.scanner = ASSIGN_HINTS.scanner;
  if (draft.method === 'type' && draft.typed.trim() === '') tag.id = ASSIGN_HINTS.type;
  if (draft.method === 'spare' && !draft.spareId) tag.spare = ASSIGN_HINTS.spare;
  return {
    org: org && !(org.value && org.ready) ? { org: ASSIGN_HINTS.org } : undefined,
    tag,
    tap: tap ? { tap } : undefined,
  };
}

/**
 * Assign tag: pick an organization (the user page), choose how, then wait for the tap. Closing
 * while a request is open cancels it; nothing is lost.
 */
export function AddTagDialog({
  open,
  onOpenChange,
  target,
  fixed,
  org,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AssignTarget;
  /** The user page fixes the choice to the person. */
  fixed?: 'person';
  /** The person has passes in several organizations: the first step picks one. */
  org?: OrgChoice;
}) {
  const mode = useMode();
  const blank: TagDraft = {
    scope: fixed ?? (target.hasAccount ? 'person' : 'pass'),
    method: 'scanner',
    scannerId: undefined,
    typed: '',
    spareId: undefined,
  };
  const [draft, setDraft] = useState<TagDraft>(blank);
  const [scannerName, setScannerName] = useState('');
  const [name, setName] = useState('');
  const mut = useTagMutations();
  const r = useTagRequest(target.passId, target.orgId);
  const { enrollment } = r;
  const tagId = enrollment?.state === 'done' ? enrollment.binding?.tagId : undefined;
  const tag = useTag(tagId);
  const hint = enrollment?.hint ?? tag.data?.hint;
  const done = enrollment?.state === 'done' && hint !== undefined;
  const ended = r.req && enrollment ? endedOutcome(enrollment, r.req.scannerName) : null;
  const set = useCallback((patch: Partial<TagDraft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const onScanner = useCallback(
    (id: string | undefined, label: string) => {
      set({ scannerId: id });
      setScannerName(label);
    },
    [set],
  );

  let tapProblem: string | undefined;
  if (!r.req || !enrollment || enrollment.state === 'pending') tapProblem = ASSIGN_HINTS.waiting;
  if (r.voided || ended?.kind === 'close') tapProblem = ASSIGN_HINTS.closed;
  else if (ended?.kind === 'back') tapProblem = ASSIGN_HINTS.another;
  if (done) tapProblem = undefined;

  const scanner = draft.method === 'scanner';
  const w = useWizard({
    open,
    steps: ASSIGN_STEPS.filter((s) => s.id !== 'org' || org).map((s) => ({
      ...s,
      skip: s.id === 'tap' ? !scanner : false,
      summary:
        s.id === 'org' ? org?.value : s.id === 'tag' ? tagSummary(draft, scannerName) : undefined,
    })),
    errors: problems(draft, org, tapProblem),
    hints: {
      org: ASSIGN_HINTS.org,
      tag:
        draft.method === 'type'
          ? ASSIGN_HINTS.type
          : draft.method === 'spare'
            ? ASSIGN_HINTS.spare
            : ASSIGN_HINTS.scanner,
      tap: tapProblem ?? ASSIGN_HINTS.waiting,
    },
    fieldStep: FIELD_STEP,
    onFinish: async () => {
      if (scanner) {
        const was = r.req;
        if (was) await r.send(was.scannerId, was.scannerName, was.scope);
        return;
      }
      const pick =
        draft.method === 'type' ? { id: draft.typed.trim() } : { tagId: draft.spareId ?? '' };
      try {
        await mut.assign.mutateAsync({
          passId: target.passId,
          binding: draft.scope === 'person' ? 'user' : 'pass',
          ...pick,
        });
      } catch (cause) {
        const text = errorMessage(tagErrorText(cause));
        if (draft.method === 'type') {
          throw new ApiError({
            status: 422,
            code: 'TAG_ID_INVALID',
            detail: text,
            fields: { id: text },
          });
        }
        throw new UserMessageError(text);
      }
      toast.success(D.done);
      onOpenChange(false);
    },
  });

  // Entering Tap sends the request; leaving it, or closing, cancels an open one.
  const onTap = w.id === 'tap';
  const starting = useRef(false);
  const run = useRef<() => void>(() => undefined);
  run.current = () => {
    if (!open) return;
    if (!onTap) {
      if (r.req) r.drop();
      return;
    }
    if (r.req || starting.current || !draft.scannerId) return;
    starting.current = true;
    void r.send(draft.scannerId, scannerName, draft.scope).then((ok) => {
      starting.current = false;
      if (!ok) w.back();
    });
  };
  const requested = Boolean(r.req);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` reads the latest render
  useEffect(() => run.current(), [open, onTap, requested]);

  // The admin lost the right mid-wait: close, and say so.
  const closed = useRef(false);
  useEffect(() => {
    if (r.forbidden && !closed.current) {
      closed.current = true;
      onOpenChange(false);
      toast.error(D.noAccess, 'Could not assign the tag');
    }
  }, [r.forbidden, onOpenChange]);

  function close() {
    r.drop();
    onOpenChange(false);
  }
  async function saveName(): Promise<boolean> {
    if (!tagId || name.trim() === (tag.data?.label ?? '')) return true;
    try {
      await mut.rename.mutateAsync({ id: tagId, label: name.trim() || null });
      return true;
    } catch (cause) {
      toast.error(cause, 'Could not name the tag');
      return false;
    }
  }
  async function undo() {
    const binding = enrollment?.binding;
    if (!binding) return;
    try {
      await mut.unbind.mutateAsync(binding.id);
    } catch (cause) {
      toast.error(tagErrorText(cause), 'Could not undo');
      return;
    }
    r.clear();
    setName('');
    w.go('tag');
  }
  async function another() {
    if (!(await saveName())) return;
    setName('');
    r.clear();
  }

  const summary = r.req
    ? `Works with ${lcFirst(
        r.req.scope === 'person'
          ? fill(TAG_COPY.worksWith.person, { name: target.holderName })
          : TAG_COPY.worksWith.pass,
      )}`
    : '';

  return (
    <WizardDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={D.title}
      wizard={w}
      dirty={draft.method === 'type' && draft.typed.trim() !== ''}
      finishLabel={scanner ? D.sendAgain : D.assign}
      busy={r.sending || mut.assign.isPending}
      onClose={() => {
        setDraft(blank);
        setScannerName('');
        setName('');
      }}
      result={
        done
          ? {
              title: D.done,
              icon: <Nfc aria-hidden />,
              body: (
                <div className="flex flex-col gap-4">
                  <ResultFace tag={tag.data} hint={hint} name={name} onName={setName} />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      loading={mut.unbind.isPending}
                      onClick={() => void undo()}
                    >
                      Undo
                    </Button>
                    <Button variant="outline" onClick={() => void another()}>
                      {D.again}
                    </Button>
                  </div>
                </div>
              ),
              onDone: () => void saveName().then((ok) => ok && onOpenChange(false)),
            }
          : undefined
      }
    >
      {w.id === 'org' && org ? <OrgStep org={org} error={w.errors.org} /> : null}
      {w.id === 'tag' ? (
        <TagStep
          draft={draft}
          set={(patch) => {
            set(patch);
          }}
          orgId={target.orgId}
          passId={target.passId}
          mode={mode}
          holderName={target.holderName}
          hasAccount={target.hasAccount}
          fixed={Boolean(fixed)}
          idError={w.errors.id}
          onScanner={onScanner}
        />
      ) : null}
      {onTap ? (
        <TapStep
          enrollment={enrollment}
          scannerName={r.req?.scannerName ?? scannerName}
          summary={summary}
          voided={r.voided}
        />
      ) : null}
    </WizardDialog>
  );
}
