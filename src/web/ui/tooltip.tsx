import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

export interface TooltipConfig {
  delayDuration?: number;
  skipDelayDuration?: number;
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

/** Providers call this after first paint, so the Radix chunk stays out of the initial load. */
export function loadTooltips(): Promise<void> {
  loading ??= import('./tooltip-impl.tsx').then(
    (m) => {
      impl = m.TooltipImpl;
      for (const l of listeners) l();
    },
    () => {
      // A chunk that fails to load (offline, a deploy mid-session) leaves tooltips plain; every
      // control keeps its aria-label. The next call retries.
      loading = null;
    },
  );
  return loading;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function Tooltip({ content, children, side, className }: TooltipProps) {
  const Loaded = useSyncExternalStore(subscribe, () => impl);
  const config = useContext(ConfigContext);
  if (content === null || content === undefined || content === '') return children;
  if (!Loaded) return children;
  return (
    <Loaded content={content} side={side} className={className} config={config}>
      {children}
    </Loaded>
  );
}
