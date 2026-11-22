import { Copy, FlaskConical, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyToClipboard } from './copy.ts';
import { Fields } from './fields.tsx';
import type { InputMode } from './hash.ts';
import { JsonEditor } from './json-editor.tsx';
import type { Created } from './live.ts';
import type { InputValues } from './model.ts';
import { Seg } from './seg.tsx';
import type { PgTemplate } from './templates.ts';
import type { Link } from './use-playground.ts';

const SIGN_IN_COPY = 'Edit in my sandbox';

export function InputsPanel(props: {
  template: PgTemplate;
  templates: PgTemplate[];
  values: InputValues;
  edited: boolean;
  mode: InputMode;
  link: Link;
  created: Created | null;
  problem: string | null;
  onMode: (mode: InputMode) => void;
  onPick: (id: string) => void;
  onValues: (values: InputValues) => void;
  onReset: () => void;
  onAttach: () => void;
  onCreate: () => void;
}) {
  const { template, templates, values, mode, link } = props;
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const own = templates.filter((t) => t.issuable);
  const starters = templates.filter((t) => !t.issuable);
  const copyLink = async () => {
    if (!(await copyToClipboard(location.href))) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <section className="edit" aria-label="Inputs">
      <div className="edit-body">
        <div className="row g2">
          <h1 className="h2">Playground</h1>
          <span className="pill info push">
            <FlaskConical aria-hidden="true" />
            Test previews
          </span>
        </div>
        <div className="field">
          <label htmlFor="pg-template">Template</label>
          <select
            id="pg-template"
            className="input sel"
            value={template.id}
            onChange={(e) => props.onPick(e.target.value)}
          >
            {own.length > 0 ? (
              <optgroup label="Your sandbox">
                {own.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Blueprints">
              {starters.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="help">{template.hint}</span>
        </div>
        <div className="row">
          <Seg
            label="Input"
            value={mode}
            onChange={props.onMode}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'json', label: 'JSON' },
            ]}
          />
          <button
            type="button"
            className="btn ghost sm push"
            onClick={props.onReset}
            disabled={!props.edited}
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </button>
        </div>
        {mode === 'form' ? (
          <Fields
            schema={template.inputs}
            values={values}
            sample={template.sample}
            onChange={(name, v) => props.onValues({ ...values, [name]: v })}
          />
        ) : (
          <JsonEditor values={values} onValues={props.onValues} />
        )}
      </div>
      <div className="edit-actions stack g2">
        {link.kind === 'live' ? (
          <button
            type="button"
            className="btn"
            disabled={!template.issuable}
            onClick={props.onCreate}
          >
            <Plus aria-hidden="true" />
            Create test pass
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={link.kind === 'connecting'}
            onClick={props.onAttach}
          >
            <Plus aria-hidden="true" />
            {SIGN_IN_COPY}
          </button>
        )}
        {link.kind === 'live' && !template.issuable ? (
          <span className="help">
            A blueprint is a design to start from. Pick your template to create a pass.
          </span>
        ) : null}
        {link.kind === 'no-sandbox' ? (
          <span className="help">
            No sandbox yet. <a href="/developers/quickstart">Make one in the quickstart.</a>
          </span>
        ) : null}
        {link.kind === 'failed' ? (
          <span className="help bad-t" role="alert">
            {link.message}
          </span>
        ) : null}
        {link.kind === 'anonymous' ? (
          <span className="help">
            {link.signedIn
              ? `Previews show each blueprint's sample. Use ${SIGN_IN_COPY} to edit them live.`
              : "Previews show each blueprint's sample. Sign in to edit them live."}
          </span>
        ) : null}
        <button type="button" className="btn outline" onClick={() => void copyLink()}>
          <Copy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy link to this pass'}
        </button>
        {props.problem ? (
          <span className="help bad-t" role="alert">
            {props.problem}
          </span>
        ) : null}
      </div>
    </section>
  );
}
