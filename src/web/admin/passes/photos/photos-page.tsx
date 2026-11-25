import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
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
  ProgressBar,
  toast,
} from '../../../ui/index.ts';
import { passKeys } from '../api.ts';
import { type Entry, entriesOf, matchEntries, uploadEntry } from './photo-batch.ts';

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
    set(entriesOf(files));
    setBusy(true);
    try {
      set(await matchEntries(orgId, live.current));
    } catch (error) {
      toast.error(error, 'Could not match the photos');
      set([]);
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    setBusy(true);
    const queue = live.current.map((e, i) => [e, i] as const).filter(([e]) => retryable(e));
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [entry, index] = next;
        set(live.current.map((e, i) => (i === index ? { ...e, state: 'uploading' } : e)));
        const done = await uploadEntry(entry, include);
        set(live.current.map((e, i) => (i === index ? done : e)));
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setBusy(false);
    void client.invalidateQueries({ queryKey: passKeys.all });
    const count = (s: Entry['state']) => live.current.filter((e) => e.state === s).length;
    toast.success(`${count('done')} uploaded, ${count('failed')} failed.`);
  }

  const count = (s: Entry['state']) => entries.filter((e) => e.state === s).length;
  const ready = entries.filter(retryable).length;
  const finished = count('done') + count('failed');
  const handled = entries.filter((e) => e.state === 'done' || e.state === 'failed').length;
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
                label="Drop photos or choose"
                disabled={busy}
                onFiles={(files) => void choose(files)}
              />
              <p className="text-sm text-fg-muted">
                Images up to 10 MB, named by External ID or serial.
              </p>
              <CheckboxField
                label="Include photos in the Wallet pass"
                checked={include}
                disabled={busy}
                onCheckedChange={(checked) => setInclude(checked === true)}
              />
            </CardBody>
          </Card>
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
                {finished > 0 ? (
                  <ProgressBar
                    label="Photos handled"
                    value={handled}
                    max={entries.length - count('none') - count('ambiguous')}
                    valueText={`${handled} photos handled`}
                  />
                ) : null}
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
