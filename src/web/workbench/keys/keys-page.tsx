import { ExternalLink, Plus, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { BENCH_KEYS_COPY as BK } from '../../../shared/copy/developers-bench-keys.ts';
import { KEYS_COPY as C } from '../../../shared/copy/developers-keys.ts';
import { envLine } from '../../../shared/developers-keys.ts';
import { type Revealed, RevealSheet } from '../../developers/ui/reveal-sheet.tsx';
import { useMediaQuery } from '../../lib/media.ts';
import { BenchSlot } from '../bench/slots.tsx';
import { BENCH_WIDE, BenchSplit } from '../bench/split.tsx';
import { BenchState } from '../bench/state.tsx';
import { SearchField, Toolbar } from '../bench/toolbar.tsx';
import { selectedId } from '../bench/url.ts';
import { useBenchFilters } from '../bench/use-filters.ts';
import { useBenchSelection } from '../bench/use-selection.ts';
import { fetchHome } from '../home/api.ts';
import { type KeyApi, keyApi } from './api.ts';
import { KeyInspector } from './key-inspector.tsx';
import { KeyList } from './key-list.tsx';
import { matches } from './model.ts';
import { NewKeySheet } from './new-key-sheet.tsx';
import { ConfirmKeySheet } from './roll-sheet.tsx';

const idOf = (k: { id: string }) => k.id;

/** A key list longer than this gets a search. */
const SEARCH_OVER = 8;

type Panel =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'confirm'; action: 'roll' | 'revoke'; id: string; name: string }
  | { kind: 'reveal'; revealed: Revealed };

