import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { errorMessage } from '@/web/lib/errors.ts';
import { pluralize } from '@/web/lib/format.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CheckboxField,
  EmptyState,
  FileDrop,
  ListRow,
  ListRows,
  PageHeader,
  toast,
} from '../../../ui/index.ts';
import { LocalOperation } from '../../../ui/operation/index.ts';
import { passKeys } from '../api.ts';
import { type Entry, entriesOf, matchEntries, uploadEntry } from './photo-batch.ts';
import { PHOTO_DEF, PhotoProgress } from './photo-progress.tsx';

const CRUMBS = [{ label: 'Passes', to: '/admin/passes' }, { label: 'Photos' }];
const PARALLEL = 3;
const MAX_FILES = 1000;

/** A failed upload of a matched pass can be sent again. */
const retryable = (e: Entry) =>
  e.state === 'matched' || (e.state === 'failed' && Boolean(e.passId));

const LABEL: Record<Entry['state'], [string, 'neutral' | 'success' | 'warning' | 'danger']> = {
  matching: ['Matching', 'neutral'],
  matched: ['Matched', 'success'],
  none: ['No pass', 'warning'],
  ambiguous: ['Several passes', 'warning'],
  uploading: ['Uploading', 'neutral'],
  done: ['Uploaded', 'success'],
  failed: ['Failed', 'danger'],
};

/** Bulk photo import: files named by External ID or serial are matched, cropped and uploaded. */
export function PhotosPage() {
  const { orgId, membership } = useOrgScope();
  const client = useQueryClient();
  const canOperate = membership?.capabilities.includes('passes:operate') ?? false;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [include, setInclude] = useState(false);
  const [busy, setBusy] = useState(false);
  const [driver, setDriver] = useState<LocalOperation | null>(null);
  const live = useRef<Entry[]>([]);
  const set = (next: Entry[]) => {
    live.current = next;
    setEntries(next);
  };

  async function choose(files: File[]) {
    if (!orgId) return;
    if (files.length > MAX_FILES) {
      toast.error(`Choose at most ${MAX_FILES} photos at once.`, 'Too many photos');
      return;
    }
    const op = new LocalOperation(PHOTO_DEF);
    setDriver(op);
    set(entriesOf(files));
    setBusy(true);
    op.step('match', { total: files.length });
    try {
      set(await matchEntries(orgId, live.current, (n) => op.progress('match', n)));
      op.complete('match');
      const ready = live.current.filter(retryable).length;
      if (ready === 0) op.fail('match', 'No photo matched a pass.', { retryable: false });
      else op.wait('upload', `Ready to upload ${pluralize(ready, 'photo')}`);
    } catch (error) {
      op.fail('match', errorMessage(error), { retryable: false });
      set([]);
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const op = driver;
    setBusy(true);
    const queue = live.current.map((e, i) => [e, i] as const).filter(([e]) => retryable(e));
    const total = queue.length;
    if (op?.snapshot().status === 'failed') op.retry();
    op?.step('upload', { total });
    let handled = 0;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [entry, index] = next;
        set(live.current.map((e, i) => (i === index ? { ...e, state: 'uploading' } : e)));
        const done = await uploadEntry(entry, include);
        set(live.current.map((e, i) => (i === index ? done : e)));
        op?.progress('upload', ++handled);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setBusy(false);
    void client.invalidateQueries({ queryKey: passKeys.all });
    const failed = live.current.filter((e) => e.state === 'failed').length;
    if (failed > 0)
      op?.fail('upload', `${pluralize(failed, 'photo')} failed. Retry sends them again.`);
    else {
      op?.complete('upload');
      op?.finish();
    }
  }

  const ready = entries.filter(retryable).length;
  if (!orgId) return <OrgChooser />;
  return (
    <>
      <PageHeader title="Photos" breadcrumbs={CRUMBS} />
      {!canOperate ? (
        <EmptyState art="lock" title="You cannot change passes in this organization." />
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardBody className="flex flex-col gap-3">
              <FileDrop
                multiple
                accept="image/*"
                maxBytes={10_000_000}
                art="badge"
                label="Drop photos named by external ID or serial"
                disabled={busy}
                onFiles={(files) => void choose(files)}
              />
              <CheckboxField
                label="Include photos in the Wallet pass"
                checked={include}
                disabled={busy}
                onCheckedChange={(checked) => setInclude(checked === true)}
              />
            </CardBody>
          </Card>
          {driver && orgId ? (
            <PhotoProgress
              driver={driver}
              orgId={orgId}
              onRetry={() => void upload()}
              onClose={() => setDriver(null)}
            />
          ) : null}
          {entries.length > 0 ? (
            <Card>
              <CardHeader title={pluralize(entries.length, 'file')} />
              <CardBody className="flex flex-col gap-3">
                <Button
                  className="self-start"
                  disabled={busy || ready === 0}
                  onClick={() => void upload()}
                >
                  {ready === 0 ? 'Upload' : `Upload ${ready}`}
                </Button>
                <ListRows label="Photo files">
                  {entries.map((e) => (
                    <ListRow
                      key={e.id}
                      title={e.file.name}
                      meta={e.error}
                      trailing={<Badge tone={LABEL[e.state][1]}>{LABEL[e.state][0]}</Badge>}
                    />
                  ))}
                </ListRows>
              </CardBody>
            </Card>
          ) : null}
        </div>
      )}
    </>
  );
}
