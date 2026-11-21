import { useCallback, useMemo } from 'react';
import type { PassView } from '@/shared/contracts/pass-views.ts';
import { toast } from '../../ui/index.ts';
import { useSavedViews, useSaveViews, useViewCounts } from './find-api.ts';
import { FindBar } from './find-bar.tsx';
import { useFindFields } from './find-fields.ts';
import {
  ANY_KEY,
  allChips,
  canonical,
  chipsParam,
  type FindChip,
  parseChips,
  searchOfFilter,
  toPassFilter,
} from './find-query.ts';
import { FindViews } from './find-views.tsx';
import { type ListSearch, PassListFilters } from './list-filters.tsx';

/** Views, the query bar and the select filters: what narrows the passes list. */
export function PassFindToolbar({
  search,
  orgId,
  templates,
  canOperate,
  onChange,
}: {
  search: ListSearch;
  orgId: string | undefined;
  templates: { id: string; name: string }[];
  canOperate: boolean;
  onChange: (patch: Partial<ListSearch>) => void;
}) {
  const chips = useMemo(() => allChips(search), [search]);
  const fields = useFindFields(templates, search.templateId, orgId);
  const views = useSavedViews(orgId, true);
  const saved = useMemo(() => views.data ?? [], [views.data]);
  const counts = useViewCounts(orgId, saved, views.isSuccess);
  const save = useSaveViews(orgId);
  const filter = useMemo(() => toPassFilter({ ...search, chips }), [search, chips]);
  const here = canonical(filter);
  const active = here === '{}' ? 'all' : saved.find((v) => canonical(v.filter) === here)?.id;

  const add = useCallback(
    (chip: FindChip) => {
      if (chip.k === ANY_KEY) onChange({ q: chip.v });
      else onChange({ m: chipsParam([...parseChips(search.m), chip]) });
    },
    [onChange, search.m],
  );
  const remove = useCallback(
    (index: number) => {
      const target = chips[index];
      if (target?.k === ANY_KEY) onChange({ q: undefined });
      else {
        const rest = parseChips(search.m);
        rest.splice(index - (search.q ? 1 : 0), 1);
        onChange({ m: chipsParam(rest) });
      }
    },
    [chips, onChange, search.m, search.q],
  );
  const pick = (view: PassView | null) =>
    onChange(
      view
        ? { ...searchOfFilter(view.filter) }
        : {
            q: undefined,
            m: undefined,
            templateId: undefined,
            status: undefined,
            holderState: undefined,
            onDevice: undefined,
            noScanDays: undefined,
            connectionId: undefined,
            importId: undefined,
          },
    );

  return (
    <>
      <FindViews
        views={saved}
        counts={counts}
        active={active}
        canSave={canOperate}
        filter={filter}
        onPick={pick}
        onSave={async (name) => {
          const id = `v${Date.now().toString(36)}`;
          await save.mutateAsync([...saved, { id, name, filter }]);
          toast.success('View saved');
        }}
        onDelete={(id) => save.mutate(saved.filter((v) => v.id !== id))}
      />
      <FindBar
        chips={chips}
        fields={fields}
        templates={templates}
        templateId={search.templateId}
        onTemplate={(templateId) => onChange({ templateId })}
        onAdd={add}
        onRemove={remove}
      />
      <PassListFilters search={search} orgId={orgId} onChange={onChange} />
    </>
  );
}
