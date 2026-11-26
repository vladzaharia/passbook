import { Inbox, Link2 } from 'lucide-react';
import type {
  DeveloperHomeEndpoint,
  DeveloperHomeKey,
  DeveloperHomePass,
  DeveloperLiveOrg,
} from '../../../shared/contracts/developer-home.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { BENCH_HOME_COPY as H } from '../../../shared/copy/developers-bench-home.ts';
import { ROLE_LABELS } from '../../admin/orgs/org-roles.ts';
import { IdChip } from '../bench/id-chip.tsx';
import { StatusChip } from '../bench/status-chip.tsx';
import { BenchTime } from '../bench/time.tsx';
import { hostOf, keyState, masked } from './model.ts';

const KEY_STATE = {
  active: null,
  rolling: { text: H.states.rolling, tone: 'neutral' },
  expired: { text: H.states.expired, tone: 'warning' },
} as const;

export function Keys({
  keys,
  now,
  href,
  closed,
}: {
  keys: DeveloperHomeKey[];
  now: number;
  href: string;
  closed: boolean;
}) {
  return (
    <section className="card wb-keys" aria-labelledby="wb-keys-h">
      <div className="card-h">
        <h2 id="wb-keys-h" className="h3">
          Keys
        </h2>
        {closed ? null : (
          <a className="xs wb-more" href={href}>
            Manage
          </a>
        )}
      </div>
      {keys.length === 0 ? (
        <p className="card-b sm muted">
          {closed ? 'Keys stopped when the sandbox closed.' : 'No keys. Make one in Keys.'}
        </p>
      ) : (
        <div className="list">
          {keys.map((k) => {
            const state = KEY_STATE[keyState(k, now)];
            return (
              <div key={k.id} className="lrow wb-key">
                <span className="stack g1 wb-key-main">
                  <a className="strong sm wb-key-name" href={`${href}#${encodeURIComponent(k.id)}`}>
                    {k.name}
                  </a>
                  <IdChip id={k.id} kind="key" text={masked(k)} />
                  <span className="xs muted">
                    {k.lastUsedAt !== null ? (
                      <>
                        {H.key.used} <BenchTime at={k.lastUsedAt} now={now} mode="ago" />
                      </>
                    ) : (
                      H.key.unused
                    )}
                    {k.expiresAt !== null && k.expiresAt > now ? (
                      <>
                        {' · '}
                        {H.key.expires} <BenchTime at={k.expiresAt} now={now} mode="until" />
                      </>
                    ) : null}
                  </span>
                </span>
                {state ? <StatusChip tone={state.tone}>{state.text}</StatusChip> : null}
                <a className="btn sm outline" href={`${href}#${encodeURIComponent(k.id)}`}>
                  Roll
                </a>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The three latest previews, fanned. Each opens its TEST preview page. */
export function Passes({ passes }: { passes: DeveloperHomePass[] }) {
  return (
    <section className="card wb-passes" aria-labelledby="wb-passes-h">
      <div className="card-h">
        <h2 id="wb-passes-h" className="h3">
          Passes
        </h2>
      </div>
      {passes.length === 0 ? (
        <p className="card-b sm muted">No passes yet.</p>
      ) : (
        <div className="wb-fan" data-n={passes.length}>
          {passes.map((p) => (
            <a
              key={p.id}
              className="wb-pass"
              href={p.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="wb-pass-test mono">TEST</span>
              <span className="strong sm wb-pass-title">{p.title ?? 'Untitled pass'}</span>
              {p.subtitle ? <span className="xs muted">{p.subtitle}</span> : null}
              <span className="xs muted mono wb-pass-v">v{p.version}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function EndpointRow({ e, now, href }: { e: DeveloperHomeEndpoint; now: number; href: string }) {
  const capture = e.target === 'capture';
  return (
    <a className="lrow wb-ep" href={`${href}?endpoint=${encodeURIComponent(e.id)}`}>
      {capture ? (
        <Inbox aria-hidden className="wb-ep-icon" />
      ) : (
        <Link2 aria-hidden className="wb-ep-icon" />
      )}
      <span className="stack g1 wb-ep-main">
        <span className="strong sm">{capture ? 'Capture' : hostOf(e.url ?? '')}</span>
        <span className="xs muted">
          {capture
            ? 'Stored here, never sent'
            : `${e.eventTypes.length} event ${e.eventTypes.length === 1 ? 'type' : 'types'}`}
        </span>
      </span>
      {e.status !== 'active' ? (
        <StatusChip tone="neutral">
          {e.status === 'paused' ? H.states.paused : H.states.disabled}
        </StatusChip>
      ) : null}
      {e.lastAt === null ? (
        <span className="wb-ep-last xs muted">{H.hook.none}</span>
      ) : (
        <span className="wb-ep-last xs muted">
          <StatusChip tone={e.lastOk ? 'success' : 'danger'}>
            {e.lastOk ? H.hook.ok : H.hook.failed}
          </StatusChip>{' '}
          <BenchTime at={e.lastAt} now={now} mode="ago" />
        </span>
      )}
    </a>
  );
}

export function Webhooks({
  endpoints,
  now,
  href,
}: {
  endpoints: DeveloperHomeEndpoint[];
  now: number;
  href: string;
}) {
  return (
    <section className="card wb-hooks" aria-labelledby="wb-hooks-h">
      <div className="card-h">
        <h2 id="wb-hooks-h" className="h3">
          Webhooks
        </h2>
        <a className="xs wb-more" href={href}>
          Open
        </a>
      </div>
      {endpoints.length === 0 ? (
        <p className="card-b sm muted">No endpoints.</p>
      ) : (
        <div className="list">
          {endpoints.map((e) => (
            <EndpointRow key={e.id} e={e} now={now} href={href} />
          ))}
        </div>
      )}
    </section>
  );
}

const roleOf = (roles: OrgRole[]) => roles.map((r) => ROLE_LABELS[r]).join(', ');

/** Where a Live key comes from: the person's real orgs, each linking to its Admin API keys. */
export function GoLive({
  orgs,
  admin,
}: {
  orgs: DeveloperLiveOrg[];
  admin: (orgId: string) => string;
}) {
  return (
    <section className="card wb-live" aria-labelledby="wb-live-h">
      <div className="card-h">
        <h2 id="wb-live-h" className="h3">
          Go live
        </h2>
      </div>
      {orgs.length === 0 ? (
        <div className="card-b">
          <a className="btn outline sm" href="/admin">
            Open Admin
          </a>
        </div>
      ) : (
        <div className="list">
          {orgs.map((o) => (
            <div key={o.orgId} className="lrow">
              <span className="stack g1 wb-ep-main">
                <span className="strong sm">{o.name}</span>
                <span className="xs muted">{roleOf(o.roles)}</span>
              </span>
              {o.canMintLive ? (
                <a className="btn sm outline" href={admin(o.orgId)}>
                  Live key
                </a>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
