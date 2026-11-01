import { Lock } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion.ts';
import { Callout, Skeleton } from '../ui/index.ts';
import { CodeFace } from './login-code-face.tsx';
import { EmailFace } from './login-email-face.tsx';
import type { SceneActions } from './login-scene.tsx';
import { Turnstile } from './turnstile.tsx';
import { useMagicRequest } from './use-magic-request.ts';
import './login-card.css';

export const FOOTER_LINE = 'Signing in shows the passes sent to your email.';

/** One face of the hosted card: body, then the footer split off by a divider. */
function Face({
  side,
  hidden,
  title,
  lede,
  children,
}: {
  side: 'email' | 'code';
  hidden: boolean;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="wl-login-face wl-foil-edge flex flex-col overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1"
      data-side={side}
      inert={hidden}
      aria-hidden={hidden || undefined}
    >
      <div className="flex flex-1 flex-col gap-6 p-5 sm:p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.015em] text-fg-strong">{title}</h1>
          {lede ? <p className="mt-1 truncate text-sm text-fg-muted">{lede}</p> : null}
        </div>
        {children}
      </div>
      <p className="flex items-start gap-2 border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-6">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        {FOOTER_LINE}
      </p>
    </section>
  );
}

/** The front face while the session loads: the final controls' heights, so nothing shifts. */
export function EmailFaceSkeleton({ notice }: { notice: string | null }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {notice ? <Callout tone="danger">{notice}</Callout> : null}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-12" />
          <Skeleton className="h-11" />
        </div>
        <Skeleton className="h-11" />
      </div>
      <Skeleton className="h-4" />
      <Skeleton className="h-11" />
    </div>
  );
}

export interface LoginCardProps {
  next: string;
  notice: string | null;
  /** Null while the session loads. */
  methods: { oidc: boolean; magic: boolean; siteKey: string } | null;
  /** Replaces the front body (load error, nothing enabled). */
  front?: ReactNode;
  scene: SceneActions;
}

/**
 * The hosted sign-in card. Two faces share one grid cell, so the card keeps one height; sending
 * the link flips it (640 ms spring) to the code face, the far face inert. Under reduced motion
 * the faces crossfade.
 */
export function LoginCard({ next, notice, methods, front, scene }: LoginCardProps) {
  const request = useMagicRequest(next);
  const [sent, setSent] = useState<{ email: string; at: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const flipper = useRef<HTMLDivElement>(null);
  const face = sent ? 'code' : 'email';
  const turned = useRef(false);

  // Focus follows the flip: the code field once the card has turned, the email field on return.
  useEffect(() => {
    if (!turned.current) {
      turned.current = true;
      return;
    }
    const target = face === 'code' ? codeRef.current : emailRef.current;
    const el = flipper.current;
    if (!target || !el || prefersReducedMotion()) {
      target?.focus();
      return;
    }
    const done = () => target.focus();
    const t = setTimeout(done, 700);
    const end = (e: TransitionEvent) => {
      if (e.target !== el) return;
      clearTimeout(t);
      done();
    };
    el.addEventListener('transitionend', end, { once: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener('transitionend', end);
    };
  }, [face]);

  return (
    <div className="wl-login-card">
      <div ref={flipper} className="wl-login-flipper" data-face={face}>
        <Face side="email" hidden={face !== 'email'} title="Sign in">
          {front ??
            (methods ? (
              <EmailFace
                oidc={methods.oidc}
                magic={methods.magic}
                next={next}
                notice={notice}
                request={request}
                scene={scene}
                emailRef={emailRef}
                onSent={(email) => {
                  scene.send();
                  setSent({ email, at: Date.now() });
                }}
              />
            ) : (
              <EmailFaceSkeleton notice={notice} />
            ))}
        </Face>
        <Face
          side="code"
          hidden={face !== 'code'}
          title="Enter the code from your email"
          lede={
            <>
              Sent to <span className="font-medium text-fg-strong">{sent?.email ?? ''}</span>
            </>
          }
        >
          <CodeFace
            key={sent?.at ?? 0}
            email={sent?.email ?? ''}
            next={next}
            sentAt={sent?.at ?? 0}
            request={request}
            scene={scene}
            codeRef={codeRef}
            onBack={() => {
              scene.back();
              setSent(null);
            }}
          />
        </Face>
      </div>
      {methods?.magic ? (
        <div className="flex justify-center pt-4">
          <Turnstile siteKey={methods.siteKey} {...request.widget} />
        </div>
      ) : null}
    </div>
  );
}
