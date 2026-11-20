import { render, screen } from '@testing-library/react';
import { type ReactNode, useRef, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawRead } from '../input/types.ts';
import { useWedgeField, WedgeFieldsContext } from '../input/wedge-field.tsx';
import { createWedgeSource, WedgeFields } from '../input/wedge-source.ts';
import { fakeClock } from '../machine/store.test-support.ts';
import type { Command } from './keys.ts';
import { useOperatorKeys } from './use-operator-keys.ts';
import { CommandField } from './workspace/command-field.tsx';

/**
 * Rule 1: a scan lands from any focus state. A reader's burst is a scan wherever focus is: it
 * never types into the control that has focus and never fires a shortcut. The real wedge source
 * and the real keys hook run on one fake clock; only the commands are recorded.
 */
const CODE_KEY: Record<string, string> = { '/': 'Slash' };
const codeFor = (ch: string) =>
  /[A-Za-z]/.test(ch)
    ? `Key${ch.toUpperCase()}`
    : /\d/.test(ch)
      ? `Digit${ch}`
      : (CODE_KEY[ch] ?? '');

function Note() {
  const ref = useRef<HTMLTextAreaElement>(null);
  useWedgeField(ref, () => undefined);
  return <textarea ref={ref} aria-label="Note" />;
}

function Harness({
  fields,
  clock,
  commands,
  dialog,
}: {
  fields: WedgeFields;
  clock: ReturnType<typeof fakeClock>;
  commands: Command[];
  dialog: boolean;
}) {
  const [q, setQ] = useState('mar');
  useOperatorKeys(
    () => ({
      views: ['activity', 'problems'],
      fieldText: q.length > 0,
      record: true,
      rollCall: true,
      walkIn: true,
      undoable: true,
    }),
    (command) => commands.push(command),
    clock,
  );
  const body: ReactNode = (
    <>
      <CommandField
        value={q}
        onChange={setQ}
        readiness="ready"
        allowPeople
        searching={false}
        activeId={undefined}
      />
      <main data-operator-record>
        <h2 data-operator-heading tabIndex={-1}>
          Maya Okafor
        </h2>
        <button type="button">Check in</button>
        <ul>
          <li>
            <button type="button" data-roving>
              Row
            </button>
          </li>
        </ul>
        <Note />
      </main>
      {dialog ? (
        <div role="dialog" data-state="open">
          <button type="button">Close</button>
        </div>
      ) : null}
    </>
  );
  return <WedgeFieldsContext.Provider value={fields}>{body}</WedgeFieldsContext.Provider>;
}

function setup(dialog = false) {
  const clock = fakeClock();
  const fields = new WedgeFields();
  const scans: RawRead[] = [];
  const commands: Command[] = [];
  const stop = createWedgeSource({ clock, fields }).start((read) => scans.push(read));
  const view = render(
    <Harness fields={fields} clock={clock} commands={commands} dialog={dialog} />,
  );
  function key(target: Element, init: KeyboardEventInit) {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented && target instanceof HTMLInputElement && init.key?.length === 1)
      target.value += init.key;
    if (!ev.defaultPrevented && target instanceof HTMLTextAreaElement && init.key?.length === 1)
      target.value += init.key;
    return ev;
  }
  /** A reader: every key 10 ms apart, then Enter, wherever focus is. */
  function scan(text: string) {
    const target = document.activeElement ?? document.body;
    for (const [i, ch] of [...text].entries()) {
      if (i > 0) clock.advance(10);
      key(target, { code: codeFor(ch), key: ch, shiftKey: /[A-Z]/.test(ch) });
    }
    clock.advance(10);
    key(target, { code: 'Enter', key: 'Enter' });
    clock.advance(500);
  }
  /** A person: one key, then a pause. */
  function type(ch: string) {
    key(document.activeElement ?? document.body, { code: codeFor(ch), key: ch });
    clock.advance(500);
  }
  return { clock, scans, commands, scan, type, key, view, stop };
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

// Every shortcut letter leads a code in turn: the first key is the one that must not act.
const CODES = ['OABC1234', 'NABC1234', 'PABC1234', 'SABC1234', 'XABC1234', '/ABC1234'];

