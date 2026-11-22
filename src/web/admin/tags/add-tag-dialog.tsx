import { Send } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { ApiError, errorMessage } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { Button, Callout, Dialog, DialogContent, SegmentedControl, toast } from '@/web/ui/index.ts';
import { useTag, useTagMutations } from './api.ts';
import { type AssignMethod, SparePanel, TypePanel } from './assign-manual.tsx';
import {
  type Enrollment,
  useCancelEnrollment,
  useCreateEnrollment,
  useEnrollment,
} from './enroll-api.ts';
import { EnrollArt } from './enroll-art.tsx';
import { endedOutcome, WaitingFace } from './enroll-face.tsx';
import { ResultFace } from './enroll-result.tsx';
import { rememberScanner, ScannerPicker } from './scanner-picker.tsx';
import { fill, lcFirst, tagErrorText } from './words.ts';
import { type WorksWith, WorksWithChoice } from './works-with.tsx';

const D = TAG_COPY.dialog;

export interface AssignTarget {
  /** A pass of the holder: the request rides on it, and a person-wide tag anchors to it. */
  passId: string;
  orgId: string;
  holderName: string;
  hasAccount: boolean;
}

type Phase =
  | { at: 'pick' }
  | { at: 'wait'; id: string; scannerId: string; scannerName: string; scope: WorksWith };

/** What an ended request or a refused poll leaves behind, for the footer to read. */
const NOT_FOUND = 404;
const FORBIDDEN = 403;

/**
 * Assign with a scanner: pick what the tag works with and the scanner, wait for the tap, then
 * name it. Closing while a request is open cancels it; nothing is lost.
 */
