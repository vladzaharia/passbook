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
export const THEME_KEY = 'wallet-theme';

function isPref(value: unknown): value is ThemePref {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isPref(stored) ? stored : 'system';
  } catch {
    // Storage can be blocked (private mode); the theme then follows the system.
    return 'system';
  }
}

export function applyPref(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  root.dataset.themePref = pref;
}

const systemTheme = (): 'light' | 'dark' =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? systemTheme() : pref;
}

interface ThemeContextValue {
  /** The stored admin preference. */
  pref: ThemePref;
  /** The theme on screen: the preference inside the admin shell, the system elsewhere. */
  resolved: 'light' | 'dark';
  setPref: (pref: ThemePref) => void;
  /** Called by the admin shell while mounted (useThemeScope). */
  setScoped: (scoped: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** A same-document View Transition with types, or undefined where unsupported. */
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

/**
 * The admin theme. The preference applies only inside the admin shell; holder surfaces (portal,
 * login) follow the system appearance and have no toggle.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  // theme-init.js applied the preference before paint on /admin; start from the same state.
  const [scoped, setScoped] = useState(
    () => typeof location !== 'undefined' && /^\/admin(\/|$)/.test(location.pathname),
  );
  const [system, setSystem] = useState(systemTheme);
  const active = scoped ? pref : 'system';

  useEffect(() => {
    applyPref(active);
  }, [active]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystem(systemTheme());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setPref = useCallback(
    (next: ThemePref) => {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Not persisted when storage is blocked; the choice still applies for this page.
      }
      const swap = () => {
        flushSync(() => setPrefState(next));
        if (scoped) applyPref(next);
      };
      // Admin theme change crossfades the page (200 ms); instant under reduced motion.
      if (!scoped || !typedTransition(swap, ['theme'])) setPrefState(next);
    },
    [scoped],
  );

  const resolved = active === 'system' ? system : active;
  const value = useMemo(() => ({ pref, resolved, setPref, setScoped }), [pref, resolved, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme needs ThemeProvider');
  return ctx;
}

/** The admin shell calls this: its theme preference applies while it is mounted. */
export function useThemeScope(): void {
  const { setScoped } = useTheme();
  useEffect(() => {
    setScoped(true);
    return () => setScoped(false);
  }, [setScoped]);
}
