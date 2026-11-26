import { useEffect, useRef } from 'react';
import { TURNSTILE_ACTION } from '../../shared/turnstile.ts';
import { useTheme } from '../lib/theme.tsx';
import { turnstileScriptUrl } from '../lib/turnstile-script.ts';

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = turnstileScriptUrl();
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing'));
    script.onerror = () => {
      scriptPromise = undefined;
      reject(new Error('turnstile blocked'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileProps {
  siteKey: string;
  onToken: (token: string | null) => void;
  onError: () => void;
  /** Change to force a fresh challenge (tokens are single use). */
  resetKey?: number;
  /** True while the widget asks the visitor to interact; the host shows its slot only then. */
  onInteractive?: (shown: boolean) => void;
  /** The action the server expects back; the sign-in widget's by default. */
  action?: string;
}

/**
 * Cloudflare Turnstile. The production widget is invisible and `interaction-only` keeps a
 * managed fallback hidden, so the widget draws nothing unless it needs the visitor.
 */
export function Turnstile({
  siteKey,
  onToken,
  onError,
  resetKey = 0,
  onInteractive,
  action = TURNSTILE_ACTION,
}: TurnstileProps) {
  const host = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const callbacks = useRef({ onToken, onError, onInteractive });
  callbacks.current = { onToken, onError, onInteractive };

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey remounts the widget on purpose; a theme change re-renders it.
  useEffect(() => {
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;
    let live = true;
    callbacks.current.onToken(null);
    loadTurnstile()
      .then((t) => {
        if (!live || !host.current) return;
        api = t;
        widgetId = t.render(host.current, {
          sitekey: siteKey,
          action,
          theme: resolved,
          appearance: 'interaction-only',
          'before-interactive-callback': () => callbacks.current.onInteractive?.(true),
          'after-interactive-callback': () => callbacks.current.onInteractive?.(false),
          callback: (token: string) => callbacks.current.onToken(token),
          'expired-callback': () => callbacks.current.onToken(null),
          'error-callback': () => {
            callbacks.current.onToken(null);
            callbacks.current.onError();
          },
        });
      })
      .catch(() => live && callbacks.current.onError());
    return () => {
      live = false;
      callbacks.current.onInteractive?.(false);
      if (api && widgetId) api.remove(widgetId);
    };
  }, [siteKey, resetKey, resolved, action]);

  return <div ref={host} data-testid="turnstile" />;
}
