import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
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

/**
 * Providers call this after first paint, so the Radix chunk stays out of the initial load. The
 * scanner never calls it (it uses no tooltips); its controls would stay plain.
 */
export function loadTooltips(): Promise<void> {
  loading ??= import('./tooltip-impl.tsx').then(
    (m) => {
      impl = m.TooltipImpl;
    },
    () => {
      // chunk-reload.ts reloads a stale deploy; offline, tooltips stay plain for this page load
      // and every control keeps its aria-label.
      loading = null;
    },
  );
  return loading;
}

/**
 * The implementation is fixed when a tooltip mounts: swapping it in later would remount the child
 * (lost focus, a menu closing under the click). A control that mounted before the chunk arrived
 * stays plain until it remounts; its aria-label still names it.
 */
export function Tooltip({ content, children, side, className }: TooltipProps) {
  const [Loaded] = useState(() => impl);
  const config = useContext(ConfigContext);
  if (content === null || content === undefined || content === '') return children;
  if (!Loaded) return children;
  return (
    <Loaded content={content} side={side} className={className} config={config}>
      {children}
    </Loaded>
  );
}
