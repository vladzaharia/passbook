import { render } from '@testing-library/react';
import { createElement, useState } from 'react';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { TooltipProvider } from '../../../../ui/index.ts';
import '../../../../lib/test-utils.tsx';
import { sampleDoc } from '../fixtures.ts';
import type { DesignDoc } from '../model.ts';
import { ScanOutline } from './scan-outline.tsx';

type Screen = 'ready' | 'ok' | 'heads_up' | 'refused';
type Change = { display: ScanDisplayDoc; merge?: string };

export function fixture() {
  const doc = sampleDoc();
  doc.manifest.inputs = {
    type: 'object',
    properties: {
      name: { type: 'string', 'x-label': 'Name' },
      section: { type: 'string' },
      row: { type: 'string' },
      seat: { type: 'string' },
      gate: { type: 'string' },
    },
  };
  return doc;
}

export function setup(
  doc: DesignDoc,
  initial: ScanDisplayDoc | null,
  selection: string | null = null,
  outcome: Screen = 'ok',
) {
  const changes: Change[] = [];
  function Example() {
    const [display, setDisplay] = useState(initial);
    const [selected, onSelect] = useState(selection);
    return createElement(ScanOutline, {
      doc,
      display,
      selected,
      onSelect,
      screen: outcome,
      onChange: (next, merge) => {
        changes.push({ display: next, merge });
        setDisplay(next);
      },
    });
  }
  const view = render(createElement(TooltipProvider, null, createElement(Example)));
  return { ...view, changes, latest: () => changes[changes.length - 1]?.display };
}
