import type { ReactNode } from 'react';
import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { highlight, type Lang } from '../model/highlight.ts';
import { exampleSamples } from '../model/samples.ts';
import type { Example } from '../model/types.ts';
import { Head } from '../pages/more.tsx';
import { CodeRegion, SampleTabs } from '../ui/code.tsx';
import { MethodPill } from '../ui/method-pill.tsx';
import { groupByStep, stepOf } from './group.ts';
import { lifecycleSvg } from './lifecycle.ts';
import { GUIDE_TWIN, type Guide, hrefOf } from './model.ts';
import type { Block, GuideStatus } from './parse.ts';
import { GuideTile } from './tile.tsx';

const STATUS: Record<GuideStatus, string | null> = {
  ready: null,
  preview: 'Preview',
  soon: 'Soon',
};
const LANGS: Record<string, Lang> = { json: 'json', ts: 'ts', sh: 'curl', curl: 'curl' };

/** Text with `code`, **bold** and [links](target): React nodes, escaped by React. */
export function Inline({ text }: { text: string }): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    const key = `${i}`;
    if (part.startsWith('`'))
      return (
        <code key={key} className="inline-code">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith('**')) return <strong key={key}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    return link ? (
      <a key={key} href={hrefOf(link[2] as string)}>
        {link[1]}
      </a>
    ) : (
      part
    );
  });
}

function Steps({
  guide,
  example,
  k,
  name,
}: {
  guide: Guide;
  example: Example;
  k: string;
  name: string;
}) {
  return <SampleTabs id={`${guide.meta.id}-${k}`} samples={exampleSamples(example)} name={name} />;
}

function ConsoleLink({ href }: { href: string }) {
  return (
    <div className="gstep-f row g3 wrap-row">
      <a className="btn sm" href={href}>
        {DEV_COPY.guides.openConsole}
      </a>
    </div>
  );
}

function BlockView({
  b,
  guide,
  examples,
  n,
}: {
  b: Block;
  guide: Guide;
  examples: Map<string, Example>;
  n: number;
}) {
  switch (b.kind) {
    case 'h2':
      return (
        <h2 id={b.id} className="h2 gh">
          {b.text}
        </h2>
      );
    case 'h3':
      return (
        <h3 id={b.id} className="h3 gh">
          {b.text}
        </h3>
      );
    case 'p':
      return (
        <p className="prose">
          <Inline text={b.text} />
        </p>
      );
    case 'quote':
      return (
        <aside className="gnote prose">
          <Inline text={b.text} />
        </aside>
      );
    case 'ul':
    case 'ol': {
      const List = b.kind;
      return (
        <List className="prose glist">
          {b.items.map((item) => (
            <li key={item}>
              <Inline text={item} />
            </li>
          ))}
        </List>
      );
    }
    case 'table':
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable table region
        <section className="gtable" aria-label="Table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.head.map((h) => (
                  <th key={h}>
                    <Inline text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r) => (
                <tr key={r.join('|')}>
                  {r.map((c) => (
                    <td key={c}>
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    case 'code': {
      const href = guide.steps.find((s) => s.block === n)?.href;
      return (
        <div className="gstep">
          <div className="code json">
            <CodeRegion
              html={highlight(b.text, LANGS[b.lang] ?? 'json')}
              label={`Step ${n + 1}: ${b.lang} request`}
            />
          </div>
          {href ? <ConsoleLink href={href} /> : null}
        </div>
      );
    }
    case 'run':
    case 'show': {
      const example = examples.get(b.snippet);
      if (!example) return null;
      const step = guide.steps.find((s) => s.block === n);
      return (
        <div className="gstep">
          <div className="h3 gstep-h">{example.title}</div>
          <Steps
            guide={guide}
            example={example}
            k={`${b.snippet}-${n}`}
            name={`Step ${n + 1}: ${example.title}`}
          />
          {step ? <ConsoleLink href={step.href} /> : null}
        </div>
      );
    }
    case 'diagram':
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable figure
        <section className="gfig" aria-label="Lifecycle diagram" tabIndex={0}>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: drawn at build from the lifecycle table in lifecycle.ts */}
          <div className="gfig-svg" dangerouslySetInnerHTML={{ __html: lifecycleSvg() }} />
        </section>
      );
  }
}

export function GuidesIndex({ guides }: { guides: Guide[] }) {
  const s = DEV_COPY.slots.guides;
  return (
    <>
      <Head title={s.title} />
      {groupByStep(guides, (g) => g.meta.id).map(({ step, items }) => (
        <section key={step.id} className="gsec" aria-labelledby={`step-${step.id}`}>
          <h2 id={`step-${step.id}`} className="h3 gsec-h">
            {step.label}
          </h2>
          <div className="recipes">
            {items.map((g) => (
              <a key={g.meta.id} className="row g3 card tile-row" href={g.url} id={g.meta.id}>
                <GuideTile id={g.meta.id} />
                <span>
                  <span className="strong">{g.meta.title}</span>
                  {STATUS[g.meta.status] ? (
                    <span className="pill neutral gpill">{STATUS[g.meta.status]}</span>
                  ) : null}
                </span>
              </a>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function GuideView({
  guide,
  examples,
  markdown,
}: {
  guide: Guide;
  examples: Example[];
  markdown: string;
}) {
  const byId = new Map(examples.map((e) => [e.id, e]));
  const status = STATUS[guide.meta.status];
  const step = stepOf(guide.meta.id);
  return (
    <>
      <div className="eyebrow">
        <a href={PATHS.guides}>{DEV_COPY.guides.title}</a>
        <span aria-hidden="true">/</span>
        <span className={`gkicker ${step.tone}`}>{step.label}</span>
      </div>
      {/* The personalizing island: it has no size, and mounts when the page loads. */}
      <i data-island="snippets" aria-hidden="true" />
      <div className="row g3 wrap-row gtitle">
        <h1 className="h1 page-h">{guide.meta.title}</h1>
        {status ? <span className="pill accent">{status}</span> : null}
      </div>
      <p className="lede muted mt2 prose">{guide.meta.line}</p>
      <div className="row g3 wrap-row mt4 gactions">
        <button type="button" className="btn outline sm" data-copy data-copy-text={markdown}>
          {DEV_COPY.guides.copyForAi}
        </button>
        <a className="btn ghost sm" href={GUIDE_TWIN(guide.meta.id)}>
          {DEV_COPY.guides.markdown}
        </a>
      </div>
      {guide.blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list, rendered once at build
        <BlockView key={i} b={b} guide={guide} examples={byId} n={i} />
      ))}
      {guide.ops.length > 0 ? (
        <section className="gops">
          <h2 className="h2" id="operations">
            {DEV_COPY.guides.operations}
          </h2>
          <div className="list card mt4">
            {guide.ops.map((o) => (
              <a key={o.operationId} className="lrow gop" href={o.href}>
                <MethodPill method={o.method} />
                <code className="mono sm">{o.path}</code>
                <span className="push muted sm">{o.title}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
