import { useState } from 'react';
import { useDebounced } from '@/web/lib/debounce.ts';
import { ENTITY } from '../lib/entities.ts';
import {
  matchesWords,
  PALETTE_LIMIT,
  useConnectionOptions,
  useOrgOptions,
  useRecentPassSearch,
  useTemplateOptions,
  useUserSearch,
} from '../lib/search.ts';
import { Combobox, type ComboboxOption } from './combobox.tsx';
import { EntityAvatar } from './entity.tsx';

export type PickerKind = 'user' | 'pass' | 'connection' | 'org' | 'template';

export interface EntityPickerProps {
  kind: PickerKind;
  value: string | undefined;
  onValueChange: (id: string) => void;
  /** Shown before anything is picked: "Any user". */
  placeholder?: string;
  /** A label for the current value when it is not in the results (deep links). */
  valueLabel?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  className?: string;
}

/**
 * A combobox over an entity list, searched as you type (?q=&limit=5 for users and passes; one
 * loaded page matched by name for orgs, templates and connections). Never a raw id input.
 */
export function EntityPicker({
  kind,
  value,
  onValueChange,
  placeholder,
  valueLabel,
  ...rest
}: EntityPickerProps) {
  const [query, setQuery] = useState('');
  const term = useDebounced(query.trim(), 200);
  const users = useUserSearch(kind === 'user' ? term : '');
  const passes = useRecentPassSearch(kind === 'pass' ? term : '');
  const orgs = useOrgOptions(kind === 'org');
  const templates = useTemplateOptions(kind === 'template', term);
  const connections = useConnectionOptions(kind === 'connection', term);
  const Icon = ENTITY[kind].icon;
  const icon = <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />;
  const named = <T extends { id: string; name: string }>(list: readonly T[] | undefined) =>
    (list ?? []).filter((x) => !term || matchesWords(x.name, term)).slice(0, PALETTE_LIMIT);

  let options: ComboboxOption[] = [];
  let loading = false;
  if (kind === 'user') {
    loading = users.isFetching;
    options = (users.data?.items ?? []).map((u) => ({
      value: u.id,
      label: u.name ?? u.primaryEmail,
      icon: <EntityAvatar kind="user" id={u.id} name={u.name ?? u.primaryEmail} />,
    }));
  } else if (kind === 'pass') {
    loading = passes.isFetching;
    options = (passes.data?.items ?? []).map((p) => ({
      value: p.id,
      label: p.title ?? p.serial,
      icon,
    }));
  } else if (kind === 'org') {
    options = named(orgs.data?.items).map((o) => ({
      value: o.id,
      label: o.name,
      icon: <EntityAvatar kind="org" id={o.id} name={o.name} accent={o.branding.accent} />,
    }));
  } else if (kind === 'template') {
    options = named(templates.data?.items).map((t) => ({ value: t.id, label: t.name, icon }));
  } else {
    options = named(connections.data?.items).map((c) => ({ value: c.id, label: c.name, icon }));
  }
  if (value && valueLabel && !options.some((o) => o.value === value)) {
    options = [{ value, label: valueLabel, icon }, ...options];
  }
  return (
    <Combobox
      {...rest}
      options={options}
      value={value}
      onValueChange={onValueChange}
      onSearch={setQuery}
      loading={loading}
      placeholder={placeholder ?? `Pick ${ENTITY[kind].label.toLowerCase()}`}
      searchPlaceholder={`Search ${ENTITY[kind].plural}`}
    />
  );
}
