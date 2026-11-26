import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import type { CodeLang } from '../playground/hash.ts';
import { Seg } from '../playground/seg.tsx';
import { CodeBlock } from './code-block.tsx';
import { ADMISSIONS, patchCode } from './model.ts';
import { Step, type StepState } from './parts.tsx';
import { RunBar } from './run-bar.tsx';
import type { Quickstart } from './use-quickstart.ts';

const C = QS_COPY.steps.change;
const apiBase = () => `${location.origin}/api/v1`;
const CHIPS: { value: string; label: string }[] = ADMISSIONS.map((value) => ({
  value,
  label: value,
}));

/** Change it: pick an admission, send the PATCH with If-Match, and the field changes on every preview. */
export function ChangeStep({
  q,
  lang,
  onLang,
  state,
  admission,
  onAdmission,
}: {
  q: Quickstart;
  lang: CodeLang;
  onLang: (l: CodeLang) => void;
  state: StepState;
  admission: string;
  onAdmission: (s: string) => void;
}) {
  const { pass, change } = q;
  const codes = pass ? patchCode(pass.id, pass.version, admission, apiBase()) : [];
  return (
    <Step n={4} state={state} title={C.title}>
      <p className="sm muted">
        {C.line} <code className="inline-code">PATCH /api/v1/passes/{'{id}'}</code> {C.line2}
      </p>
      {pass ? (
        <>
          <Seg
            label={C.field}
            value={admission}
            options={CHIPS}
            onChange={onAdmission}
            className="qs-chips"
          />
          <div className="qs-ticket">
            <CodeBlock
              codes={codes}
              lang={lang}
              onLang={onLang}
              name="Update pass"
              lit={['admission', 'If-Match']}
              base="update"
            />
            <RunBar
              call={change}
              sending={C.sending}
              runLabel={C.update}
              againLabel={C.update}
              disabled={false}
              onRun={() => void q.update(admission)}
            />
          </div>
        </>
      ) : (
        <p className="xs muted">{C.locked}</p>
      )}
    </Step>
  );
}
