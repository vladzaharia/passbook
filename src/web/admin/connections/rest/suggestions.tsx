import { Check } from 'lucide-react';
import type { z } from 'zod';
import type { ProbeDetectionsSchema } from '@/shared/contracts/connection-probe.ts';
import { cn } from '../../../lib/cn.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import type { Effect } from './explorer-actions.ts';
import { KEY, readPagination } from './rest-values.ts';

type Detections = z.infer<typeof ProbeDetectionsSchema>;
type Level = 'high' | 'medium' | 'low';

const level = (score: number): Level => (score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low');
const STYLE: Record<string, string> = {
  none: 'None',
  cursor: 'Cursor',
  'next-link': 'Next link',
  'link-header': 'Link header',
  page: 'Page number',
  offset: 'Offset',
};

interface Chip {
  id: string;
  role: string;
  text: string;
  level: Level;
  on: boolean;
  effect: Effect;
  said: string;
  /** The tree node to show when it is taken. */
  reveal?: string;
}

function chipsOf(
  det: Detections,
  v: FormValues,
  records: string,
  updatedField: string | undefined,
): Chip[] {
  const out: Chip[] = [];
  for (const r of det.records.slice(0, 3)) {
    out.push({
      id: `r${r.pointer}`,
      role: 'Records',
      text: `${r.pointer || '$'} · ${r.count}`,
      level: level(r.score),
      on: records === r.pointer,
      effect: { patch: { [KEY.records]: r.pointer } },
      said: `Records: ${r.pointer || 'whole body'}, ${r.count} items`,
      reveal: r.pointer,
    });
  }
  const id = det.id[0];
  if (id) {
    out.push({
      id: 'id',
      role: 'ID',
      text: id.pointer || '$',
      level: id.unique ? level(id.score) : 'low',
      on: v[KEY.id] === id.pointer,
      effect: { patch: { [KEY.id]: id.pointer } },
      said: `ID: ${id.pointer}`,
    });
  }
  const page = det.pagination[0];
  if (page) {
    out.push({
      id: 'page',
      role: 'Pagination',
      text: STYLE[page.config.style] ?? page.config.style,
      level: page.confidence,
      on: readPagination(v).style === page.config.style && page.config.style !== 'none',
      effect: { patch: { [KEY.pagination]: page.config } },
      said: `Pagination: ${STYLE[page.config.style]}`,
    });
  }
  const up = det.updatedAt[0];
  if (up) {
    out.push({
      id: 'up',
      role: 'Updated',
      text: `${up.pointer} · ${up.format}`,
      level: level(up.score),
      on: updatedField === up.pointer,
      effect: { updated: { field: up.pointer, format: up.format } },
      said: `Updated: ${up.pointer}`,
    });
  }
  const em = det.holderEmail[0];
  if (em) {
    out.push({
      id: 'em',
      role: 'Email',
      text: em.pointer,
      level: 'high',
      on: v[KEY.email] === em.pointer,
      effect: { patch: { [KEY.email]: em.pointer } },
      said: `Holder email: ${em.pointer}`,
    });
  }
  return out;
}

/** What the response suggests, one click each; taken ones stay pressed. */
export function Suggestions({
  detections,
  value,
  records,
  updatedField,
  onTake,
}: {
  detections: Detections;
  value: FormValues;
  records: string;
  updatedField: string | undefined;
  onTake: (effect: Effect, said: string, reveal?: string) => void;
}) {
  const chips = chipsOf(detections, value, records, updatedField);
  if (chips.length === 0) return null;
  const more = detections.fields.length;
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Suggestions</legend>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={c.on}
          className={cn('rx-chip', c.on && 'rx-chip-on')}
          onClick={() => onTake(c.effect, c.said, c.reveal)}
        >
          {c.on ? <Check aria-hidden className="size-3.5" /> : null}
          <span className="font-medium">{c.role}</span>
          <span className="rx-chip-text">{c.text}</span>
          <span className="rx-conf" data-level={c.level}>
            {c.level}
          </span>
        </button>
      ))}
      <span className="text-xs text-fg-muted">{more} fields</span>
    </fieldset>
  );
}
