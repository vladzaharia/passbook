import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { SCAN_REASON_COPY } from '@/shared/copy/scan.ts';
import { Button, FormField, Input, Select } from '@/web/ui/index.ts';
import { useScannerPages } from '../queries.ts';
import { useScanEvents } from '../scanner-api.ts';
import type { ScanningSearch } from '../search.ts';

export function ScanFilters({ search, orgId }: { search: ScanningSearch; orgId?: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? '');
  const scanners = useScannerPages(orgId, false, Boolean(orgId));
  const events = useScanEvents(orgId, Boolean(orgId));
  const set = (patch: Partial<ScanningSearch>) =>
    void navigate({ to: '.', search: (prev) => ({ ...prev, ...patch }), replace: true });
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: q.trim() || undefined });
        }}
      >
        <FormField label="Pass name or ID">
          {(p) => (
            <Input
              {...p}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              type="search"
              maxLength={80}
            />
          )}
        </FormField>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <FormField label="Result">
        {(p) => (
          <Select
            {...p}
            value={search.outcome ?? 'all'}
            onValueChange={(value) =>
              set({ outcome: value === 'all' ? undefined : (value as ScanningSearch['outcome']) })
            }
            options={[
              { value: 'all', label: 'All results' },
              { value: 'ok', label: 'Done' },
              { value: 'heads_up', label: 'Heads-up' },
              { value: 'refused', label: 'Refused' },
              { value: 'undone', label: 'Undone' },
            ]}
          />
        )}
      </FormField>
      <FormField label="Scanner">
        {(p) => (
          <Select
            {...p}
            value={search.scannerId ?? 'all'}
            onValueChange={(value) => set({ scannerId: value === 'all' ? undefined : value })}
            options={[
              { value: 'all', label: 'All scanners' },
              ...(scanners.data?.pages
                .flatMap((page) => page.items)
                .filter((s) => s.orgId === orgId)
                .map((s) => ({ value: s.id, label: s.name })) ?? []),
            ]}
          />
        )}
      </FormField>
      <FormField label="Event">
        {(p) => (
          <Select
            {...p}
            value={search.eventId ?? 'all'}
            onValueChange={(value) => set({ eventId: value === 'all' ? undefined : value })}
            options={[
              { value: 'all', label: 'All events' },
              ...(events.data?.items
                .filter((e) => e.orgId === orgId)
                .map((e) => ({ value: e.id, label: e.name })) ?? []),
            ]}
          />
        )}
      </FormField>
      <FormField label="Reason">
        {(p) => (
          <Select
            {...p}
            value={search.reason ?? 'all'}
            onValueChange={(value) => set({ reason: value === 'all' ? undefined : value })}
            options={[
              { value: 'all', label: 'All reasons' },
              ...Object.entries(SCAN_REASON_COPY)
                .filter(([key]) => key !== 'choose')
                .map(([value, copy]) => ({ value, label: copy.headline })),
            ]}
          />
        )}
      </FormField>
      <FormField label="Date">
        {(p) => (
          <Select
            {...p}
            value={search.range ?? 'today'}
            onValueChange={(value) => set({ range: value as ScanningSearch['range'] })}
            options={[
              { value: 'today', label: 'Today' },
              { value: '7d', label: 'Last 7 days' },
              { value: '30d', label: 'Last 30 days' },
            ]}
          />
        )}
      </FormField>
      <Button
        variant="ghost"
        onClick={() => {
          setQ('');
          set({
            q: undefined,
            outcome: undefined,
            scannerId: undefined,
            staffId: undefined,
            eventId: undefined,
            reason: undefined,
            range: undefined,
          });
        }}
      >
        Clear filters
      </Button>
    </div>
  );
}
