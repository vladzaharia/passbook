import { ArrowRight, Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { QS_COPY } from '../../../shared/copy/developers-quickstart.ts';
import { PATHS } from '../../../shared/developers.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { Buddy } from '../../ui/art/buddy.tsx';
import { duration } from '../home/model.ts';
import { copyToClipboard } from '../playground/copy.ts';
import { ApplePane } from '../playground/panes.tsx';
import { sourceOf } from '../playground/templates.ts';
import { envFile } from './model.ts';
import type { Quickstart } from './use-quickstart.ts';

const D = QS_COPY.done;

/** The finished quickstart: the pass, the time it took, the .env and where to go next. It replaces the steps. */
export function Done({ q }: { q: Quickstart }) {
  const { pass, template, templateId, secret, progress } = q;
  const source = useMemo(
    () => (pass && template ? sourceOf(template, pass.built, pass.input) : null),
    [pass, template],
  );
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!templateId || !(await copyToClipboard(envFile(secret, templateId)))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <section className="qs-done" aria-label={D.title('')}>
      <div className="qs-done-card wl-buddy-room" data-art-host>
        <Buddy key="done" size="lg" at="start" mood="happy" scene="wave" />
        {source ? (
          <div className="qs-done-pass">
            <ApplePane source={source} face="front" />
          </div>
        ) : null}
        <h2 className="h2 qs-done-t" role="status">
          {D.title(duration(progress?.doneMs ?? 0))}
        </h2>
        <div className="row g3 wrap-row qs-done-a">
          <button type="button" className="btn" onClick={() => void copy()}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? D.copied : D.env}
          </button>
          <a
            className="btn outline"
            href={q.sandbox ? wbPath(q.sandbox.orgId, 'home') : wbPath('', 'quickstart')}
          >
            {D.workbench}
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </div>
      <ul className="qs-done-next">
        {D.cards.map((c) => (
          <li key={c.id}>
            <a className="card qs-next-card" href={`${PATHS.guides}/${c.id}`}>
              <strong>{c.title}</strong>
              <span className="row g1 xs muted">
                {D.guide}
                <ArrowRight aria-hidden="true" className="lucide" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
