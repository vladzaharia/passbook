import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RequestLogDetail, RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { LOGS_BENCH_COPY } from '../../../shared/copy/developers-bench-logs.ts';
import { copyWithFeedback } from '../../developers/shell/copy.ts';
import { useMemberships } from '../../lib/session.ts';
import { useToolApi, useToolScope } from '../../lib/tool-api.tsx';
import { FilterBar, FilterSelect } from '../bench/filter-select.tsx';
import { useBenchKeys } from '../bench/keys.ts';
import { BenchList } from '../bench/list.tsx';
import { LiveIndicator, useLiveState } from '../bench/live.tsx';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchSlot } from '../bench/slots.tsx';
import { BenchSplit } from '../bench/split.tsx';
import { BenchState } from '../bench/state.tsx';
import { toneOfStatus } from '../bench/status-chip.tsx';
import { BenchTabs, benchPanelId, benchTabId } from '../bench/tabs.tsx';
import { SearchField, Toolbar } from '../bench/toolbar.tsx';
import { useBenchFilters } from '../bench/use-filters.ts';
import { useBenchSelection } from '../bench/use-selection.ts';
import { adminLink, useOptionalToolHost } from '../host/tool-host.tsx';
import { type LogKey, readKeys, readOne } from './api.ts';
import { codeOf } from './curl.ts';
import { FirstCall, NoMatch } from './empty.tsx';
import { codeOptions, keyOptions, ScopeChip, versionOptions } from './filter-options.tsx';
import { LogInspector } from './inspector.tsx';
import { FILTER_KEYS, keyTail, VIEW_KEY } from './model.ts';
import { loadOps, type OpIndex } from './ops.ts';
import { logRow } from './row.tsx';
import { useDetail } from './use-detail.ts';
import { useLog } from './use-log.ts';
import './logs.css';

const C = LOGS_BENCH_COPY;
const NO_OPS: OpIndex = {};
/** A call is selected by its request id: the id the console, the Trace and the search already link with. */
const idOf = (r: RequestLogEntry) => r.requestId;

const VIEWS = [
  { id: 'all', label: C.views.all },
  { id: 'errors', label: C.views.errors },
] as const;

/**
 * The Logs tool on the bench: Requests in the one list, the exchange in the one inspector (Request and
 * Response tabs), filters in the address, a live listener in the strip. `#<id>` selects a call by its log
 * id or its request id, fetched when it is older than the page.
 */
