import { Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectResponse } from '@/shared/rest/detect.ts';
import { Button, Card, CardBody, CardHeader } from '../../../ui/index.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import { actionsFor, type Effect, type Format, type NodeAction } from './explorer-actions.ts';
import { IncrementalPanel } from './incremental-panel.tsx';
import { NodeActions } from './node-actions.tsx';
import { PageProof } from './page-proof.tsx';
import { PaginationPanel } from './pagination-panel.tsx';
import { Picks } from './picks.tsx';
import { ResponseTree } from './response-tree.tsx';
import {
  DEFAULT_ID,
  DEFAULT_RECORDS,
  KEY,
  readIncremental,
  readPagination,
} from './rest-values.ts';
import { SampleLine } from './sample-line.tsx';
import { Suggestions } from './suggestions.tsx';
import { ancestors, buildRows, defaultOpen, type TreeRow } from './tree-model.ts';
import { type ExplorerArgs, useExplorer } from './use-explorer.ts';
import './rest.css';

export interface RestConfigProps extends Omit<ExplorerArgs, 'value' | 'onChange'> {
  value: FormValues;
  onChange: (patch: FormValues) => void;
  showErrors?: boolean;
  disabled?: boolean;
  /** Inside a card already (the wizard step): a heading and a rule, not a card of its own. */
  bare?: boolean;
  /** The sample's fields, for the Mapping step's source list. */
  onSample?: (fields: { pointer: string; preview: string }[]) => void;
}

