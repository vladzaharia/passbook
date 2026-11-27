import { useCallback, useMemo } from 'react';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { PassView } from '@/shared/contracts/pass-views.ts';
import { UserMessageError } from '../../lib/errors.ts';
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
import { OrgsFilter } from './orgs-filter.tsx';

export const orgIdsOf = (raw: string | undefined): string[] =>
  raw ? raw.split(',').filter(Boolean) : [];

/** Views, the query bar and the select filters: what narrows the passes list. */
export function PassFindToolbar({
  search,
  orgId,
  templates,
  canOperate,
  all,
  onChange,
}: {
  search: ListSearch;
  orgId: string | undefined;
  templates: { id: string; name: string }[];
  canOperate: boolean;
  /** The All scope: the organizations to pick from. Views, templates and inputs need one organization. */
  all?: readonly Pick<OrgMembership, 'orgId' | 'orgName' | 'personal'>[] | undefined;
  onChange: (patch: Partial<ListSearch>) => void;
}) {
  const chips = useMemo(() => allChips(search), [search]);
  const fields = useFindFields(templates, search.templateId, orgId);
  const views = useSavedViews(orgId, true);
  const saved = useMemo(() => views.data?.items ?? [], [views.data]);
  const revision = views.data?.revision ?? 0;
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
      {all ? null : (
        <FindViews
          views={saved}
          counts={counts}
          active={active}
          canSave={canOperate}
          filter={filter}
          onPick={pick}
          onSave={async (name) => {
            if (filter.holderEmail)
              throw new UserMessageError('A view cannot hold an email address.');
            const id = `v${Date.now().toString(36)}`;
            await save.mutateAsync({ items: [...saved, { id, name, filter }], revision });
            toast.success('View saved');
          }}
          onDelete={(id) => save.mutate({ items: saved.filter((v) => v.id !== id), revision })}
        />
      )}
      <FindBar
        chips={chips}
        fields={fields}
        templates={templates}
        templateId={search.templateId}
        onTemplate={(templateId) => onChange({ templateId })}
        onAdd={add}
        onRemove={remove}
        extra={
          all ? (
            <OrgsFilter
              choices={all}
              value={orgIdsOf(search.orgIds)}
              onChange={(ids) => onChange({ orgIds: ids.length ? ids.join(',') : undefined })}
            />
          ) : undefined
        }
      />
      <PassListFilters search={search} orgId={orgId} all={Boolean(all)} onChange={onChange} />
    </>
  );
}
