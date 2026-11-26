import { Link2 } from 'lucide-react';
import type { WebhookEndpointDto } from '../../../shared/contracts/webhooks.ts';
import { BENCH_WEBHOOKS_COPY } from '../../../shared/copy/developers-bench-webhooks.ts';
import { PATHS } from '../../../shared/developers.ts';
import { FilterBar, FilterSelect } from '../bench/filter-select.tsx';
import { shortId } from '../bench/id-chip.tsx';
import { Toolbar } from '../bench/toolbar.tsx';
import type { BenchFilters } from '../bench/use-filters.ts';
import { endpointLabel } from './model.ts';

const C = BENCH_WEBHOOKS_COPY;
const F = C.filters;
/** The filters of the address (`?type=…&status=…&request=…&pass=…`); the endpoint is its own. */
export const FILTERS = ['type', 'status', 'request', 'pass'] as const;

/** The toolbar: the endpoint, the filters (a request and a pass appear only when a link set them) and Manage. */
export function WebhookToolbar({
  endpoints,
  endpoint,
  types,
  onEndpoint,
  onManage,
  filters,
}: {
  endpoints: readonly WebhookEndpointDto[];
  endpoint: WebhookEndpointDto;
  types: readonly string[];
  onEndpoint: (id: string) => void;
  onManage: () => void;
  filters: BenchFilters<(typeof FILTERS)[number]>;
}) {
  const { values, set, clear, active } = filters;
  const scoped = (key: 'request' | 'pass', label: string) =>
    values[key] ? (
      <FilterSelect
        label={label}
        value={values[key]}
        options={[{ value: values[key], label: shortId(values[key]) }]}
        onChange={(v) => set(key, v)}
      />
    ) : null;
  return (
    <Toolbar
      label={F.toolbar}
      note={
        <>
          {C.note.kept} · <a href={`${PATHS.guides}/react-to-events`}>{C.note.types}</a>
        </>
      }
    >
      <FilterSelect
        className="wh-endpoint"
        label={F.endpoint}
        value={endpoint.target === 'capture' ? undefined : endpoint.id}
        any={C.capture.name}
        options={endpoints
          .filter((e) => e.target !== 'capture')
          .map((e) => ({ value: e.id, label: endpointLabel(e) }))}
        onChange={(v) => onEndpoint(v ?? '')}
      />
      <FilterBar active={active} onClear={clear}>
        <FilterSelect
          label={F.type}
          value={values.type}
          options={types.map((t) => ({ value: t, label: t }))}
          onChange={(v) => set('type', v)}
        />
        <FilterSelect
          label={F.status}
          value={values.status}
          options={[
            { value: 'ok', label: F.ok },
            { value: 'failed', label: F.failed },
            { value: 'pending', label: F.pending },
          ]}
          onChange={(v) => set('status', v)}
        />
        {scoped('request', F.request)}
        {scoped('pass', F.pass)}
      </FilterBar>
      <button
        type="button"
        className="btn ghost sm wh-manage"
        aria-label={F.manage}
        onClick={onManage}
      >
        <Link2 aria-hidden="true" />
        <span className="wh-manage-t">{F.manage}</span>
      </button>
    </Toolbar>
  );
}
