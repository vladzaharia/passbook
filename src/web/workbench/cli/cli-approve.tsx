import { useEffect, useRef, useState } from 'react';
import { CLI_MISMATCH_WARNING, CLI_PAGE, CLI_WARNING, cliAllows } from '@/shared/copy/cli.ts';
import { ApiError } from '../../lib/errors.ts';
import { useSession } from '../../lib/session.ts';
import { isStepUp } from '../../lib/step-up.ts';
import { Button } from '../../ui/button.tsx';
import { Callout } from '../../ui/callout.tsx';
import { CARD_SURFACE } from '../../ui/card-base.tsx';
import { FormField } from '../../ui/field.tsx';
import { Input } from '../../ui/input.tsx';
import { RelTime, useNow } from '../../ui/rel-time.tsx';
import { Select } from '../../ui/select.tsx';
import { useWorkbenchContexts, type WbContext } from '../host/contexts.ts';
import { type CliReview, cliApi, keepCode, SWITCH_ACCOUNT_HREF, takeKeptCode } from './cli-api.ts';

/** Approve stays disabled this long after the details show: nothing submits on its own. */
export const ARM_MS = 3000;

/** True once `ms` have passed since `key` last changed; the seconds left tick for the label. */
function useArming(key: string, ms: number): number {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    void key;
    setLeft(ms);
    const at = Date.now() + ms;
    const timer = setInterval(() => {
      const rest = at - Date.now();
      setLeft(Math.max(rest, 0));
      if (rest <= 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [key, ms]);
  return left;
}

const messageOf = (error: unknown): string =>
  error instanceof ApiError ? error.message : CLI_PAGE.codeError;

function Review({
  review,
  code,
  csrf,
  contexts,
}: {
  review: CliReview;
  code: string;
  csrf: string | undefined;
  contexts: readonly WbContext[];
}) {
  const now = useNow(30_000);
  const [orgId, setOrgId] = useState(contexts[0]?.orgId ?? '');
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const left = useArming(review.id, ARM_MS);
  const context = contexts.find((c) => c.orgId === orgId);
  const place = [review.startCity, review.startCountry].filter(Boolean).join(', ');
  const act = async (kind: 'approved' | 'denied') => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'approved') await cliApi.approve(review.id, orgId, csrf);
      else await cliApi.deny(review.id, csrf);
      setDone(kind);
    } catch (e) {
      // The step-up sends the person through Polaris ID and back here: the typed code comes with them.
      if (isStepUp(e)) keepCode(code);
      setError(isStepUp(e) ? '' : messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <Callout tone="success">{done === 'approved' ? CLI_PAGE.approved : CLI_PAGE.denied}</Callout>
    );
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-3 text-sm">
        <div>
          <dt className="text-fg-muted">{CLI_PAGE.account}</dt>
          <dd className="text-fg-strong">
            {review.account.name}
            {review.account.email !== review.account.name ? ` · ${review.account.email}` : ''}
          </dd>
          <dd>
            <a className="text-accent underline" href={SWITCH_ACCOUNT_HREF}>
              {CLI_PAGE.notYou}
            </a>
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">{CLI_PAGE.started}</dt>
          <dd className="text-fg-strong">
            <RelTime at={review.startedAt} now={now} />{' '}
            {place ? `from ${place}` : `from ${CLI_PAGE.unknownPlace}`}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">{CLI_PAGE.device}</dt>
          <dd className="break-words font-mono text-[0.8125rem] text-fg-strong">
            {review.client.name} {review.client.version} on {review.client.os}
            {review.client.hostname ? ` (${review.client.hostname})` : ''}
          </dd>
        </div>
      </dl>
      {review.mismatch ? <Callout tone="warning">{CLI_MISMATCH_WARNING}</Callout> : null}
      {review.accountMismatch ? <Callout tone="warning">{CLI_PAGE.accountMismatch}</Callout> : null}
      {contexts.length === 0 ? (
        <Callout tone="info">{CLI_PAGE.noContext}</Callout>
      ) : (
        <FormField label={CLI_PAGE.context}>
          {(control) => (
            <Select
              {...control}
              value={orgId}
              onValueChange={setOrgId}
              options={contexts.map((c) => ({
                value: c.orgId,
                label: c.kind === 'sandbox' ? `${c.name} (sandbox)` : c.name,
              }))}
            />
          )}
        </FormField>
      )}
      {context ? <p className="text-sm text-fg-muted">{cliAllows(context.name)}</p> : null}
      <p className="text-sm text-fg">{CLI_WARNING}</p>
      {error ? <Callout tone="danger">{error}</Callout> : null}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} disabled={!context || left > 0} onClick={() => void act('approved')}>
          {left > 0 ? `${CLI_PAGE.approve} (${Math.ceil(left / 1000)})` : CLI_PAGE.approve}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void act('denied')}>
          {CLI_PAGE.deny}
        </Button>
      </div>
    </div>
  );
}

/**
 * `/workbench/cli`: the person types the code from their terminal. The code never comes from the URL (the route drops
 * `?code=` and `#code=` before this renders), so a link cannot fill it. Then the account, where the sign-in started
 * and the context, with Approve armed after 3 seconds.
 */
export function CliApprovePage() {
  const contexts = useWorkbenchContexts();
  const csrf = useSession().authed?.csrfToken;
  const list = contexts.data ?? [];
  const [typed, setTyped] = useState(() => takeKeptCode());
  const [review, setReview] = useState<CliReview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const look = async (code: string) => {
    setBusy(true);
    setError('');
    try {
      setReview(await cliApi.lookup(code, csrf));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  // A code kept across the step-up's round trip is looked up again, once.
  const first = useRef(typed);
  const lookRef = useRef(look);
  lookRef.current = look;
  useEffect(() => {
    if (first.current) void lookRef.current(first.current);
  }, []);
  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-8">
      <h1 className="text-xl font-semibold text-fg-strong">{CLI_PAGE.title}</h1>
      <section className={`flex flex-col gap-4 p-4 ${CARD_SURFACE}`} aria-label={CLI_PAGE.title}>
        {review ? (
          <Review review={review} code={typed} csrf={csrf} contexts={list} />
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void look(typed);
            }}
          >
            <FormField label={CLI_PAGE.code} error={error}>
              {(control) => (
                <Input
                  {...control}
                  ref={input}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value.toUpperCase())}
                  maxLength={12}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="XXXX-XXXX"
                  className="font-mono tracking-widest"
                />
              )}
            </FormField>
            <div>
              <Button type="submit" loading={busy} disabled={!typed.trim()}>
                {CLI_PAGE.next}
              </Button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
