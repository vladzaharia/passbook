import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from './motion.ts';

export type ThemePref = 'system' | 'light' | 'dark';
/** Cookie name (the worker's SSR pages read it) and the storage key it replaced. */
export const THEME_KEY = 'wallet-theme';
const ONE_YEAR_S = 31_536_000;

/** The browser chrome per theme: the page surface. index.html carries the same pair by media. */
export const THEME_COLOR = { light: '#f6f8ff', dark: '#060912' } as const;

/** The account menu and the palette offer these, in this order; icons are THEME_ICON. */
export const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies readonly { value: ThemePref; label: string }[];

function isPref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

function cookiePref(): ThemePref | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = new RegExp(`(?:^|;\\s*)${THEME_KEY}=([^;]*)`).exec(document.cookie)?.[1];
  return isPref(value) ? value : undefined;
}

function storedPref(): ThemePref | undefined {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return isPref(value) ? value : undefined;
  } catch {
    // Storage can be blocked (private mode); the cookie or the system decides.
    return undefined;
  }
}

/** The saved choice: the cookie, else storage from before the cookie, else the system. */
export function readPref(): ThemePref {
  return cookiePref() ?? storedPref() ?? 'system';
}

/** Saves the choice where the SSR pages (cookie) and older tabs (storage) look for it. */
export function writePref(pref: ThemePref): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  // biome-ignore lint/suspicious/noDocumentCookie: a plain first-party cookie, read by theme-init.js and the worker
  document.cookie = `${THEME_KEY}=${pref}; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_S}${secure}`;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage blocked: the cookie still carries the choice.
  }
}

/** The same steps as public/theme-init.js, which runs before the first paint. */
export function applyPref(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.dataset.themePref = pref;
}

/** One theme-color meta for the theme on screen, replacing index.html's pair by media. */
export function applyThemeColor(theme: 'light' | 'dark', head: HTMLElement = document.head): void {
  const [meta = head.appendChild(document.createElement('meta')), ...rest] = head.querySelectorAll(
    'meta[name="theme-color"]',
  );
  for (const extra of rest) extra.remove();
  meta.setAttribute('name', 'theme-color');
  meta.removeAttribute('media');
  meta.setAttribute('content', THEME_COLOR[theme]);
}

const systemTheme = (): 'light' | 'dark' =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';

interface ThemeContextValue {
  /** The saved choice. */
  pref: ThemePref;
  /** The theme on screen. */
  resolved: 'light' | 'dark';
  setPref: (pref: ThemePref) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** A same-document View Transition with types, or false where unsupported. */
function typedTransition(update: () => void, types: string[]): boolean {
  const doc = document as Document & {
    startViewTransition?: (o: { update: () => void; types: string[] }) => unknown;
  };
  const typed =
    typeof doc.startViewTransition === 'function' &&
    typeof CSS !== 'undefined' &&
    CSS.supports('selector(:active-view-transition-type(a))');
  if (!typed || prefersReducedMotion()) return false;
  doc.startViewTransition?.({ update, types });
  return true;
}

/** One theme for every page: the account menu and the palette set it. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [system, setSystem] = useState(systemTheme);
  const resolved = pref === 'system' ? system : pref;

  useEffect(() => {
    applyPref(pref);
  }, [pref]);

  useEffect(() => {
    applyThemeColor(resolved);
  }, [resolved]);

  // A choice saved before the cookie existed lives in storage only; give it to the SSR pages too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, with the first preference
  useEffect(() => {
    if (cookiePref() === undefined && pref !== 'system') writePref(pref);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setPref = useCallback((next: ThemePref) => {
    writePref(next);
    const swap = () => {
      flushSync(() => setPrefState(next));
      applyPref(next);
    };
    // The page crossfades (200 ms); instant under reduced motion.
    if (!typedTransition(swap, ['theme'])) setPrefState(next);
  }, []);

  const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme needs ThemeProvider');
  return ctx;
}
