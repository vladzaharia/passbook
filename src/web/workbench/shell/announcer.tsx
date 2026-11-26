import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface AnnounceOptions {
  /** Messages with one key share a pace: a newer one waits for `every`, replacing an older waiting one. */
  key?: string;
  /** At most one message for this key per this many ms (a live list's "3 new requests": 5 s). */
  every?: number;
  /** Take the words out of the region after this long (the chord hint: 1.2 s). */
  clearAfter?: number;
}

export type Announce = (text: string, options?: AnnounceOptions) => void;

/** Each message holds the region this long before the next, so a reader finishes it. */
export const HOLD_MS = 900;

interface Pending {
  text: string;
  clearAfter?: number;
}

/**
 * The one polite queue (design §5.4, US6): the route title, a tool's new rows, the chord hint,
 * context switches and bridge arrivals all speak through one region, in turn, never over each other.
 * Pure timing: `createAnnouncer` drives `say`; the provider renders the region.
 */
export function createAnnouncer(say: (text: string) => void, now: () => number = Date.now) {
  const queue: Pending[] = [];
  const last = new Map<string, number>();
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; text: Pending }>();
  let busy: ReturnType<typeof setTimeout> | undefined;
  let clear: ReturnType<typeof setTimeout> | undefined;

  const pump = () => {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    clearTimeout(clear);
    say(next.text);
    if (next.clearAfter !== undefined) clear = setTimeout(() => say(''), next.clearAfter);
    busy = setTimeout(() => {
      busy = undefined;
      pump();
    }, HOLD_MS);
  };

  const enqueue = (item: Pending) => {
    queue.push(item);
    pump();
  };

  const announce: Announce = (text, options = {}) => {
    const item: Pending = { text, clearAfter: options.clearAfter };
    const { key, every } = options;
    if (!key || !every) return enqueue(item);
    const wait = (last.get(key) ?? Number.NEGATIVE_INFINITY) + every - now();
    const held = waiting.get(key);
    if (held) clearTimeout(held.timer);
    if (wait <= 0) {
      waiting.delete(key);
      last.set(key, now());
      return enqueue(item);
    }
    const timer = setTimeout(() => {
      waiting.delete(key);
      last.set(key, now());
      enqueue(item);
    }, wait);
    waiting.set(key, { timer, text: item });
  };

  const dispose = () => {
    clearTimeout(busy);
    clearTimeout(clear);
    for (const { timer } of waiting.values()) clearTimeout(timer);
    waiting.clear();
    queue.length = 0;
  };

  return { announce, dispose };
}

const AnnouncerContext = createContext<Announce>(() => undefined);

/** Speak through the shell's one region. Outside the Workbench shell it says nothing. */
export const useAnnounce = (): Announce => useContext(AnnouncerContext);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  // A fresh node per message, so the same words twice are spoken twice.
  const [said, setSaid] = useState({ text: '', n: 0 });
  const announcer = useRef<ReturnType<typeof createAnnouncer> | null>(null);
  announcer.current ??= createAnnouncer((text) => setSaid((s) => ({ text, n: s.n + 1 })));
  useEffect(() => () => announcer.current?.dispose(), []);
  const announce = useCallback<Announce>((t, o) => announcer.current?.announce(t, o), []);
  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-wb-announcer=""
        className="sr-only"
      >
        <span key={said.n}>{said.text}</span>
      </div>
    </AnnouncerContext.Provider>
  );
}
