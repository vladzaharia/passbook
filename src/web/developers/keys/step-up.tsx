import { useEffect, useRef } from 'react';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';

/** The server asked for a recent sign-in: one link to Polaris ID that returns to the Keys page. */
export function StepUp({ signInUrl, next }: { signInUrl: string; next: string }) {
  const url = new URL(
    signInUrl || '/auth/oidc/start?prompt=login&max_age=0',
    'http://step-up.invalid',
  );
  url.searchParams.set('next', next);
  const c = KEYS_COPY.stepUp;
  const box = useRef<HTMLDivElement>(null);
  // It appears below the fold of a short sheet: bring it into view.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div ref={box} className="ks-stepup" role="alert">
      <span className="stack g1">
        <span className="strong sm">{c.title}</span>
        <span className="xs muted">{c.line}</span>
      </span>
      <a className="btn sm" href={`${url.pathname}${url.search}`}>
        {c.go}
      </a>
    </div>
  );
}
