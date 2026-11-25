import {
  BookOpen,
  CircleAlert,
  FileText,
  KeyRound,
  Layers,
  type LucideIcon,
  Play,
  Webhook,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { DEV_GUIDE_STEPS, DEV_GUIDES } from '../../../shared/copy/developers.ts';
import { SEARCH_COPY } from '../../../shared/copy/developers-search.ts';
import type { CommandGroup, CommandItem } from '../../ui/command-palette.tsx';
import { goTo, openTab } from './nav.ts';
import { pieces, type Results } from './rank.ts';
import type { ActionDoc, ErrorDoc, EventDoc, GuideDoc, OpDoc } from './types.ts';

const METHOD_CLASS: Record<string, string> = {
  DELETE: 'del',
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  PATCH: 'patch',
};

/** The label with the query's words marked. */
export function Marked({
  text,
  words,
  mono,
}: {
  text: string;
  words: readonly string[];
  mono?: boolean;
}) {
  return (
    <span className={mono ? 'min-w-0 flex-1 truncate mono' : 'min-w-0 flex-1 truncate'}>
      {pieces(text, words).map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional and never reorder
          <mark key={i} className="srch-mark">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </span>
  );
}

const go = (href: string) => () => goTo(href);
const newTab = (href: string) => () => openTab(href);

export function item(
  id: string,
  label: string,
  href: string,
  extra: Partial<CommandItem>,
): CommandItem {
  return { id, label, onSelect: go(href), newTab: newTab(href), ...extra };
}

const mono = (text: ReactNode) => <span className="mono">{text}</span>;

export const iconOf = (kind: GuideDoc['kind']): LucideIcon =>
  kind === 'guide' ? BookOpen : kind === 'reference' ? Layers : FileText;

export const errorItem = (e: ErrorDoc, words: readonly string[]) =>
  item(`error:${e.code}`, e.code, e.href, {
    icon: CircleAlert,
    content: <Marked text={e.code} words={words} mono />,
    hint: e.status ? mono(e.status) : undefined,
  });

export const opItem = (o: OpDoc, words: readonly string[]) =>
  item(`op:${o.id}`, o.title, o.href, {
    content: (
      <>
        <span className={`method ${METHOD_CLASS[o.method] ?? 'get'}`}>
          {o.method === 'DELETE' ? 'DEL' : o.method}
        </span>
        <Marked text={o.title} words={words} />
      </>
    ),
    // A phone has no room for the path beside the title.
    hint: <span className="mono srch-path">{o.path}</span>,
  });

/** The step a guide sits in, as its search hint: the grouping the guides page shows. */
const stepLabel = (id: string): string => {
  const step = DEV_GUIDES.find((g) => g.id === id)?.step;
  return DEV_GUIDE_STEPS.find((s) => s.id === step)?.label ?? SEARCH_COPY.hints.guide;
};

export const guideItem = (g: GuideDoc, words: readonly string[]) =>
  item(`guide:${g.id}`, g.title, g.href, {
    icon: iconOf(g.kind),
    content: <Marked text={g.title} words={words} />,
    hint:
      g.kind === 'guide'
        ? stepLabel(g.id)
        : SEARCH_COPY.hints[g.kind === 'page' ? 'page' : 'reference'],
  });

export const eventItem = (e: EventDoc, words: readonly string[]) =>
  item(`event:${e.type}`, e.type, e.href, {
    icon: Webhook,
    content: <Marked text={e.type} words={words} mono />,
    hint: SEARCH_COPY.hints.event,
  });

export const actionItem = (a: ActionDoc, words: readonly string[]) =>
  item(`action:${a.id}`, a.label, a.href, {
    icon:
      a.id === 'roll-key' || a.id === 'test-key' ? KeyRound : a.id === 'playground' ? Play : Zap,
    content: <Marked text={a.label} words={words} />,
    hint: a.sandbox ? SEARCH_COPY.hints.sandbox : undefined,
  });

/** The five groups in their fixed order; empty ones drop out. */
export function groupsOf(results: Results, words: readonly string[]): CommandGroup[] {
  const g = SEARCH_COPY.groups;
  return [
    { heading: g.errors, items: results.errors.map((e) => errorItem(e, words)) },
    { heading: g.operations, items: results.ops.map((o) => opItem(o, words)) },
    { heading: g.guides, items: results.guides.map((x) => guideItem(x, words)) },
    { heading: g.events, items: results.events.map((e) => eventItem(e, words)) },
    { heading: g.actions, items: results.actions.map((a) => actionItem(a, words)) },
  ];
}
