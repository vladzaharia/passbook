import { Play } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { resolvePointer } from '@/shared/records/fields.ts';
import { detectResponse } from '@/shared/rest/detect.ts';
import { Button } from '../../../ui/index.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import { EmailCheckLine } from './email-check.tsx';
import {
  actionsFor,
  type Effect,
  type Format,
  type NodeAction,
  recordActions,
} from './explorer-actions.ts';
import { IncrementalPanel } from './incremental-panel.tsx';
import type { SampleField } from './mapping-seed.ts';
import { NodeActions } from './node-actions.tsx';
import { PageProof } from './page-proof.tsx';
import { PaginationPanel } from './pagination-panel.tsx';
import { Picks } from './picks.tsx';
import { ResponseTree } from './response-tree.tsx';
import { RestShell } from './rest-shell.tsx';
import {
  DEFAULT_ID,
  DEFAULT_RECORDS,
  KEY,
  readIncremental,
  readPagination,
  str,
} from './rest-values.ts';
import { rolesOf } from './roles.ts';
import { SampleLine } from './sample-line.tsx';
import { Suggestions } from './suggestions.tsx';
import { ancestors, buildRows, defaultOpen, openAll, type TreeRow } from './tree-model.ts';
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
  onSample?: (fields: SampleField[]) => void;
}

/** The REST explorer: fetch a sample, pick the records, ID and paging by clicking the response. */
export default function RestConfig(props: RestConfigProps) {
  const { value, onChange, showErrors = false, disabled, bare, onSample } = props;
  const ex = useExplorer({ ...props, onChange });
  const [view, setView] = useState<'list' | 'record'>('list');
  const shown = view === 'record' && ex.record ? ex.record : ex.first;
  const body = shown?.body;
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
    setOpenSet(view === 'record' ? openAll(shown?.body) : defaultOpen(records));
    setFocus('');
    setSelected(null);
  }, [shown]);
  useEffect(() => {
    if (found === null) return;
    const t = setTimeout(() => setFound(null), 900);
    return () => clearTimeout(t);
  }, [found]);

  const totals = useMemo(
    () => new Map((shown?.pruned?.arrays ?? []).map((a) => [a.pointer, a.total])),
    [shown],
  );
  const rows = useMemo(
    () => (body === undefined ? [] : buildRows(body, open, totals)),
    [body, open, totals],
  );
  const server = ex.first?.detections ?? null;
  const detections = useMemo(() => {
    const listBody = ex.first?.body;
    if (!ex.first || listBody === undefined || !server) return null;
    if (server.records[0]?.pointer === records || !ex.first.request) return server;
    return detectResponse({
      body: listBody,
      headers: ex.first.headers,
      url: ex.first.request.url,
      recordsPointer: records,
      idPointer: str(value[KEY.id], DEFAULT_ID),
    });
  }, [ex.first, server, records, value]);

  const updatedField = inc?.field || pickedUpdate?.field || detections?.updatedAt[0]?.pointer;
  const recordAt = str(value.recordPointer);
  const roles = useMemo(
    () =>
      view === 'record'
        ? new Map(value[KEY.email] ? [[`${recordAt}${str(value[KEY.email])}`, ['Email']]] : [])
        : rolesOf(value, updatedField),
    [view, value, updatedField, recordAt],
  );
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

  /** A holder email is read from the single record by a sync: check one ref there. */
  function verifyEmail(pointer: string) {
    const list = ex.first?.body;
    if (!value.recordPath || list === undefined) return;
    const id = resolvePointer(list, `${records}/0${str(value[KEY.id], DEFAULT_ID)}`);
    if (id.found && (typeof id.value === 'string' || typeof id.value === 'number'))
      void ex.checkEmail(pointer, String(id.value));
  }

  function take(effect: Effect, line: string, reveal?: string) {
    if (effect.patch) onChange(effect.patch);
    const email = effect.patch?.[KEY.email];
    if (typeof email === 'string' && email) verifyEmail(email);
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
  const nodeActions = !selectedRow
    ? []
    : view === 'record'
      ? recordActions(selectedRow, recordAt)
      : actionsFor(selectedRow, records, value);
  const run = (a: NodeAction) => take(a.effect, a.said, selectedRow?.pointer);

  function pick(row: TreeRow) {
    setSelected(row.pointer);
    setFocus(row.pointer);
    const first = view === 'record' ? undefined : actionsFor(row, records, value)[0];
    if (row.records && first) take(first.effect, first.said, row.pointer);
    if (row.expandable) setOpen(row.pointer, !open.has(row.pointer) || Boolean(row.records));
  }

  const ready = Boolean(value.baseUrl) && Boolean(value[KEY.path]);
  const label = ex.first ? 'Fetch again' : 'Fetch sample';
  const sample = detections?.fields;
  // biome-ignore lint/correctness/useExhaustiveDependencies: tell the wizard once per sample
  useEffect(() => {
    if (sample)
      onSample?.(
        sample.map((f) => ({
          pointer: f.pointer,
          label: f.label,
          samples: f.samples,
          preview: f.samples[0] ?? '',
        })),
      );
  }, [sample]);
  return (
    <RestShell
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
      {view === 'record' ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          <span>Single record</span>
          <Button variant="outline" size="sm" onClick={() => setView('list')}>
            Back to the list
          </Button>
        </div>
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
      <Picks
        value={value}
        onChange={(patch) => {
          if (KEY.email in patch) ex.clearEmail();
          onChange(patch);
        }}
        disabled={disabled}
      />
      {ex.email.state !== 'idle' ? (
        <EmailCheckLine check={ex.email} onShow={() => setView('record')} />
      ) : null}
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
    </RestShell>
  );
}
