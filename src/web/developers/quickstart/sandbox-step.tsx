import { ArrowRight, Check, Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { copyToClipboard } from '../playground/copy.ts';
import { MakeSandbox } from './make-sandbox.tsx';
import { envFile, maskKey } from './model.ts';
import { Step, type StepState, Tag } from './parts.tsx';
import type { Quickstart } from './use-quickstart.ts';

const C = QS_COPY.steps.sandbox;
const M = QS_COPY.made;
/** The key stays readable this long, or until Copy .env, whichever comes first. */
const REVEAL_MS = 60_000;

/** One thing the server made, ticked once the home says it exists. */
function Made({ done, label, line }: { done: boolean; label: string; line: string }) {
  return (
    <li className="qs-made" data-done={done}>
      <span className="qs-made-dot" aria-hidden="true">
        {done ? <Check className="lucide" /> : <LoaderCircle className="lucide qs-spin" />}
      </span>
      <strong>{label}</strong>
      <span className="muted">{done ? line : ''}</span>
    </li>
  );
}

/**
 * The key, decoded once into a `.env` box. Copy .env copies both lines and then masks it as `pbp_test_…amDQ`, as
 * does a minute of waiting. The secret is only ever text nodes of this box, never an attribute, and never stored.
 */
export function EnvBox({
  secret,
  templateId,
  onNext,
}: {
  secret: string;
  templateId: string;
  onNext: () => void;
}) {
  const [shown, setShown] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(false), REVEAL_MS);
    return () => clearTimeout(t);
  }, []);
  const copy = async () => {
    if (!(await copyToClipboard(envFile(secret, templateId)))) return;
    setCopied(true);
    setShown(false);
  };
  return (
    <div className="qs-env">
      <div className="qs-env-box">
        <div className="row g2 qs-env-h">
          <span className="mono xs muted">.env</span>
          {shown ? (
            <span className="pill warning">{M.once}</span>
          ) : (
            <span className="pill neutral">{M.masked}</span>
          )}
        </div>
        <pre className="mono qs-env-v">
          <span className="muted">PASSBOOK_KEY=</span>
          <span className="qs-env-key">{shown ? secret : maskKey(secret)}</span>
          {'\n'}
          <span className="muted">PASSBOOK_TEMPLATE_ID=</span>
          {templateId}
        </pre>
      </div>
      <div className="qs-load">
        <p className="sm">{M.load}</p>
        <dl className="qs-load-l">
          <dt className="xs muted">{M.bash}</dt>
          <dd>
            <code className="mono xs">{M.bashLine}</code>
          </dd>
          <dt className="xs muted">{M.ps}</dt>
          <dd>
            <code className="mono xs">{M.psLine}</code>
          </dd>
          <dt className="xs muted">{M.check}</dt>
          <dd>
            <code className="mono xs">{M.checkLine}</code>
            <br />
            <code className="mono xs">{M.checkPs}</code>
            <br />
            <span className="xs muted">{M.checkOut}</span>
          </dd>
        </dl>
      </div>
      <div className="row g3 wrap-row qs-env-a">
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? M.copied : M.copyEnv}
        </button>
        <button
          type="button"
          className="btn outline"
          onClick={() => {
            setShown(false);
            onNext();
          }}
        >
          {M.next}
          <ArrowRight aria-hidden="true" />
        </button>
        <span className="xs muted push">
          {M.lost} <a href={`${PATHS.home}/keys`}>{M.keys}</a>.
        </span>
      </div>
    </div>
  );
}

export function SandboxStep({
  q,
  state,
  onNext,
}: {
  q: Quickstart;
  state: StepState;
  onNext: () => void;
}) {
  const { session, sandbox, secret, templateId, home } = q;
  const made = home?.state === 'open';
  const capture = home?.endpoints.some((e) => e.target === 'capture') ?? false;
  const key = (home?.keys.length ?? 0) > 0 || secret !== null;
  return (
    <Step n={2} state={state} title={C.title} tag={<Tag>{C.tag}</Tag>}>
      {sandbox ? (
        <>
          <ul className="qs-mades">
            <Made done={made} label={M.org} line={sandbox.orgSlug} />
            <Made done={Boolean(templateId)} label={M.template} line={M.templateLine} />
            <Made done={capture} label={M.capture} line={M.captureLine} />
            <Made done={key} label={M.key} line={M.keyLine} />
          </ul>
          {secret && templateId ? (
            <EnvBox secret={secret} templateId={templateId} onNext={onNext} />
          ) : (
            <p className="xs muted qs-note">
              {M.lost} <a href={`${PATHS.home}/keys`}>{M.keys}</a>.
            </p>
          )}
        </>
      ) : session.kind === 'closed' ? (
        <p className="sm qs-bad">{C.closed}</p>
      ) : (
        <>
          <p className="sm muted">{C.line}</p>
          <MakeSandbox
            csrf={q.csrf}
            siteKey={session.kind === 'none' ? session.siteKey : ''}
            label={C.cta}
            onMade={q.sandboxMade}
            autoFocus
          />
        </>
      )}
    </Step>
  );
}