function Shell({
  bare,
  action,
  children,
}: {
  bare: boolean | undefined;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!bare)
    return (
      <Card>
        <CardHeader title="Response" actions={action} />
        <CardBody className="flex min-w-0 flex-col gap-5">{children}</CardBody>
      </Card>
    );
  return (
    <section
      aria-label="Response"
      className="flex min-w-0 flex-col gap-5 border-t border-border pt-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-fg-strong">Response</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** The roles a node has been picked for: the first record stands for all of them. */
function rolesOf(v: FormValues, updated: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (p: string, role: string) => map.set(p, [...(map.get(p) ?? []), role]);
  const records = str(v[KEY.records], DEFAULT_RECORDS);
  add(records, 'Records');
  const first = `${records}/0`;
  add(`${first}${str(v[KEY.id], DEFAULT_ID)}`, 'ID');
  if (updated) add(`${first}${updated}`, 'Updated');
  if (v[KEY.email]) add(`${first}${str(v[KEY.email])}`, 'Email');
  const p = readPagination(v);
  if (p.style === 'cursor') {
    if (p.from === 'body' && p.cursorPointer) add(p.cursorPointer, 'Cursor');
    if (p.hasMorePointer) add(p.hasMorePointer, 'Has more');
  }
  if (p.style === 'next-link' && p.nextPointer) add(p.nextPointer, 'Next link');
  if (p.style === 'page' && p.totalPagesPointer) add(p.totalPagesPointer, 'Total');
  if (p.style === 'offset' && p.totalPointer) add(p.totalPointer, 'Total');
  return map;
}

/** The REST explorer: fetch a sample, pick the records, ID and paging by clicking the response. */
export default function RestConfig(props: RestConfigProps) {
  const { value, onChange, showErrors = false, disabled, bare, onSample } = props;
  const ex = useExplorer({ ...props, onChange });
  const body = ex.first?.body;
  const records = str(value[KEY.records], DEFAULT_RECORDS);
  const inc = readIncremental(value);
  const [pickedUpdate, setPickedUpdate] = useState<{ field: string; format: Format }>();
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set(['']));
  const [focus, setFocus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [found, setFound] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const actionsRef = useRef<HTMLButtonElement>(null);

  // A new sample opens the way to its records.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new sample resets the tree
  useEffect(() => {
    setOpenSet(defaultOpen(records));
    setFocus('');
    setSelected(null);
  }, [ex.first]);
  useEffect(() => {
    if (found === null) return;
    const t = setTimeout(() => setFound(null), 900);
    return () => clearTimeout(t);
  }, [found]);

  const totals = useMemo(
    () => new Map((ex.first?.pruned?.arrays ?? []).map((a) => [a.pointer, a.total])),
    [ex.first],
  );
  const rows = useMemo(
    () => (body === undefined ? [] : buildRows(body, open, totals)),
    [body, open, totals],
  );
  const server = ex.first?.detections ?? null;
  const detections = useMemo(() => {
    if (!ex.first || body === undefined || !server) return null;
    if (server.records[0]?.pointer === records || !ex.first.request) return server;
    return detectResponse({
      body,
      headers: ex.first.headers,
      url: ex.first.request.url,
      recordsPointer: records,
      idPointer: str(value[KEY.id], DEFAULT_ID),
    });
  }, [ex.first, body, server, records, value]);

  const updatedField = inc?.field || pickedUpdate?.field || detections?.updatedAt[0]?.pointer;
  const roles = useMemo(() => rolesOf(value, updatedField), [value, updatedField]);
  const suggested = useMemo(() => {
    const set = new Set<string>();
    for (const r of detections?.records ?? []) if (r.pointer !== records) set.add(r.pointer);
    return set;
  }, [detections, records]);

  const setOpen = (p: string, on: boolean) =>
    setOpenSet((s) => {
      const next = new Set(s);
      if (on) next.add(p);
      else next.delete(p);
      return next;
    });

  function take(effect: Effect, line: string, reveal?: string) {
    if (effect.patch) onChange(effect.patch);
    if (effect.updated) {
      setPickedUpdate(effect.updated);
      if (inc) onChange({ [KEY.incremental]: { ...inc, ...effect.updated } });
    }
    setSaid(line);
    if (reveal !== undefined) {
      setOpenSet((s) => new Set([...s, ...ancestors(reveal)]));
      setFound(reveal);
    }
  }

  const selectedRow = rows.find((r) => r.pointer === selected);
  const nodeActions = selectedRow ? actionsFor(selectedRow, records, value) : [];
  const run = (a: NodeAction) => take(a.effect, a.said, selectedRow?.pointer);

  function pick(row: TreeRow) {
    setSelected(row.pointer);
    setFocus(row.pointer);
    const first = actionsFor(row, records, value)[0];
    if (row.records && first) take(first.effect, first.said, row.pointer);
    if (row.expandable) setOpen(row.pointer, !open.has(row.pointer) || Boolean(row.records));
  }

  const ready = Boolean(value.baseUrl) && Boolean(value[KEY.path]);
  const label = ex.first ? 'Fetch again' : 'Fetch sample';
  const sample = detections?.fields;
  // biome-ignore lint/correctness/useExhaustiveDependencies: tell the wizard once per sample
  useEffect(() => {
    if (sample)
      onSample?.(sample.map((f) => ({ pointer: f.pointer, preview: f.samples[0] ?? '' })));
  }, [sample]);
  return (
    <Shell
      bare={bare}
      action={
        <Button
          variant="outline"
          size="sm"
          iconStart={<Play aria-hidden />}
          loading={ex.pending}
          disabled={disabled || !ready}
          onClick={() => void ex.fetchFirst()}
        >
          {label}
        </Button>
      }
    >
      <SampleLine result={ex.first} failure={ex.failure} ready={ready} detections={detections} />
      {detections ? (
        <Suggestions
          detections={detections}
          value={value}
          records={records}
          updatedField={updatedField}
          onTake={take}
        />
      ) : null}
      {body !== undefined ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <ResponseTree
            label="Response"
            rows={rows}
            open={open}
            setOpen={setOpen}
            focus={focus}
            setFocus={setFocus}
            selected={selected}
            roles={roles}
            suggested={suggested}
            found={found}
            onPick={pick}
            onActions={(r) => {
              setSelected(r.pointer);
              requestAnimationFrame(() => actionsRef.current?.focus());
            }}
          />
          <div className="min-w-0 rounded-lg border border-border bg-surface-sunken p-3">
            <NodeActions
              row={selectedRow}
              records={records}
              actions={nodeActions}
              onAction={run}
              firstRef={actionsRef}
            />
          </div>
        </div>
      ) : null}
      <p role="status" className="sr-only">
        {said}
      </p>
      <Picks value={value} onChange={onChange} disabled={disabled} />
      <PaginationPanel
        value={readPagination(value)}
        onChange={(p) => onChange({ [KEY.pagination]: p })}
        showErrors={showErrors}
        disabled={disabled}
      />
      <PageProof
        first={ex.first}
        second={ex.second}
        stale={ex.stale}
        pending={ex.pending}
        onNext={() => void ex.fetchNext()}
      />
      <IncrementalPanel
        value={inc}
        onChange={(i) => onChange({ [KEY.incremental]: i })}
        suggested={
          pickedUpdate ??
          (detections?.updatedAt[0]
            ? { field: detections.updatedAt[0].pointer, format: detections.updatedAt[0].format }
            : undefined)
        }
        full={value['list.listing'] !== 'feed'}
        showErrors={showErrors}
        disabled={disabled}
      />
    </Shell>
  );
}
