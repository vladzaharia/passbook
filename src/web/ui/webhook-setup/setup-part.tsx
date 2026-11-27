import { Check } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn.ts';
import { Callout } from '../callout.tsx';
import { CodeBlock } from '../code-block.tsx';
import { CopyRow } from './copy-row.tsx';
import { Rich } from './rich.tsx';
import { TopicChecklist } from './topic-checklist.tsx';
import type { SetupPart, SetupTopic, SetupValues } from './types.ts';

const LANG_LABEL = { sh: 'Shell', curl: 'curl', ts: 'TypeScript', py: 'Python', go: 'Go' } as const;

type Field = Extract<SetupPart, { t: 'field' }>;

/** A run of `field` parts is one label and value grid: the labels line up. */
function runs(parts: readonly SetupPart[]): (SetupPart | Field[])[] {
  const out: (SetupPart | Field[])[] = [];
  for (const part of parts) {
    const tail = out[out.length - 1];
    if (part.t === 'field' && Array.isArray(tail)) tail.push(part);
    else out.push(part.t === 'field' ? [part] : part);
  }
  return out;
}

function FieldGrid({ fields, values }: { fields: Field[]; values: SetupValues }) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 @md:grid-cols-[7.5rem_minmax(0,1fr)]">
      {fields.map((f, i) => {
        const copy = f.copy ? values[f.copy] : undefined;
        const key = `${f.label}-${i}`;
        return (
          <Fragment key={key}>
            <dt className="pt-1.5 text-sm text-fg-muted">{f.label}</dt>
            <dd className="min-w-0">
              {f.copy ? (
                copy ? (
                  <CopyRow label={f.label} value={copy} showLabel={false} />
                ) : (
                  <span className="text-sm text-fg-muted">
                    {f.copy === 'secret' ? 'Shown once, when it was made.' : 'Not available yet.'}
                  </span>
                )
              ) : f.choose ? (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-subtle px-2.5 py-1 text-sm font-medium text-fg-strong">
                  <Check aria-hidden className="size-3.5 text-accent-fg" />
                  {f.value ? <Rich text={f.value} /> : null}
                  <span className="sr-only"> (choose this)</span>
                </span>
              ) : (
                <span className="inline-block py-1 text-sm text-fg">
                  {f.value ? <Rich text={f.value} /> : null}
                </span>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/** One piece of a guide step: text, a menu path, a form field, topics, code, a note or a warning. */
export function SetupPartView({
  part,
  values,
  topics,
}: {
  part: SetupPart | Field[];
  values: SetupValues;
  topics: readonly SetupTopic[];
}): ReactNode {
  if (Array.isArray(part)) return <FieldGrid fields={part} values={values} />;
  switch (part.t) {
    case 'text':
      return (
        <p className="max-w-[40rem] text-sm text-fg">
          <Rich text={part.text} />
        </p>
      );
    case 'path':
      return (
        <fieldset
          aria-label="Menu path"
          className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
        >
          {part.items.map((item, i) => (
            <Fragment key={item}>
              {i > 0 ? (
                <span aria-hidden className="text-fg-muted">
                  ›
                </span>
              ) : null}
              <span
                className={cn(
                  'rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-sm',
                  i === part.items.length - 1 ? 'font-medium text-fg-strong' : 'text-fg',
                )}
              >
                {item}
              </span>
            </Fragment>
          ))}
        </fieldset>
      );
    case 'topics':
      return <TopicChecklist plain topics={topics} heading="Subscribe to" />;
    case 'code':
      return (
        <CodeBlock code={part.code} label={`${LANG_LABEL[part.lang]} code`} maxHeight="max-h-56" />
      );
    case 'note':
      return (
        <p className="max-w-[40rem] text-xs text-fg-muted">
          <Rich text={part.text} />
        </p>
      );
    case 'warn':
      return (
        <Callout tone="warning">
          <Rich text={part.text} />
        </Callout>
      );
    default:
      return null;
  }
}

export { runs as groupParts };
