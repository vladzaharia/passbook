import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import type { CodeLang } from '../playground/hash.ts';
import { CodeBlock } from './code-block.tsx';
import { CopyRow } from './copy-row.tsx';
import { MakeSandbox } from './make-sandbox.tsx';
import { ADMISSIONS, createCode, envFile, maskKey, patchCode } from './model.ts';
import { Step, type StepState, Tag } from './parts.tsx';
import { RunBar } from './run-bar.tsx';
import type { Quickstart } from './use-quickstart.ts';

const C = QS_COPY.steps;
const apiBase = () => `${location.origin}/api/v1`;

interface Shared {
  q: Quickstart;
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  state: StepState;
}

export function SandboxStep({ q, state }: Pick<Shared, 'q' | 'state'>) {
  const { session, sandbox, secret, templateId } = q;
  return (
    <Step n={2} state={state} title={C.sandbox.title} tag={<Tag>{C.sandbox.tag}</Tag>}>
      {sandbox ? (
        secret && templateId ? (
          <>
            <CopyRow
              label=".env"
              text={`PASSBOOK_KEY=${maskKey(secret)}`}
              value={envFile(secret, templateId)}
            />
            <p className="xs muted qs-note">{C.sandbox.keyOnce}</p>
          </>
        ) : (
          <p className="sm muted">{secret ? C.sandbox.keyOnce : C.sandbox.keyGone}</p>
        )
      ) : session.kind === 'closed' ? (
        <p className="sm qs-bad">{C.sandbox.closed}</p>
      ) : (
        <>
          <p className="sm muted">{C.sandbox.line}</p>
          <MakeSandbox
            csrf={q.csrf}
            siteKey={session.kind === 'none' ? session.siteKey : ''}
            label={C.sandbox.cta}
            onMade={q.sandboxMade}
            autoFocus
          />
        </>
      )}
    </Step>
  );
}

export function RunStep({ q, lang, onLang, state }: Shared) {
  const { templateId, input, run } = q;
  const ready = Boolean(q.sandbox && templateId && input);
  const codes = templateId && input ? createCode(templateId, input, apiBase()) : [];
  return (
    <Step n={3} state={state} title={C.run.title}>
      <p className="sm muted">
        {C.run.line} <code className="inline-code">{q.template?.name ?? 'Quickstart ticket'}</code>.{' '}
        {C.run.line2}
      </p>
      <div className="qs-ticket">
        {codes.length > 0 ? (
          <CodeBlock
            codes={codes}
            lang={lang}
            onLang={onLang}
            lit={['input', 'attendee', 'ticketId']}
            base="create"
          />
        ) : (
          <div className="code qs-code qs-code-ghost" aria-hidden="true">
            <div className="bars">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        <RunBar
          call={run}
          sending={C.run.sending}
          runLabel={C.run.run}
          againLabel={C.run.again}
          disabled={!ready}
          onRun={() => void q.create()}
          replayNote={C.run.replayed}
        />
      </div>
    </Step>
  );
}

export function ChangeStep({
  q,
  lang,
  onLang,
  state,
  admission,
  onAdmission,
}: Shared & { admission: string; onAdmission: (s: string) => void }) {
  const { pass, change } = q;
  const codes = pass ? patchCode(pass.id, pass.version, admission || ADMISSIONS[0], apiBase()) : [];
  return (
    <Step n={4} state={state} title={C.change.title}>
      <p className="sm muted">
        {C.change.line} <code className="inline-code">PATCH /api/v1/passes/{'{id}'}</code>{' '}
        {C.change.line2}
      </p>
      {pass ? (
        <div className="qs-ticket">
          <div className="qs-admission">
            <label className="xs muted" htmlFor="qs-admission">
              {C.change.field}
            </label>
            <input
              id="qs-admission"
              className="qs-input mono"
              value={admission}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              list="qs-admissions"
              onChange={(e) => onAdmission(e.target.value)}
            />
            <datalist id="qs-admissions">
              {ADMISSIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <CodeBlock
            codes={codes}
            lang={lang}
            onLang={onLang}
            lit={['admission', 'If-Match']}
            base="update"
          />
          <RunBar
            call={change}
            sending={C.change.sending}
            runLabel={C.change.update}
            againLabel={C.change.update}
            disabled={admission.trim() === ''}
            onRun={() => void q.update(admission.trim())}
          />
        </div>
      ) : (
        <p className="xs muted">{C.change.locked}</p>
      )}
    </Step>
  );
}

export function HomeStep({
  q,
  lang,
  state,
  elapsed,
  onHome,
}: Pick<Shared, 'q' | 'lang' | 'state'> & { elapsed: string; onHome: () => void }) {
  const { pass, templateId, secret, input } = q;
  const file =
    templateId && input
      ? createCode(templateId, input, apiBase()).find((c) => c.lang === lang)
      : undefined;
  return (
    <Step n={5} state={state} title={C.home.title}>
      <p className="sm muted">{C.home.line}</p>
      {pass && templateId ? (
        <div className="qs-home">
          {secret ? (
            <CopyRow
              label={C.home.env}
              text="PASSBOOK_KEY, PASSBOOK_TEMPLATE_ID"
              value={envFile(secret, templateId)}
              onCopied={onHome}
            />
          ) : (
            <CopyRow
              label={C.home.env}
              text="PASSBOOK_TEMPLATE_ID"
              value={envFile(null, templateId)}
              onCopied={onHome}
            />
          )}
          {secret ? null : <p className="xs muted qs-note">{C.home.noKey}</p>}
          <CopyRow
            label={C.home.install}
            text="npm i @passbook/sdk"
            value="npm i @passbook/sdk"
            onCopied={onHome}
          />
          {file ? (
            <CopyRow
              label={C.home.file}
              text={`${file.label} · ${file.code.split('\n').length} lines`}
              value={file.code}
              onCopied={onHome}
            />
          ) : null}
          {state === 'done' ? (
            <p className="qs-finish" role="status">
              <strong>{QS_COPY.doneIn(elapsed)}</strong> <a href={PATHS.guides}>{C.home.next}</a>
            </p>
          ) : null}
        </div>
      ) : null}
    </Step>
  );
}
