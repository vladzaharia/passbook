import { useId } from 'react';
import { CONSOLE_COPY } from '../../../../shared/copy/developers-bench-console.ts';
import type { Lang } from '../../../developers/model/highlight.ts';
import { BenchCode } from '../../bench/code-block.tsx';
import { BenchTabs, benchPanelId, benchTabId } from '../../bench/tabs.tsx';
import { type Line, linesFor } from '../lines.ts';
import { type Draft, type InputCheck, problems } from '../request.ts';
import type { RunOp } from '../types.ts';
import { HeaderChips } from './chips.tsx';
import { FormTab } from './form.tsx';
import { JsonEditor } from './json-editor.tsx';

export type Tab = 'form' | 'json' | 'ts' | 'curl' | 'py' | 'go' | 'cli';
const FIXED: { id: Tab; label: string }[] = [
  { id: 'form', label: 'Form' },
  { id: 'json', label: 'JSON' },
];

interface Props {
  op: RunOp;
  origin: string;
  draft: Draft;
  /** The sandbox template's input schema, once read. */
  check?: InputCheck | undefined;
  tab: Tab;
  set: (next: Draft) => void;
  setTab: (t: Tab) => void;
}

/** The request: its view tabs, the header chips and the editor. The Run bar follows it (run-bar.tsx). */
export function Builder({ op, origin, draft, check, tab, set, setTab }: Props) {
  const base = useId().replace(/:/g, '');
  const issues = problems(op, draft, check);
  const lines = linesFor(op, draft, origin);
  const tabs = [
    ...FIXED.filter((t) => t.id !== 'json' || op.body),
    ...lines.map((l: Line) => ({ id: l.lang as Tab, label: l.label })),
  ];
  const shown = lines.find((l) => l.lang === tab);
  return (
    <>
      <BenchTabs
        base={base}
        tabs={tabs}
        selected={tab}
        onSelect={(id) => setTab(id as Tab)}
        label={CONSOLE_COPY.request.view}
      />
      <HeaderChips op={op} draft={draft} set={set} />
      <div
        className="pane"
        role="tabpanel"
        id={benchPanelId(base)}
        aria-labelledby={benchTabId(base, tab)}
      >
        {tab === 'form' ? <FormTab op={op} draft={draft} issues={issues} set={set} /> : null}
        {tab === 'json' ? (
          <JsonEditor value={draft.body} onChange={(body) => set({ ...draft, body })} />
        ) : null}
        {shown ? (
          <BenchCode
            label={`${shown.label} request`}
            body={shown.code}
            lang={tab as Lang}
            empty=""
          />
        ) : null}
      </div>
    </>
  );
}