export function KeysPage({
  initial,
  csrf,
  api = keyApi(csrf),
  now = Date.now,
}: {
  initial: DeveloperHome;
  csrf: string;
  api?: KeyApi;
  now?: () => number;
}) {
  const [home, setHome] = useState(initial);
  // `#new` opens the sheet; any other hash is a key to select.
  const [panel, setPanel] = useState<Panel>(() =>
    selectedId() === 'new' ? { kind: 'new' } : { kind: 'none' },
  );
  const [loadError, setLoadError] = useState(false);
  // The island mounts the page only with a sandbox (state is not none).
  const orgId = home.sandbox?.orgId ?? '';
  const cap = home.sandbox?.limits.keys ?? null;
  const closed = home.state === 'closed';
  const at = now();
  const full = cap !== null && home.keys.length >= cap;
  const wide = useMediaQuery(BENCH_WIDE);

  const filters = useBenchFilters(['q'], { search: 'q' });
  const q = filters.values.q ?? '';
  const showSearch = home.keys.length > SEARCH_OVER || q !== '';
  const shown = useMemo(() => (q ? home.keys.filter((k) => matches(k, q)) : home.keys), [home, q]);
  const selection = useBenchSelection({ items: shown, idOf });
  const { selectedId: picked, selected, select } = selection;

  const refresh = useCallback(async () => {
    try {
      setHome(await fetchHome());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  // `#new` is a sheet, not a selection: the address drops it.
  useEffect(() => {
    if (picked === 'new') select(null);
  }, [picked, select]);
  // Beside the list the pane is never empty: the first key stands in until one is picked.
  useEffect(() => {
    const first = shown[0];
    if (wide && !selected && picked !== 'new' && first) select(first.id, { open: false });
  }, [wide, selected, picked, shown, select]);
  const closePanel = () => {
    setPanel({ kind: 'none' });
  };

  const k = selected;
  const index = k ? shown.findIndex((x) => x.id === k.id) : -1;
  const inspector = k ? (
    <KeyInspector
      k={k}
      now={at}
      onRoll={() => setPanel({ kind: 'confirm', action: 'roll', id: k.id, name: k.name })}
      onRevoke={() => setPanel({ kind: 'confirm', action: 'revoke', id: k.id, name: k.name })}
      onPrev={index > 0 ? () => selection.step(-1) : undefined}
      onNext={index >= 0 && index < shown.length - 1 ? () => selection.step(1) : undefined}
    />
  ) : null;

  const empty =
    home.keys.length === 0 ? (
      <BenchState scene="keys-none">
        {closed ? null : (
          <button type="button" className="btn" onClick={() => setPanel({ kind: 'new' })}>
            <Plus aria-hidden="true" />
            {C.newKey}
          </button>
        )}
      </BenchState>
    ) : (
      <BenchState scene="no-match" heading="h2">
        <button type="button" className="btn outline" onClick={() => filters.set('q', null)}>
          {BENCH_COPY.state.clearFilters}
        </button>
      </BenchState>
    );

  return (
    <div className="ks">
      <BenchSlot name="count">{C.count(home.keys.length)}</BenchSlot>
      {closed ? null : (
        <BenchSlot name="action">
          <button
            type="button"
            className="btn sm"
            disabled={full}
            title={full ? C.limit : undefined}
            onClick={() => setPanel({ kind: 'new' })}
          >
            <Plus aria-hidden="true" />
            {C.newKey}
          </button>
        </BenchSlot>
      )}
      {showSearch ? (
        <Toolbar label={BK.filter}>
          <SearchField label={BK.search} value={q} onChange={(v) => filters.set('q', v || null)} />
        </Toolbar>
      ) : null}
      {loadError ? (
        <BenchState scene="failed" title={C.failed} onRetry={() => void refresh()} />
      ) : null}
      {home.keys.length === 0 ? (
        empty
      ) : (
        <BenchSplit
          label={BK.list}
          bare
          open={selection.open && k !== null}
          onClose={() => selection.setOpen(false)}
          main={
            <KeyList
              keys={shown}
              all={home.keys.length}
              now={at}
              selection={selection}
              empty={empty}
            />
          }
          pane={inspector}
        />
      )}
      <section className="card ks-live" aria-labelledby="ks-live-h">
        <span className="ks-live-i" aria-hidden="true">
          <Zap />
        </span>
        <div className="stack g1 ks-live-t">
          <h2 id="ks-live-h" className="h3">
            {C.live.title}
          </h2>
          <p className="sm muted">
            {home.liveOrgs.some((o) => o.canMintLive) ? C.live.line : C.live.none}
          </p>
        </div>
        <div className="wrap-row g2">
          {home.liveOrgs
            .filter((o) => o.canMintLive)
            .map((o) => (
              <a key={o.orgId} className="btn sm outline" href={`/admin/o/${o.orgId}/api-keys`}>
                {o.name}
                <ExternalLink aria-hidden="true" />
              </a>
            ))}
        </div>
      </section>
      {panel.kind === 'new' ? (
        <NewKeySheet
          orgId={orgId}
          api={api}
          onClose={closePanel}
          onMade={(key) => {
            const { secret, ...rest } = key;
            setPanel({
              kind: 'reveal',
              revealed: { name: rest.name, secret: secret ?? null, scopes: rest.scopes },
            });
            void refresh();
          }}
        />
      ) : null}
      {panel.kind === 'confirm' ? (
        <ConfirmKeySheet
          action={panel.action}
          keyId={panel.id}
          name={panel.name}
          orgId={orgId}
          api={api}
          onClose={closePanel}
          onRevoked={() => {
            closePanel();
            select(null);
            void refresh();
          }}
          onRolled={({ key, previous }) => {
            setPanel({
              kind: 'reveal',
              revealed: {
                name: key.name,
                secret: 'secret' in key && typeof key.secret === 'string' ? key.secret : null,
                scopes: key.scopes,
                stopsAt: previous.retireAt ?? at,
              },
            });
            void refresh();
          }}
        />
      ) : null}
      {panel.kind === 'reveal' ? (
        <RevealSheet
          revealed={panel.revealed}
          labels={C.reveal}
          prefix="PASSBOOK_KEY="
          copyAs={envLine}
          onDone={closePanel}
          // The sheet holds the only copy from here on.
          onHide={() =>
            setPanel((p) =>
              p.kind === 'reveal'
                ? { kind: 'reveal', revealed: { ...p.revealed, secret: null } }
                : p,
            )
          }
          now={now}
        />
      ) : null}
    </div>
  );
}