export function LogsTool() {
  const api = useToolApi();
  const host = useOptionalToolHost();
  const orgId = useToolScope()?.orgId ?? '';
  const filters = useBenchFilters(FILTER_KEYS, { search: 'path' });
  const view = useBenchFilters([VIEW_KEY]);
  const errors = view.values.tab === 'errors';
  const log = useLog({ ...filters.values, ...view.values });
  const [keys, setKeys] = useState<{ list: LogKey[]; known: boolean }>({ list: [], known: false });
  const [ops, setOps] = useState<OpIndex>(NO_OPS);
  const [tab, setTab] = useState('request');
  const memberships = useMemberships();
  const adminHref =
    host?.context.kind === 'org' &&
    memberships.data?.items.some((m) => m.orgId === orgId && m.capabilities.includes('org:manage'))
      ? `${adminLink(orgId).split('?')[0]}/settings?mode=test`
      : null;
  useEffect(() => {
    const ctl = new AbortController();
    readKeys(api, orgId, ctl.signal).then(
      (list) => setKeys({ list, known: true }),
      // The filter then names keys by the end of their ids; the list reads on.
      () => setKeys({ list: [], known: false }),
    );
    return () => ctl.abort();
  }, [api, orgId]);

  // A hash that names the call by its log id (or a request id in other letters) becomes its request id.
  const selectRef = useRef<(id: string | null) => void>(() => undefined);
  const fetchOne = useCallback(
    async (id: string) => {
      const row: RequestLogEntry | null = await readOne(api, id).catch(() => null);
      if (row && row.requestId !== id) selectRef.current(row.requestId);
      return row;
    },
    [api],
  );
  const selection = useBenchSelection({
    items: log.items,
    idOf,
    fetchOne,
    ready: log.phase === 'ready',
  });
  selectRef.current = (id) => selection.select(id, { open: true });
  useEffect(() => {
    const id = selection.selectedId;
    if (!id || selection.selected) return;
    const wanted = id.toLowerCase();
    const row = log.items.find((r) => r.id === id || r.requestId.toLowerCase() === wanted);
    if (row) selection.select(row.requestId, { open: true });
  }, [log.items, selection.selectedId, selection.selected, selection.select]);

  const row = selection.selected;
  const detail = useDetail(row?.id ?? null);
  useEffect(() => {
    if (row) void loadOps().then(setOps);
  }, [row]);

  const order = useMemo(
    () => [...(selection.pinned ? [selection.pinned] : []), ...log.items],
    [selection.pinned, log.items],
  );
  const at = row ? order.findIndex((r) => r.id === row.id) : -1;
  const full: RequestLogDetail | null = detail?.kind === 'ready' ? detail.row : null;
  useBenchKeys({
    next: () => selection.step(1),
    prev: () => selection.step(-1),
    close: () => {
      if (selection.open) selection.setOpen(false);
    },
    copyId: () => {
      if (row) void copyWithFeedback(row.requestId, null);
    },
    copyCurl: () => {
      if (full) void copyWithFeedback(codeOf('curl', full, location.origin), null);
    },
  });

  const live = useLiveState(log.paused);
  const search = filters.values.path ?? '';
  const narrowed = filters.active > 0 || search.trim() !== '';
  const clearAll = () => {
    filters.clear();
    filters.set('path', null);
  };

  if (log.phase === 'failed') return <BenchState scene="failed" onRetry={log.retry} />;
  if (log.phase === 'loading') return <BenchSkeleton rows={5} />;

  const nothing = narrowed ? (
    <NoMatch onClear={clearAll} />
  ) : errors ? (
    <BenchState scene="logs-idle" title={C.state.noErrors} />
  ) : (
    <FirstCall
      orgId={orgId}
      hasKey={!keys.known || keys.list.length > 0}
      onShowPortal={() => filters.set('source', 'try')}
    />
  );
  const keyChoices = keyOptions(keys.list, log.items, filters.values.key);
  const list = (
    <div className="logs-main" aria-busy={log.busy || undefined} data-busy={log.busy || undefined}>
      {log.capped ? (
        <p className="logs-full sm" role="status">
          {C.capped[log.capped]}
        </p>
      ) : null}
      <BenchList
        label={C.list}
        items={log.items}
        idOf={idOf}
        row={logRow}
        tone={(r) => toneOfStatus(r.status)}
        selection={selection}
        fresh={log.fresh}
        footer={{
          count: C.count(log.items.length, log.hasMore),
          onMore: log.hasMore ? () => void log.loadMore() : undefined,
          loading: log.more,
        }}
      />
      <p className="sr" aria-live="polite">
        {log.announce}
      </p>
    </div>
  );
  const pane = row ? (
    <LogInspector
      row={row}
      detail={detail}
      orgId={orgId}
      keyName={keys.list.find((k) => k.id === row.keyId)?.name}
      adminHref={adminHref}
      ops={ops}
      tab={tab}
      onTab={setTab}
      onPrev={at > 0 ? () => selection.step(-1) : undefined}
      onNext={at >= 0 && at < order.length - 1 ? () => selection.step(1) : undefined}
    />
  ) : (
    <p className="logs-none">{C.select}</p>
  );
  return (
    <>
      <BenchSlot name="count">{C.count(log.items.length, log.hasMore)}</BenchSlot>
      <LiveIndicator state={live} onResume={log.resume} />
      <Toolbar label={C.toolbar} note={C.retention}>
        <SearchField
          label={C.search}
          value={search}
          onChange={(v) => filters.set('path', v || null)}
        />
        <FilterBar active={filters.active} onClear={filters.clear}>
          <FilterSelect
            label={C.filters.status}
            value={filters.values.status}
            options={errors ? C.statusOptions.filter((o) => o.value !== '2xx') : C.statusOptions}
            onChange={(v) => filters.set('status', v)}
          />
          <FilterSelect
            label={C.filters.method}
            value={filters.values.method}
            options={C.methods.map((m) => ({ value: m, label: m }))}
            onChange={(v) => filters.set('method', v)}
          />
          <FilterSelect
            label={C.filters.code}
            value={filters.values.code}
            options={codeOptions(log.items, filters.values.code)}
            onChange={(v) => filters.set('code', v)}
          />
          <FilterSelect
            label={C.filters.key}
            value={filters.values.key}
            options={keyChoices}
            onChange={(v) => filters.set('key', v)}
          />
          <FilterSelect
            label={C.filters.version}
            value={filters.values.version}
            options={versionOptions(log.items, filters.values.version)}
            onChange={(v) => filters.set('version', v)}
          />
          {filters.values.pass ? (
            <ScopeChip
              label={C.filters.pass}
              value={keyTail(filters.values.pass)}
              clear={C.filters.clearPass(keyTail(filters.values.pass))}
              onClear={() => filters.set('pass', null)}
            />
          ) : null}
          <FilterSelect
            label={C.filters.source}
            value={filters.values.source}
            options={C.sources}
            any={C.filters.all}
            onChange={(v) => filters.set('source', v)}
          />
        </FilterBar>
      </Toolbar>
      <div
        id={benchPanelId('logs-view')}
        role="tabpanel"
        aria-labelledby={benchTabId('logs-view', errors ? 'errors' : 'all')}
        className="logs-panel"
      >
        <div className="logs-views">
          <BenchTabs
            base="logs-view"
            label={C.views.label}
            tabs={VIEWS}
            selected={errors ? 'errors' : 'all'}
            onSelect={(id) => view.set('tab', id === 'errors' ? 'errors' : null)}
          />
        </div>
        {log.items.length === 0 && !row ? (
          <div className="logs-solo">{nothing}</div>
        ) : (
          <BenchSplit
            main={list}
            pane={pane}
            open={selection.open && row !== null}
            onClose={() => selection.setOpen(false)}
            label={C.list}
            bare
          />
        )}
      </div>
      {log.items.length > 0 ? <p className="bench-note">{C.retention}</p> : null}
    </>
  );
}
