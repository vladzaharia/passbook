import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { PATHS } from '../../../shared/developers.ts';
import { anySdk } from '../../../shared/developers-sdk.ts';
import { operations } from '../model/dates.ts';
import { opPath } from '../model/markdown.ts';
import type { ConsoleOp, OpView, ResourcePage } from '../model/types.ts';
import { MethodPill } from '../ui/method-pill.tsx';

const humanize = (sub: string) =>
  sub
    .replace(/([A-Z])/g, ' $1')
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

function ConsoleOnly({ ops }: { ops: ConsoleOp[] }) {
  if (ops.length === 0) return null;
  return (
    <section className="console-only">
      <h2 className="h2">{DEV_COPY.reference.consoleOnly}</h2>
      <p className="muted">{DEV_COPY.reference.consoleOnlyLine}</p>
      <div className="list card mt4">
        {ops.map((o) => (
          <div key={`${o.method}${o.path}`} className="lrow">
            <MethodPill method={o.method} />
            <code className="mono sm">{o.path}</code>
            <span className="push muted sm">{o.title}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A row per operation, linking to its own page. The row's id is the operation's old anchor on this
 * page, and `data-moved` lets the island carry a `#create` link to the page it moved to.
 */
function OpRow({ page, op }: { page: ResourcePage; op: OpView }) {
  return (
    <a
      className="lrow oprow"
      id={op.anchor}
      data-moved
      data-alias={op.operationId}
      href={opPath(page, op)}
    >
      <MethodPill method={op.method} />
      <span className="oprow-t">{op.title}</span>
      <code className="mono sm push">{op.path.replace(/^\/api\/v1/, '')}</code>
    </a>
  );
}

/** A resource: its operations, each on a page of its own. */
export function ResourceView({ page }: { page: ResourcePage }) {
  const groups: { sub: string | null; ops: OpView[] }[] = [];
  for (const op of page.ops) {
    const last = groups[groups.length - 1];
    if (last && last.sub === op.sub) last.ops.push(op);
    else groups.push({ sub: op.sub, ops: [op] });
  }
  return (
    <>
      <div className="eyebrow">
        <a href={PATHS.reference}>Reference</a>
        <span aria-hidden="true">·</span>
        <span>{page.group}</span>
      </div>
      {/* Carries an old `#anchor` to the operation's own page. */}
      <i data-island="moved" aria-hidden="true" />
      <h1 className="h1 page-h">{page.label}</h1>
      <p className="muted mt2 meta-links">
        {anySdk() ? null : <span className="pill neutral">{DEV_COPY.reference.sdkSoon}</span>}{' '}
        {operations(page.ops.length)}. <a href={`${PATHS.reference}/${page.slug}.md`}>Markdown</a>
      </p>
      {groups.map((g) => (
        <section key={g.sub ?? ''} className="mt8">
          {g.sub ? <h2 className="sub-h">{humanize(g.sub)}</h2> : null}
          <div className="list card mt4">
            {g.ops.map((op) => (
              <OpRow key={op.anchor} page={page} op={op} />
            ))}
          </div>
        </section>
      ))}
      <ConsoleOnly ops={page.consoleOnly} />
    </>
  );
}
