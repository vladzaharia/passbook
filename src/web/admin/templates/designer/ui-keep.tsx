import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

const Kept = createContext<Map<string, unknown> | null>(null);

/**
 * Holds the designer's view state that lives in a part of the page the layout may replace: crossing
 * the phone breakpoint swaps the structure and the card for another tree, and what a person had
 * open or half typed there must not reset with it. One store per open designer.
 */
export function KeepProvider({ children }: { children: ReactNode }) {
  const store = useRef<Map<string, unknown>>(new Map());
  return <Kept.Provider value={store.current}>{children}</Kept.Provider>;
}

/** `useState` that a remount of its component gets back, by `key`, while the designer stays open. */
export function useKept<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(Kept);
  const [value, setValue] = useState<T>(() => (store?.has(key) ? (store.get(key) as T) : initial));
  const last = useRef(key);
  useEffect(() => {
    // A key that moved on (the value it was named for changed) holds nothing to bring back.
    if (last.current !== key) store?.delete(last.current);
    last.current = key;
    store?.set(key, value);
  }, [store, key, value]);
  return [value, setValue];
}
