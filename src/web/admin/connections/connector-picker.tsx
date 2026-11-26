import { type CSSProperties, type KeyboardEvent, useId, useRef, useState } from 'react';
import { ENTITY } from '../../lib/entities.ts';
import { EmptyState, FormField, Input, OptionTile, Select, SkeletonRows } from '../../ui/index.ts';
import {
  type ConnectorTile,
  GROUPS,
  GROUPS_AT,
  matchTiles,
  SEARCH_AT,
  tileKey,
} from './connector-tiles.ts';
import './connections.css';

function TileGrid({
  tiles,
  label,
  selected,
  onPick,
  onCommit,
  offset,
}: {
  tiles: readonly ConnectorTile[];
  label: string;
  selected: string;
  onPick: (tile: ConnectorTile) => void;
  onCommit: (tile: ConnectorTile) => void;
  /** Index of the first tile in the flat order, for the entrance stagger. */
  offset: number;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tiles.map((t, i) => {
        const picked = t.key === selected;
        const Icon = t.icon;
        return (
          <div
            key={t.key}
            className="wl-tile-in"
            style={{ '--wl-i': Math.min(offset + i, 12) } as CSSProperties}
          >
            <OptionTile
              name="connector"
              value={t.key}
              label={t.label}
              description={t.line}
              className="h-full items-center"
              checked={picked}
              onSelect={() => onPick(t)}
              onCommit={() => {
                onPick(t);
                onCommit(t);
              }}
              media={
                <span
                  aria-hidden
                  key={picked ? 'on' : 'off'}
                  className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken ${
                    picked ? 'wl-glyph-bounce text-accent-fg' : 'text-fg-muted'
                  }`}
                >
                  <Icon className="size-5" />
                </span>
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/** Tiles in groups above 8, with search above 10. Arrow keys move through the flat tile order. */
export function ConnectorPicker({
  tiles,
  type,
  recipe,
  onPick,
  onCommit,
  invalid,
}: {
  tiles: readonly ConnectorTile[];
  type: string | undefined;
  recipe: string | undefined;
  onPick: (tile: ConnectorTile) => void;
  onCommit: (tile: ConnectorTile) => void;
  /** Next was pressed with nothing chosen. */
  invalid?: boolean;
}) {
  const [query, setQuery] = useState('');
  const root = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const searchable = tiles.length > SEARCH_AT;
  const grouped = tiles.length > GROUPS_AT;
  const shown = searchable ? matchTiles(tiles, query) : tiles;
  const selected = tileKey(type, recipe);

  const fromSearch = (e: KeyboardEvent<HTMLInputElement>) => {
    const first = shown.find((t) => t.key === selected) ?? shown[0];
    if (e.key === 'ArrowDown' && first) {
      e.preventDefault();
      root.current?.querySelector<HTMLInputElement>(`input[value="${first.key}"]`)?.focus();
    } else if (e.key === 'Enter' && first) {
      e.preventDefault();
      onPick(first);
      onCommit(first);
    }
  };

  let seen = 0;
  const sections = grouped
    ? GROUPS.map((g) => ({ ...g, tiles: shown.filter((t) => t.category === g.id) })).filter(
        (g) => g.tiles.length > 0,
      )
    : [{ id: 'all', label: 'Connector', tiles: shown }];
  return (
    <fieldset
      ref={root}
      className="min-w-0"
      aria-invalid={invalid ? true : undefined}
      aria-describedby={invalid ? 'connector-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">Connector</legend>
      {searchable ? (
        <div className="mb-4 sm:max-w-sm">
          <Input
            type="search"
            aria-label="Search connectors"
            aria-controls={id}
            placeholder="Search connectors"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={fromSearch}
          />
          <p role="status" className="sr-only">
            {query ? `${shown.length} connectors` : ''}
          </p>
        </div>
      ) : null}
      <div id={id} className="flex flex-col gap-5">
        {sections.map((g) => {
          const offset = seen;
          seen += g.tiles.length;
          return (
            <section key={g.id} aria-label={grouped ? g.label : undefined} className="min-w-0">
              {grouped ? (
                <h3 className="mb-2 text-xs font-medium text-fg-muted">{g.label}</h3>
              ) : null}
              <TileGrid
                tiles={g.tiles}
                label={g.label}
                selected={selected}
                onPick={onPick}
                onCommit={onCommit}
                offset={offset}
              />
            </section>
          );
        })}
        {shown.length === 0 ? (
          <EmptyState
            inline
            art={ENTITY.search.art}
            variant="filtered"
            title="No connector matches"
          />
        ) : null}
      </div>
      {invalid ? (
        <p id="connector-error" className="mt-2 text-xs text-danger">
          Choose a connector.
        </p>
      ) : null}
    </fieldset>
  );
}

export function ConnectorStep({
  tiles,
  loading,
  type,
  recipe,
  onPick,
  onCommit,
  orgs,
  orgId,
  onOrg,
  showErrors,
}: {
  tiles: readonly ConnectorTile[];
  loading: boolean;
  type: string | undefined;
  recipe: string | undefined;
  onPick: (tile: ConnectorTile) => void;
  onCommit: () => void;
  /** Shown only when the top-bar scope does not set the org. */
  orgs: { id: string; name: string }[] | null;
  orgId: string | undefined;
  onOrg: (id: string) => void;
  /** Next was pressed with no org or no connector. */
  showErrors?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {orgs ? (
        <FormField
          label="Organization"
          required
          error={showErrors && !orgId ? 'Choose an organization.' : undefined}
        >
          {(c) => (
            <Select
              {...c}
              className="sm:max-w-sm"
              value={orgId}
              placeholder="Choose an organization"
              onValueChange={onOrg}
              options={orgs.map((o) => ({ value: o.id, label: o.name }))}
            />
          )}
        </FormField>
      ) : null}
      {loading ? (
        <SkeletonRows rows={3} label="Loading connectors" />
      ) : (
        <ConnectorPicker
          tiles={tiles}
          type={type}
          recipe={recipe}
          onPick={onPick}
          onCommit={onCommit}
          invalid={showErrors && !type}
        />
      )}
    </div>
  );
}
