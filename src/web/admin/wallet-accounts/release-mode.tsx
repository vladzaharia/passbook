import type { ReactNode } from 'react';
import type { WalletReleaseMode } from '@/shared/contracts/wallet-release.ts';
import { formatCount } from '@/web/lib/format.ts';
import { EmptyState, StatusPill } from '@/web/ui/index.ts';
import { checkWords } from './copy.ts';
import { CheckPill } from './credential-row.tsx';
import { ReleaseApply } from './release-apply.tsx';
import {
  blockedWords,
  RELEASE_COPY,
  STATE_TONE,
  STATE_WORDS,
  stateLine,
  templateRows,
} from './release-copy.ts';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[8.5rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-fg-strong">{children}</dd>
    </div>
  );
}

function Counts({ items }: { items: readonly (readonly [string, number])[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map(([label, n]) => (
        <li key={label} className="tabular-nums">
          <span className="text-fg-muted">{label} </span>
          {formatCount(n)}
        </li>
      ))}
    </ul>
  );
}

function Group({
  label,
  rows,
}: {
  label: string;
  rows: { id: string; name: string; why?: string }[];
}) {
  if (rows.length === 0)
    return (
      <p className="mt-2 rounded-md border border-transparent px-3 py-2 text-sm text-fg-muted">
        {label} (0)
      </p>
    );
  return (
    <details className="mt-2 rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-fg-strong">
        {label} ({formatCount(rows.length)})
      </summary>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col sm:flex-row sm:gap-2">
            <span className="text-fg-strong">{r.name}</span>
            {r.why ? <span className="text-fg-muted">{r.why}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One provider in one mode: its state, what would issue, and the enable-ready dry run. */
export function ReleaseMode({ release }: { release: WalletReleaseMode }) {
  const { provider, mode, state } = release;
  const label = mode === 'live' ? 'Live' : 'Test';
  const line = stateLine(provider, state);
  const by = (s: 'issuing' | 'ready' | 'blocked') =>
    release.enrolments.filter((e) => e.status === s);
  const row = (e: (typeof release.enrolments)[number]) => ({
    id: e.orgId,
    name: e.orgName,
    ...(e.status === 'blocked' ? { why: blockedWords(e) } : {}),
  });
  return (
    <section
      aria-label={`${label} release`}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-fg-strong">{label}</h3>
        <StatusPill status={`release_${state}`} tone={STATE_TONE[state]}>
          {STATE_WORDS[state]}
        </StatusPill>
      </header>
      {line ? <p className="text-sm text-fg-muted">{line}</p> : null}
      <dl className="flex flex-col gap-3">
        <Fact label="Credentials">
          {release.credentials.length === 0 ? (
            <span className="text-fg-muted">{RELEASE_COPY.noCredentials}</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {release.credentials.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">…{c.identityHint}</span>
                  <CheckPill credential={c} />
                  {c.lastCheck?.ok === false ? (
                    <span className="text-danger">{checkWords(c.lastCheck.code)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Fact>
        <Fact label="Organizations">
          {release.enrolments.length === 0 ? (
            <EmptyState inline art="wallet" title={RELEASE_COPY.noEnrolments} />
          ) : (
            <>
              <Group label="Issuing" rows={by('issuing').map(row)} />
              <Group label="Ready" rows={by('ready').map(row)} />
              <Group label="Blocked" rows={by('blocked').map(row)} />
            </>
          )}
        </Fact>
        <Fact label="Templates">
          <Counts
            items={templateRows.map(([key, words]) => [words, release.templates[key]] as const)}
          />
        </Fact>
        <Fact label="Wallet copies">
          <Counts
            items={[
              ['Open', release.instances.open],
              ['Retired', release.instances.retired],
            ]}
          />
        </Fact>
      </dl>
      <ReleaseApply
        provider={provider}
        mode={mode}
        modeLabel={label}
        released={state === 'released'}
      />
    </section>
  );
}
