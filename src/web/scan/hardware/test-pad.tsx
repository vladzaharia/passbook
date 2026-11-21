import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/button.tsx';
import { charOf } from '../input/us-keymap.ts';
import { WEDGE_STANDARD, WedgeDetector } from '../input/wedge-detector.ts';
import { fill } from '../ui/copy.ts';
import { HARDWARE_COPY as C } from './copy.ts';

export interface TestRead {
  code: string;
  /** Mean milliseconds between keys (a person types far slower); null for a serial read. */
  gap: number | null;
}

/** Feeds one key to the detector; a finished burst comes back as a read. */
export function testKey(
  detector: WedgeDetector,
  e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>,
  t: number,
): TestRead | null {
  const v =
    e.key === 'Enter' || e.key === 'Tab'
      ? detector.push({ k: 'end', key: e.key, t })
      : (() => {
          const ch = charOf(e.code, e.shiftKey) ?? (e.key.length === 1 ? e.key : null);
          if (ch) return detector.push({ k: 'char', ch, t });
          const soft = e.key === 'Shift' || e.key === 'CapsLock';
          return detector.push(soft ? { k: 'ignore', t } : { k: 'other', t });
        })();
  return v.v === 'scan' ? readOf(v) : null;
}

function readOf(v: { code: string; start: number; end: number }): TestRead {
  return {
    code: v.code,
    gap: v.code.length > 1 ? Math.round((v.end - v.start) / (v.code.length - 1)) : 0,
  };
}

/** A scanner with no Enter or Tab: the code ends after a quiet spell. */
export function flushTest(detector: WedgeDetector, t: number): TestRead | null {
  const v = detector.flushIdle(t);
  return v.v === 'scan' ? readOf(v) : null;
}

/**
 * The scanner test: an editable box the wedge source leaves alone (it skips editable regions it
 * does not own), so a test scan shows its code here and checks nothing in.
 */
export function TestPad({
  onDone,
  external = null,
}: {
  onDone: () => void;
  /** A read from a serial scanner while the test is open. */
  external?: TestRead | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const detector = useRef(new WedgeDetector(WEDGE_STANDARD));
  const [read, setRead] = useState<TestRead | null>(null);
  useEffect(() => {
    if (external) setRead(external);
  }, [external]);
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    box.current?.focus();
    return () => clearTimeout(idle.current);
  }, []);
  return (
    <div className="hw-test">
      {/* biome-ignore lint/a11y/useSemanticElements: a contenteditable box keeps keys from the wedge source */}
      <div
        ref={box}
        role="textbox"
        tabIndex={0}
        contentEditable
        suppressContentEditableWarning
        inputMode="none"
        aria-label={C.test.field}
        aria-describedby="hw-test-out"
        className="hw-test-box"
        data-read={read ? '' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') return;
          e.preventDefault();
          const next = testKey(detector.current, e, e.timeStamp);
          if (next) setRead(next);
          clearTimeout(idle.current);
          idle.current = setTimeout(() => {
            const flushed = flushTest(detector.current, performance.now());
            if (flushed) setRead(flushed);
          }, WEDGE_STANDARD.idleAcceptMs);
        }}
        onBeforeInput={(e) => e.preventDefault()}
        onPaste={(e) => e.preventDefault()}
      >
        {read ? <code>{read.code}</code> : <span aria-hidden>{C.test.prompt}</span>}
      </div>
      <p id="hw-test-out" className="hw-test-out" role="status">
        {read
          ? read.gap === null
            ? fill(C.test.readSerial, { n: read.code.length })
            : fill(C.test.read, { n: read.code.length, ms: read.gap })
          : ''}
      </p>
      <Button variant="secondary" size="sm" onClick={onDone}>
        {C.test.done}
      </Button>
    </div>
  );
}
