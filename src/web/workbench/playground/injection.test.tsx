import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonText } from '../../developers/model/code-literals.ts';
import {
  goBody,
  PAYLOADS,
  runPy,
  runSh,
  runTs,
  shapeOf,
} from '../../developers/model/sample-check.ts';
import { encodeHash, type PlaygroundState } from './hash.ts';
import { Playground } from './playground.tsx';
import { snippetsFor } from './snippets.ts';
import { fromBlueprint, valuesOf } from './templates.ts';
import { builtPreviews } from './test-data.ts';

const { data } = builtPreviews();
const STORE = 'baked:starter-store-card';
const template = fromBlueprint(
  data.items.find((i) => i.id === STORE) as (typeof data.items)[number],
);
const API = 'https://passbook.mobile/api/v1';
const LANGS = ['ts', 'curl', 'py', 'go'] as const;
const TAB = { ts: 'TypeScript', curl: 'curl', py: 'Python', go: 'Go' } as const;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('no network');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/developers/playground');
});

/** The four samples as the page shows them: read from the code panel, tab by tab. */
async function shown(user: ReturnType<typeof userEvent.setup>) {
  const out = {} as Record<(typeof LANGS)[number], string>;
  for (const lang of LANGS) {
    await user.click(screen.getByRole('tab', { name: TAB[lang] }));
    const lines = [...screen.getByTestId('code-panel').querySelectorAll('pre .ln')];
    out[lang] = lines.map((l) => l.textContent).join('\n');
    // Text only: a value never becomes an element in the panel.
    expect(
      screen.getByTestId('code-panel').querySelectorAll('script, img, iframe, [onerror]'),
    ).toHaveLength(0);
  }
  return out;
}

/** The shape of each sample with harmless values under the same keys. */
function benign(edits: Record<string, unknown>) {
  const values = valuesOf(template, edits);
  return Object.fromEntries(
    snippetsFor(STORE, values, API).map((s) => [s.lang, shapeOf(s.lang, s.code)]),
  ) as Record<(typeof LANGS)[number], string>;
}

async function expectInert(
  code: Record<(typeof LANGS)[number], string>,
  values: Record<string, unknown>,
  shapes: Record<(typeof LANGS)[number], string>,
) {
  for (const lang of LANGS) expect(shapeOf(lang, code[lang]), lang).toBe(shapes[lang]);
  const expected = JSON.parse(jsonText({ templateId: STORE, input: values as never }));
  const calls = await runTs(code.ts, 'SECRET-KEY');
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(expected);
  const sh = runSh(code.curl, 'SECRET-KEY');
  expect(sh.status).toBe(0);
  expect(sh.stdout).not.toContain('INJECTED');
  expect(JSON.parse(sh.args[sh.args.indexOf('-d') + 1] ?? '')).toEqual(expected);
  expect(JSON.parse(goBody(code.go))).toEqual(expected);
  const py = runPy(code.py, 'SECRET-KEY');
  if (py.ran) expect(py.sent).toEqual(expected);
}

describe('playground code from hostile input', () => {
  it.each(Object.entries(PAYLOADS))('%s typed into a field', async (_name, text) => {
    const user = userEvent.setup();
    render(<Playground data={data} />);
    // Typing is a change event per field; user.type would read `{` and `[` as key names.
    const holder = (await screen.findByLabelText(/^Name/)) as HTMLInputElement;
    const card = screen.getByLabelText(/^Card number/) as HTMLInputElement;
    fireEvent.change(holder, { target: { value: text } });
    fireEvent.change(card, { target: { value: text } });
    const code = await shown(user);
    // A text field drops line breaks itself, so the values are the ones the field holds.
    const values = valuesOf(template, { holder: holder.value, cardNumber: card.value });
    // What the page shows is what the generator wrote, character for character.
    for (const s of snippetsFor(STORE, values, `${location.origin}/api/v1`))
      expect(code[s.lang], s.lang).toBe(s.code);
    const withBase = Object.fromEntries(
      snippetsFor(STORE, values, API).map((s) => [s.lang, s.code]),
    ) as typeof code;
    await expectInert(withBase, values, benign({ holder: 'plain', cardNumber: 'plain' }));
  });

  it.each(Object.entries(PAYLOADS))(
    '%s arriving in the URL hash, in a value, a key and the template id',
    async (_name, text) => {
      const state: PlaygroundState = {
        template: text,
        edits: { holder: text, [text]: text, tags: [text] },
        channel: 'all',
        face: 'front',
        lang: 'ts',
        mode: 'form',
      };
      history.replaceState(null, '', `/developers/playground${encodeHash(state)}`);
      const user = userEvent.setup();
      render(<Playground data={data} />);
      await screen.findByTestId('all-channels');
      const code = await shown(user);
      // A template id that is not in the list never reaches the code: the page falls back to a real one.
      expect(code.ts).toContain(STORE);
      expect(code.ts).not.toContain("fetch('https://x");
      const values = valuesOf(template, state.edits);
      const withBase = Object.fromEntries(
        snippetsFor(STORE, values, API).map((s) => [s.lang, s.code]),
      ) as typeof code;
      await expectInert(
        withBase,
        values,
        benign({ holder: 'plain', 'some key': 'plain', tags: ['plain'] }),
      );
    },
  );
});
