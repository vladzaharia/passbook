import {
  type ComponentType,
  cloneElement,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

export interface TooltipConfig {
  delayDuration?: number;
}

const ConfigContext = createContext<TooltipConfig>({});

export function TooltipProvider({ children, ...config }: TooltipConfig & { children: ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

type Impl = ComponentType<TooltipProps & { config: TooltipConfig }>;

let impl: Impl | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/**
 * Providers call this after first paint, so the Radix chunk stays out of the initial load. The
 * scanner never calls it (it uses no tooltips); its controls would stay plain.
 */
export function loadTooltips(): Promise<void> {
  loading ??= import('./tooltip-impl.tsx').then(
    (m) => whenNoTipFocused(() => swapIn(m.TooltipImpl)),
    () => {
      // chunk-reload.ts reloads a stale deploy; offline, tooltips stay plain for this page load
      // and every control keeps its aria-label.
      loading = null;
    },
  );
  return loading;
}

function swapIn(next: Impl) {
  impl = next;
  for (const l of listeners) l();
}

/** The DOM used here, typed locally: the worker typecheck (via pass-card) has no DOM lib. */
interface FocusDocument {
  activeElement: { closest(selector: string): unknown } | null;
  addEventListener(type: 'focusout', listener: () => void): void;
  removeEventListener(type: 'focusout', listener: () => void): void;
}
const focusDoc = () => (globalThis as unknown as { document: FocusDocument }).document;

/** The swap remounts each tooltip's child, so wait while one holds focus (a keyboard user). */
function whenNoTipFocused(run: () => void) {
  const doc = focusDoc();
  const tipFocused = () => doc.activeElement?.closest('[data-tip]') != null;
  if (!tipFocused()) return run();
  const onOut = () =>
    setTimeout(() => {
      if (tipFocused()) return;
      doc.removeEventListener('focusout', onOut);
      run();
    }, 0);
  doc.addEventListener('focusout', onOut);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function Tooltip({ content, children, side, className }: TooltipProps) {
  const Loaded = useSyncExternalStore(subscribe, () => impl);
  const config = useContext(ConfigContext);
  if (content === null || content === undefined || content === '') return children;
  if (!Loaded) return cloneElement(children, { 'data-tip': '' } as Record<string, string>);
  return (
    <Loaded content={content} side={side} className={className} config={config}>
      {children}
    </Loaded>
  );
}
