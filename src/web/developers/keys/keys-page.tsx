import { ExternalLink, MoreHorizontal, Plus, RefreshCw, Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';
import { KEYS_COPY as C } from '../../../shared/copy/developers-keys.ts';
import { envLine } from '../../../shared/developers-keys.ts';
import { BenchSlot } from '../bench/slots.tsx';
import { selectInUrl } from '../bench/url.ts';
import { type Revealed, RevealSheet } from '../ui/reveal-sheet.tsx';
import { fetchHome } from '../workbench/api.ts';
import { keyState, masked } from '../workbench/model.ts';
import { type KeyApi, keyApi } from './api.ts';
import { accessOf, expiryOf, usedOf } from './model.ts';
import { NewKeySheet } from './new-key-sheet.tsx';
import { ConfirmKeySheet } from './roll-sheet.tsx';

type Panel =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'confirm'; action: 'roll' | 'revoke'; id: string; name: string }
  | { kind: 'reveal'; revealed: Revealed };

/** The panel the page address asks for: `#new`, or `#<key id>` to roll that key. */
function fromHash(hash: string, home: DeveloperHome, now: number): Panel {
  const id = hash.replace(/^#/, '');
  if (id === 'new') return { kind: 'new' };
  const key = home.keys.find((k) => k.id === id);
  return key && keyState(key, now) === 'active'
    ? { kind: 'confirm', action: 'roll', id, name: key.name }
    : { kind: 'none' };
}

export function KeysPage({
  initial,
  csrf,
  api = keyApi(csrf),
  now = Date.now,
  hash = '',
}: {
  initial: DeveloperHome;
  csrf: string;
  api?: KeyApi;
  now?: () => number;
  hash?: string;
}) {
  const [home, setHome] = useState(initial);
  const [panel, setPanel] = useState<Panel>(() => fromHash(hash, initial, now()));
  const [loadError, setLoadError] = useState(false);
  // The island mounts the page only with a sandbox (state is not none).
  const orgId = home.sandbox?.orgId ?? '';
  const cap = home.sandbox?.limits.keys ?? null;
  const closed = home.state === 'closed';
  const at = now();
  const full = cap !== null && home.keys.length >= cap;

  const refresh = useCallback(async () => {
    try {
      setHome(await fetchHome());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  // The address drops #new or #<key id> once the panel closes.
  useEffect(() => {
    if (panel.kind === 'none') selectInUrl(null);
  }, [panel.kind]);

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
      {loadError ? (
        <p className="sm muted">
          {C.failed}{' '}
          <button type="button" className="btn sm outline" onClick={() => void refresh()}>
            {C.retry}
          </button>
        </p>
      ) : null}
      <section className="card" aria-label={C.title}>
        {home.keys.length === 0 ? (
          <p className="card-b sm muted">{closed ? C.closed : C.empty}</p>
        ) : (
          <table className="ks-table">
            <thead>
              <tr className="ks-row ks-th">
                {[C.columns.key, C.columns.access, C.columns.expires, C.columns.used].map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {home.keys.map((k) => {
                const state = keyState(k, at);
                return (
                  <tr key={k.id} id={k.id} className="ks-row">
                    <td className="ks-key">
                      <span className="stack g1">
                        <span className="strong sm">{k.name}</span>
                        <code className="xs muted">{masked(k)}</code>
                      </span>
                    </td>
                    <td className="sm" data-label={C.columns.access}>
                      {accessOf(k)}
                    </td>
                    <td className="sm" data-label={C.columns.expires}>
                      {expiryOf(k, at)}
                    </td>
                    <td className="sm" data-label={C.columns.used}>
                      {usedOf(k, at)}
                    </td>
                    <td className="ks-acts">
                      {state === 'active' ? (
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() =>
                            setPanel({ kind: 'confirm', action: 'roll', id: k.id, name: k.name })
                          }
                        >
                          <RefreshCw aria-hidden="true" />
                          {C.roll}
                        </button>
                      ) : (
                        <span className="pill neutral">
                          {state === 'rolling' ? C.rolling : C.expired}
                        </span>
                      )}
                      <details className="ks-more">
                        <summary aria-label={`${C.more}: ${k.name}`}>
                          <MoreHorizontal aria-hidden="true" />
                        </summary>
                        <button
                          type="button"
                          className="btn sm outline"
                          onClick={() =>
                            setPanel({ kind: 'confirm', action: 'revoke', id: k.id, name: k.name })
                          }
                        >
                          {C.revoke}
                        </button>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
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
          onClose={() => setPanel({ kind: 'none' })}
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
          onClose={() => setPanel({ kind: 'none' })}
          onRevoked={() => {
            setPanel({ kind: 'none' });
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
          onDone={() => setPanel({ kind: 'none' })}
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
