import { useEffect, useRef } from 'react';
import { useTheme } from '../lib/theme.tsx';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

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
    script.src = SCRIPT_SRC;
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
}

export function Turnstile({ siteKey, onToken, onError, resetKey = 0 }: TurnstileProps) {
  const host = useRef<HTMLDivElement>(null);
  const { resolved } = useTheme();
  const callbacks = useRef({ onToken, onError });
  callbacks.current = { onToken, onError };

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
          theme: resolved,
          // The production widget is invisible; this keeps a managed fallback hidden unless needed.
          appearance: 'interaction-only',
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
      if (api && widgetId) api.remove(widgetId);
    };
  }, [siteKey, resetKey, resolved]);

  return <div ref={host} data-testid="turnstile" />;
}
