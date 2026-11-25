import type { RestPagination } from '@/shared/contracts/connection-probe.ts';
import { FormField, Input, NumberField, RadioGroup, Select } from '../../../ui/index.ts';
import { paginationErrors, paginationFor, STYLES, type Style } from './rest-values.ts';

type P = RestPagination;
type Errors = Record<string, string>;

function Pointer({
  label,
  value,
  error,
  placeholder,
  disabled,
  onValue,
}: {
  label: string;
  value: string | undefined;
  error: string | undefined;
  placeholder: string;
  disabled: boolean | undefined;
  onValue: (v: string) => void;
}) {
  return (
    <FormField label={label} error={error}>
      {(f) => (
        <Input
          {...f}
          className="font-mono"
          value={value ?? ''}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onValue(e.target.value)}
        />
      )}
    </FormField>
  );
}

function Param({
  label = 'Query parameter',
  value,
  error,
  disabled,
  onValue,
}: {
  label?: string;
  value: string;
  error: string | undefined;
  disabled: boolean | undefined;
  onValue: (v: string) => void;
}) {
  return (
    <FormField label={label} error={error}>
      {(f) => (
        <Input
          {...f}
          className="font-mono"
          value={value}
          disabled={disabled}
          onChange={(e) => onValue(e.target.value)}
        />
      )}
    </FormField>
  );
}

function Size({
  value,
  error,
  disabled,
  onValue,
}: {
  value: number | undefined;
  error: string | undefined;
  disabled: boolean | undefined;
  onValue: (v: number | undefined) => void;
}) {
  return (
    <FormField label="Page size" error={error}>
      {(f) => (
        <NumberField
          {...f}
          value={value ?? null}
          disabled={disabled}
          onValueChange={(n) => onValue(n ?? undefined)}
        />
      )}
    </FormField>
  );
}

/** Drops an optional pointer that was cleared, so the saved block has no empty string. */
function set<T extends P>(p: T, patch: Partial<Record<keyof T, unknown>>): P {
  const next: Record<string, unknown> = { ...p, ...patch };
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] === undefined) delete next[k];
  return next as unknown as P;
}

/** The six paging styles as one choice and the settings of the chosen one. */
export function PaginationPanel({
  value,
  onChange,
  showErrors,
  disabled,
}: {
  value: P;
  onChange: (next: P) => void;
  showErrors: boolean;
  disabled?: boolean;
}) {
  const e: Errors = showErrors ? paginationErrors(value) : {};
  const common = { disabled };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RadioGroup
        legend="Pagination"
        orientation="horizontal"
        options={STYLES.map((s) => ({ ...s, disabled }))}
        value={value.style}
        onValueChange={(s) => onChange(paginationFor(s as Style, value))}
      />
      {value.style === 'cursor' ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Param
            {...common}
            value={value.param}
            error={e.param}
            onValue={(param) => onChange(set(value, { param }))}
          />
          <FormField label="Cursor from">
            {(f) => (
              <Select
                {...f}
                disabled={disabled}
                value={value.from}
                onValueChange={(from) => onChange(set(value, { from }))}
                options={[
                  { value: 'body', label: 'Response' },
                  { value: 'last-id', label: 'Last record ID' },
                ]}
              />
            )}
          </FormField>
          {value.from === 'body' ? (
            <Pointer
              {...common}
              label="Cursor"
              placeholder="/meta/next_cursor"
              value={value.cursorPointer}
              error={e.cursorPointer}
              onValue={(cursorPointer) => onChange({ ...value, cursorPointer })}
            />
          ) : null}
          <Pointer
            {...common}
            label="Has more"
            placeholder="/has_more"
            value={value.hasMorePointer}
            error={undefined}
            onValue={(hasMorePointer) => onChange(set(value, { hasMorePointer }))}
          />
        </div>
      ) : null}
      {value.style === 'next-link' ? (
        <Pointer
          {...common}
          label="Next link"
          placeholder="/links/next"
          value={value.nextPointer}
          error={e.nextPointer}
          onValue={(nextPointer) => onChange({ ...value, nextPointer })}
        />
      ) : null}
      {value.style === 'page' ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Param
            {...common}
            value={value.param}
            error={e.param}
            onValue={(param) => onChange(set(value, { param }))}
          />
          <FormField label="First page">
            {(f) => (
              <Select
                {...f}
                disabled={disabled}
                value={String(value.start)}
                onValueChange={(s) => onChange({ ...value, start: s === '0' ? 0 : 1 })}
                options={[
                  { value: '1', label: 'Page 1' },
                  { value: '0', label: 'Page 0' },
                ]}
              />
            )}
          </FormField>
          <Param
            {...common}
            label="Size parameter"
            value={value.sizeParam ?? ''}
            error={undefined}
            onValue={(sizeParam) => onChange(set(value, { sizeParam }))}
          />
          <Size
            {...common}
            value={value.size}
            error={undefined}
            onValue={(size) => onChange(set(value, { size }))}
          />
          <Pointer
            {...common}
            label="Total pages"
            placeholder="/meta/total_pages"
            value={value.totalPagesPointer}
            error={undefined}
            onValue={(totalPagesPointer) => onChange(set(value, { totalPagesPointer }))}
          />
        </div>
      ) : null}
      {value.style === 'offset' ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Param
            {...common}
            value={value.param}
            error={e.param}
            onValue={(param) => onChange(set(value, { param }))}
          />
          <Param
            {...common}
            label="Size parameter"
            value={value.sizeParam}
            error={e.sizeParam}
            onValue={(sizeParam) => onChange({ ...value, sizeParam })}
          />
          <Size
            {...common}
            value={value.size}
            error={e.size}
            onValue={(size) => onChange({ ...value, size: size ?? 0 })}
          />
          <Pointer
            {...common}
            label="Total"
            placeholder="/total"
            value={value.totalPointer}
            error={undefined}
            onValue={(totalPointer) => onChange(set(value, { totalPointer }))}
          />
        </div>
      ) : null}
      {value.style === 'link-header' ? (
        <p className="text-sm text-fg-muted">Follows rel="next" in the Link header.</p>
      ) : null}
      {value.style === 'none' ? (
        <p className="text-sm text-fg-muted">One request per sync.</p>
      ) : null}
    </div>
  );
}
