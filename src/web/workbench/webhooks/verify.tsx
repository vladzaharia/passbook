import { Check, Eye, EyeOff, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import vectorFile from '../../../../docs/api/webhook-vectors.json';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import {
  firstFailure,
  runVectors,
  type VerifyStep,
  verifySteps,
  type WebhookVector,
} from '../../../shared/webhook-verify.ts';
import { StepUp } from '../../developers/ui/step-up.tsx';
import { Buddy } from '../../ui/art/buddy.tsx';
import { UnpluggedArt } from '../../ui/art/unplugged.tsx';
import { stepUpOf } from './client.ts';

const VECTORS = vectorFile.vectors as WebhookVector[];
const mask = (s: string) => `${'•'.repeat(20)}${s.slice(-4)}`;

function StepRow({ step, buddy }: { step: VerifyStep; buddy?: boolean }) {
  return (
    <div className={`wh-step${step.ok ? '' : ' bad'}`} data-step={step.id}>
      {buddy ? <Buddy mood="sad" at="end" scene="plug" prop={<UnpluggedArt size="sm" />} /> : null}
      <span className={`wh-ic ${step.ok ? 'ok' : 'bad'}`} aria-hidden="true">
        {step.ok ? <Check className="lucide" /> : <X className="lucide" />}
      </span>
      <span className="strong">
        {step.title}
        <span className="sr">{step.ok ? ': passed' : ': failed'}</span>
      </span>
      <span />
      <span className="stack g2">
        <span className="wh-sig">{step.detail}</span>
        {step.fix ? <span className="sm">{step.fix}</span> : null}
      </span>
    </div>
  );
}

/**
 * Checks the captured request in the browser: the secret never leaves the page. Pasting a body or a secret
 * of your own shows what your receiver would see.
 */
export function VerifyPanel({
  capture,
  loadSecret,
}: {
  capture: WebhookCaptureDto;
  loadSecret: () => Promise<string>;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [other, setOther] = useState('');
  const [body, setBody] = useState('');
  const [steps, setSteps] = useState<VerifyStep[] | null>(null);
  const [error, setError] = useState(false);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const [vectors, setVectors] = useState<{ passed: number; total: number } | null>(null);

  useEffect(() => {
    let live = true;
    loadSecret().then(
      (s) => live && setSecret(s),
      (e: unknown) => {
        if (!live) return;
        const asked = stepUpOf(e);
        if (asked !== null) setStepUp(asked);
        else setError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [loadSecret]);
  useEffect(() => {
    void runVectors(VECTORS).then(setVectors);
  }, []);

  const used = other.trim() === '' ? secret : other;
  const raw = body === '' ? capture.body : body;
  // At receipt: the time a receiver would have checked it.
  const now = Math.floor(capture.createdAt / 1000);
  useEffect(() => {
    if (used === null) return;
    let live = true;
    void verifySteps({ headers: capture.headers, body: raw, secrets: [used], now }).then(
      (s) => live && setSteps(s),
    );
    return () => {
      live = false;
    };
  }, [capture.headers, raw, used, now]);

  const failed = useMemo(() => (steps ? firstFailure(steps)?.step : undefined), [steps]);
  return (
    <>
      <div className="wh-pane">
        <div className="row g2 wrap-row">
          <span className="muted sm">Secret</span>
          <span className="mono sm" data-secret>
            {secret === null ? (error ? 'Not available' : '…') : shown ? secret : mask(secret)}
          </span>
          {secret !== null ? (
            <button type="button" className="btn ghost sm" onClick={() => setShown(!shown)}>
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {shown ? 'Hide' : 'Reveal'}
            </button>
          ) : null}
          <span className="xs muted push wh-hide-s">Checked here, in your browser</span>
        </div>
        {stepUp !== null ? <StepUp signInUrl={stepUp} next="/developers/webhooks" /> : null}
        <details className="wh-try">
          <summary className="sm">Check what your receiver saw</summary>
          <div className="stack g2 mt2">
            <label className="xs muted" htmlFor="wh-other">
              Another secret
            </label>
            <input
              id="wh-other"
              className="wh-field mono"
              value={other}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setOther(e.target.value)}
              placeholder="whsec_…"
            />
            <label className="xs muted" htmlFor="wh-body">
              Body as your receiver read it
            </label>
            <textarea
              id="wh-body"
              className="wh-field mono"
              rows={4}
              value={body}
              spellCheck={false}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Paste to replace the captured body"
            />
          </div>
        </details>
      </div>
      <div className="list wh-steps">
        {(steps ?? []).map((s) => (
          <StepRow key={s.id} step={s} buddy={s.id === failed} />
        ))}
        {steps ? (
          <div className="wh-step" data-step="vector">
            <span
              className={`wh-ic ${vectors && vectors.passed === vectors.total ? 'ok' : 'bad'}`}
              aria-hidden="true"
            >
              <Check className="lucide" />
            </span>
            <span className="strong">Published test vectors</span>
            <span />
            <span className="wh-sig muted">
              webhook-vectors.json · {vectors ? `${vectors.passed} of ${vectors.total} pass` : '…'}
            </span>
          </div>
        ) : (
          <p className="wh-pane muted sm">
            {error ? 'Could not read the signing secret.' : 'Checking…'}
          </p>
        )}
      </div>
    </>
  );
}