const STATES: [string, (h: ReturnType<typeof setup>) => void][] = [
  ['the command field has focus', () => screen.getByRole('combobox').focus()],
  [
    'the record heading has focus',
    () => screen.getByRole('heading', { name: 'Maya Okafor' }).focus(),
  ],
  [
    'a button in the record has focus',
    () => screen.getByRole('button', { name: 'Check in' }).focus(),
  ],
  ['a list row has focus', () => screen.getByRole('button', { name: 'Row' }).focus()],
  ['nothing has focus', () => (document.activeElement as HTMLElement | null)?.blur()],
  ['the note editor has focus', () => screen.getByLabelText('Note').focus()],
];

describe('a scan lands from every focus state (rule 1)', () => {
  for (const [name, focus] of STATES) {
    describe(name, () => {
      for (const code of CODES) {
        it(`${code}: one scan, no shortcut, nothing typed, focus where it was`, () => {
          const h = setup();
          stop = h.stop;
          focus(h);
          const before = document.activeElement;
          const fieldBefore = (screen.getByRole('combobox') as HTMLInputElement).value;
          const noteBefore = (screen.getByLabelText('Note') as HTMLTextAreaElement).value;
          h.scan(code);
          expect(h.scans).toEqual([{ method: 'wedge', code }]);
          expect(h.commands).toEqual([]);
          expect(document.activeElement).toBe(before);
          expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe(fieldBefore);
          expect((screen.getByLabelText('Note') as HTMLTextAreaElement).value).toBe(noteBefore);
        });
      }
    });
  }

  it('a dialog is open: the scan still lands and no shortcut fires', () => {
    const h = setup(true);
    stop = h.stop;
    screen.getByRole('button', { name: 'Close' }).focus();
    h.scan('OABC1234');
    expect(h.scans).toEqual([{ method: 'wedge', code: 'OABC1234' }]);
    expect(h.commands).toEqual([]);
  });

  it('two scans in a row both land', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('button', { name: 'Check in' }).focus();
    h.scan('OABC1234');
    h.scan('NXYZ9876');
    expect(h.scans.map((s) => s.code)).toEqual(['OABC1234', 'NXYZ9876']);
    expect(h.commands).toEqual([]);
  });

  it('a scan ending in Enter never triggers the primary action', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('heading', { name: 'Maya Okafor' }).focus();
    h.scan('AAAA1111');
    expect(h.commands.some((c) => c.c === 'primary')).toBe(false);
  });
});

describe('a person still has the keys (so the guard above is not just a dead listener)', () => {
  it('a lone o on the record marks out after the gap', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('button', { name: 'Check in' }).focus();
    h.type('o');
    expect(h.commands).toEqual([{ c: 'out' }]);
    expect(h.scans).toEqual([]);
  });

  it('a lone letter that is no shortcut goes to the field (type-to-search)', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('heading', { name: 'Maya Okafor' }).focus();
    h.type('m');
    expect(h.commands).toEqual([{ c: 'type', ch: 'm' }]);
  });

  it('Enter on the record is the primary action; Enter on a focused button is the button', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('heading', { name: 'Maya Okafor' }).focus();
    h.key(document.activeElement as Element, { code: 'Enter', key: 'Enter' });
    expect(h.commands).toEqual([{ c: 'primary' }]);
    screen.getByRole('button', { name: 'Check in' }).focus();
    h.key(document.activeElement as Element, { code: 'Enter', key: 'Enter' });
    expect(h.commands).toEqual([{ c: 'primary' }]);
  });

  it('typing in the field is not a shortcut', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('combobox').focus();
    h.type('o');
    expect(h.commands).toEqual([]);
  });

  it('chords act at once, in the field too', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('combobox').focus();
    h.key(document.activeElement as Element, { code: 'KeyZ', key: 'z', metaKey: true });
    h.key(document.activeElement as Element, { code: 'KeyK', key: 'k', metaKey: true });
    expect(h.commands).toEqual([{ c: 'undo' }, { c: 'focus-search' }]);
  });

  it('a slow reader inside the wedge gap is still a scan, not shortcuts', () => {
    const h = setup();
    stop = h.stop;
    screen.getByRole('button', { name: 'Check in' }).focus();
    const target = document.activeElement as Element;
    for (const ch of 'OABC1234') {
      h.key(target, { code: codeFor(ch), key: ch, shiftKey: /[A-Z]/.test(ch) });
      h.clock.advance(45);
    }
    h.key(target, { code: 'Enter', key: 'Enter' });
    h.clock.advance(500);
    expect(h.commands).toEqual([]);
    expect(h.scans).toEqual([{ method: 'wedge', code: 'OABC1234' }]);
  });
});