export function AddTagDialog({
  open,
  onOpenChange,
  target,
  fixed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AssignTarget;
  /** The user page fixes the choice to the person. */
  fixed?: 'person';
}) {
  const mode = useMode();
  const [scope, setScope] = useState<WorksWith>(fixed ?? (target.hasAccount ? 'person' : 'pass'));
  const [scannerId, setScannerId] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ at: 'pick' });
  const [name, setName] = useState('');
  const [method, setMethod] = useState<AssignMethod>('scanner');
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string>();
  const [spareId, setSpareId] = useState<string>();
  const create = useCreateEnrollment(target.passId);
  const cancel = useCancelEnrollment(target.passId);
  const mut = useTagMutations();
  const waiting = phase.at === 'wait' ? phase : undefined;
  const poll = useEnrollment(target.passId, waiting?.id);
  const enrollment: Enrollment | undefined = poll.data;
  const tagId = enrollment?.state === 'done' ? enrollment.binding?.tagId : undefined;
  const tag = useTag(tagId);
  const [scannerName, setScannerName] = useState('');
  const onScanner = useCallback((id: string | undefined, label: string) => {
    setScannerId(id);
    setScannerName(label);
  }, []);

  // The admin lost the right mid-wait: close, and say so.
  const status = poll.error instanceof ApiError ? poll.error.status : undefined;
  const closed = useRef(false);
  useEffect(() => {
    if (status === FORBIDDEN && !closed.current) {
      closed.current = true;
      onOpenChange(false);
      toast.error(D.noAccess, 'Could not assign the tag');
    }
  }, [status, onOpenChange]);

  async function assign() {
    const binding = scope === 'person' ? 'user' : 'pass';
    const pick = method === 'type' ? { id: typed.trim() } : { tagId: spareId ?? '' };
    try {
      await mut.assign.mutateAsync({ passId: target.passId, binding, ...pick });
      toast.success(D.done);
      onOpenChange(false);
    } catch (cause) {
      if (method === 'type') setTypedError(errorMessage(tagErrorText(cause)));
      else toast.error(tagErrorText(cause), 'Could not assign the tag');
    }
  }
  async function send(chosen = scannerId, label = scannerName) {
    if (!chosen) return;
    try {
      const made = await create.mutateAsync({
        scannerId: chosen,
        binding: scope === 'person' ? 'user' : 'pass',
      });
      rememberScanner(target.orgId, chosen);
      setPhase({ at: 'wait', id: made.id, scannerId: chosen, scannerName: label, scope });
    } catch (cause) {
      toast.error(tagErrorText(cause), 'Could not send the request');
    }
  }
  function close(next: boolean) {
    if (!next && waiting && enrollment?.state === 'pending') {
      cancel.mutate(waiting.id, { onError: (cause) => toast.error(cause, 'Could not cancel') });
    }
    if (!next && tagId && name.trim() !== (tag.data?.label ?? '')) void saveName(false);
    onOpenChange(next);
  }
  async function saveName(close = true) {
    if (!tagId) return;
    try {
      await mut.rename.mutateAsync({ id: tagId, label: name.trim() || null });
    } catch (cause) {
      toast.error(cause, 'Could not name the tag');
      return;
    }
    if (close) onOpenChange(false);
  }
  async function undo() {
    const binding = enrollment?.binding;
    if (!binding) return;
    try {
      await mut.unbind.mutateAsync(binding.id);
      setPhase({ at: 'pick' });
    } catch (cause) {
      toast.error(tagErrorText(cause), 'Could not undo');
    }
  }
  const summary = waiting
    ? `Works with ${lcFirst(
        waiting.scope === 'person'
          ? fill(TAG_COPY.worksWith.person, { name: target.holderName })
          : TAG_COPY.worksWith.pass,
      )}`
    : '';
  const ended = enrollment && waiting ? endedOutcome(enrollment, waiting.scannerName) : null;
  const hint = enrollment?.hint ?? tag.data?.hint;
  const done = enrollment?.state === 'done' && hint !== undefined;
  const voided = status === NOT_FOUND;
  const busy = create.isPending;

  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (!waiting) {
    body = (
      <div className="flex flex-col gap-5">
        {fixed ? null : (
          <WorksWithChoice
            name={target.holderName}
            hasAccount={target.hasAccount}
            value={scope}
            onChange={setScope}
          />
        )}
        <SegmentedControl
          block
          label={TAG_COPY.assign}
          value={method}
          onValueChange={setMethod}
          options={(['scanner', 'type', 'spare'] as const).map((value) => ({
            value,
            label: TAG_COPY.assignShort[value],
            title: TAG_COPY.assignMenu[value],
          }))}
        />
        {method === 'scanner' ? (
          <ScannerPicker orgId={target.orgId} mode={mode} value={scannerId} onChange={onScanner} />
        ) : method === 'type' ? (
          <TypePanel
            value={typed}
            error={typedError}
            onChange={(v) => {
              setTyped(v);
              setTypedError(undefined);
            }}
          />
        ) : (
          <SparePanel
            orgId={target.orgId}
            passId={target.passId}
            binding={scope === 'person' ? 'user' : 'pass'}
            value={spareId}
            onChange={setSpareId}
          />
        )}
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={() => close(false)}>
          Cancel
        </Button>
        {method === 'scanner' ? (
          <Button
            loading={busy}
            disabled={!scannerId}
            iconStart={<Send aria-hidden />}
            onClick={() => void send()}
          >
            {D.send}
          </Button>
        ) : (
          <Button
            loading={mut.assign.isPending}
            disabled={method === 'type' ? typed.trim() === '' : !spareId}
            onClick={() => void assign()}
          >
            {D.assign}
          </Button>
        )}
      </>
    );
  } else if (voided) {
    body = <Refused tone="danger" title={D.voided} />;
    footer = <Button onClick={() => close(false)}>Close</Button>;
  } else if (done) {
    body = <ResultFace tag={tag.data} hint={hint} name={name} onName={setName} />;
    footer = (
      <>
        <Button variant="ghost" loading={mut.unbind.isPending} onClick={() => void undo()}>
          Undo
        </Button>
        <Button variant="outline" onClick={() => void send(waiting.scannerId, waiting.scannerName)}>
          {D.again}
        </Button>
        <Button loading={mut.rename.isPending} onClick={() => void saveName()}>
          Done
        </Button>
      </>
    );
  } else if (ended) {
    body = <Refused tone={ended.tone} title={ended.title} sub={ended.sub} />;
    footer =
      ended.kind === 'close' ? (
        <Button onClick={() => close(false)}>Close</Button>
      ) : (
        <>
          <Button variant="outline" onClick={() => setPhase({ at: 'pick' })}>
            {D.back}
          </Button>
          {ended.kind === 'again' ? (
            <Button
              loading={busy}
              onClick={() => void send(waiting.scannerId, waiting.scannerName)}
            >
              {D.sendAgain}
            </Button>
          ) : null}
        </>
      );
  } else {
    body = enrollment ? (
      <WaitingFace
        enrollment={enrollment}
        scanner={waiting.scannerName}
        ios={false}
        summary={summary}
      />
    ) : (
      <EnrollArt stage="waiting" />
    );
    footer = (
      <Button variant="outline" onClick={() => close(false)}>
        Cancel
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={D.title}
        footer={footer}
        onOpenAutoFocus={(e) => {
          if (waiting) e.preventDefault();
        }}
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}

function Refused({
  tone,
  title,
  sub,
}: {
  tone: 'warning' | 'danger';
  title: string;
  sub?: string | undefined;
}) {
  return (
    <div className="wl-enroll-face flex flex-col gap-4">
      <EnrollArt stage="refused" />
      <Callout tone={tone}>
        <span className="block font-medium text-fg-strong">{title}</span>
        {sub ? <span className="block">{sub}</span> : null}
      </Callout>
    </div>
  );
}
