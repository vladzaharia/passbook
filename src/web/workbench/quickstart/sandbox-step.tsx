import { ArrowRight, Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { useClaimOperation, useOperation, useOperationParam } from '../../ui/operation/index.ts';
import { mintKey } from '../console/sandbox-actions.ts';
import { copyToClipboard } from '../playground/copy.ts';
import { CreatePanel, MakeSandbox } from './make-sandbox.tsx';
import { envFile, maskKey } from './model.ts';
import { Step, type StepState, Tag } from './parts.tsx';
import { SandboxManage } from './sandbox-manage.tsx';
import type { Quickstart } from './use-quickstart.ts';

const C = QS_COPY.steps.sandbox;
const M = QS_COPY.made;
/** The key stays readable this long, or until Copy .env, whichever comes first. */
const REVEAL_MS = 60_000;

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
          {M.lost} <a href={PATHS.keys}>{M.keys}</a>.
        </span>
      </div>
    </div>
  );
}

/** "Show key": the key of a sandbox whose key was never minted (the person left before the operation ended). */
function ShowKey({ q }: { q: Quickstart }) {
  const [state, setState] = useState<'idle' | 'working' | 'gone' | 'failed'>('idle');
  const { sandbox } = q;
  if (!sandbox) return null;
  const show = async () => {
    setState('working');
    try {
      const secret = await mintKey(q.csrf);
      if (secret) q.sandboxMade(sandbox, secret);
      else setState('gone');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="qs-note">
      <button
        type="button"
        className="btn"
        disabled={state === 'working'}
        aria-busy={state === 'working'}
        onClick={() => void show()}
      >
        {C.showKey}
      </button>
      {state === 'gone' ? <p className="xs muted">{C.keyGone}</p> : null}
      {state === 'failed' ? (
        <p className="xs qs-bad" role="alert">
          {C.keyFailed}
        </p>
      ) : null}
    </div>
  );
}

function Body({ q, state, onNext }: { q: Quickstart; state: StepState; onNext: () => void }) {
  const { session, sandbox, secret, templateId, home } = q;
  const [opId, setOpId] = useOperationParam();
  // The panel owns `?op` while it shows: the tray opens no sheet for an id this page claimed.
  useClaimOperation(opId);
  const { operation } = useOperation(opId);
  // The operation `?op=` names: a create shows here, a delete or start over in the confirm below.
  const making = opId && (!operation || operation.kind === 'sandbox.create') ? opId : null;
  const managing =
    opId && operation && operation.kind !== 'sandbox.create' && operation.kind !== 'sandbox.reset'
      ? opId
      : null;
  const capture = home?.endpoints.some((e) => e.target === 'capture') ?? false;
  const keyMade = (home?.keys.length ?? 0) > 0;
  // The home has been read and the server did not finish: a spinner would never end, so offer the retry
  // (the server completes what is missing).
  const stuck =
    sandbox !== null &&
    home !== null &&
    home.state === 'open' &&
    !(capture && templateId) &&
    !making &&
    !managing;
  const retryKey = session.kind === 'ready' || session.kind === 'none' ? session.siteKey : '';
  return (
    <Step n={2} state={state} title={C.title} tag={<Tag>{C.tag}</Tag>}>
      {sandbox ? (
        <>
          {making ? (
            <CreatePanel csrf={q.csrf} id={making} onMade={q.sandboxMade} onOp={setOpId} />
          ) : null}
          {stuck ? (
            <div className="qs-stuck">
              <p className="sm qs-bad" role="alert">
                {M.stuck}
              </p>
              <MakeSandbox
                csrf={q.csrf}
                siteKey={retryKey}
                label={M.retry}
                onMade={q.sandboxMade}
                op={null}
                onOp={setOpId}
              />
            </div>
          ) : null}
          <SandboxManage
            csrf={q.csrf}
            siteKey={retryKey}
            onMade={q.sandboxMade}
            op={managing}
            onOp={setOpId}
          />
          {making || managing ? null : secret && templateId ? (
            <EnvBox secret={secret} templateId={templateId} onNext={onNext} />
          ) : !keyMade && home !== null && !stuck ? (
            <ShowKey q={q} />
          ) : (
            <p className="xs muted qs-note">
              {M.lost} <a href={PATHS.keys}>{M.keys}</a>.
            </p>
          )}
        </>
      ) : session.kind === 'closed' ? (
        <>
          <p className="sm qs-bad">{C.closed}</p>
          <SandboxManage
            csrf={q.csrf}
            siteKey={session.kind === 'closed' ? session.siteKey : ''}
            onMade={q.sandboxMade}
            op={managing}
            onOp={setOpId}
          />
        </>
      ) : managing ? (
        // The sandbox is gone (the delete's first half is done): the operation that removed it is what is left.
        <SandboxManage
          csrf={q.csrf}
          siteKey={retryKey}
          onMade={q.sandboxMade}
          op={managing}
          onOp={setOpId}
          buttons={false}
        />
      ) : (
        <>
          <p className="sm muted">{C.line}</p>
          <MakeSandbox
            csrf={q.csrf}
            siteKey={session.kind === 'none' ? session.siteKey : ''}
            label={C.cta}
            onMade={q.sandboxMade}
            op={making}
            onOp={setOpId}
            autoFocus
          />
        </>
      )}
    </Step>
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
  return <Body q={q} state={state} onNext={onNext} />;
}
