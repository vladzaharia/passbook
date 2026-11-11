import { Lock } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { SIGN_IN_FOOTER } from '@/shared/copy/sign-in.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { Callout, Skeleton } from '../ui/index.ts';
import { CodeFace } from './login-code-face.tsx';
import { EmailFace } from './login-email-face.tsx';
import type { SceneActions } from './login-scene.tsx';
import { Turnstile } from './turnstile.tsx';
import { useMagicRequest } from './use-magic-request.ts';
import './login-card.css';

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
          {lede ? <p className="mt-1 break-words text-sm text-fg-muted">{lede}</p> : null}
        </div>
        {children}
      </div>
      <p className="flex items-start gap-2 border-t border-border px-5 py-4 text-sm text-fg-muted sm:px-6">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        {SIGN_IN_FOOTER}
      </p>
    </section>
  );
}

/** The front face while the session loads: the final controls' heights, so nothing shifts. */
export function EmailFaceSkeleton({ notice }: { notice: string | null }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      {notice ? <Callout>{notice}</Callout> : null}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-12" />
          <Skeleton className="h-9 pointer-coarse:h-11" />
        </div>
        <Skeleton className="h-9 pointer-coarse:h-11" />
      </div>
      <Skeleton className="h-4" />
      <Skeleton className="h-9 pointer-coarse:h-11" />
    </div>
  );
}

export interface LoginCardProps {
  /** A safe path to return to, or null for the landing rule. */
  next: string | null;
  /** One line from ?reason= above the form. */
  notice: string | null;
  /** Null while the session loads. */
  methods: { oidc: boolean; magic: boolean; siteKey: string } | null;
  /** Replaces the front body (load error, nothing enabled). */
  front?: ReactNode;
  scene: SceneActions;
}

/**
 * The hosted sign-in card. Two faces share one grid cell, so the card keeps one height; sending
 * the link posts the top card and flips this one (640 ms spring) to the code face, the far face
 * inert. Under reduced motion the faces crossfade.
 */
export function LoginCard({ next, notice, methods, front, scene }: LoginCardProps) {
  const request = useMagicRequest(next);
  // The challenge slot stays collapsed unless Turnstile needs the visitor (managed fallback).
  const [challengeShown, setChallengeShown] = useState(false);
  const [sent, setSent] = useState<{ email: string; at: number } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const face = sent ? 'code' : 'email';
  const lastFace = useRef(face);

  // Focus follows the flip: the code field once the card faces front (the spring is face-on by
  // then; the 120 ms wait is in login-card.css), the email field on return.
  useEffect(() => {
    if (lastFace.current === face) return;
    lastFace.current = face;
    const target = face === 'code' ? codeRef.current : emailRef.current;
    if (!target || prefersReducedMotion()) {
      target?.focus();
      return;
    }
    const t = setTimeout(() => target.focus(), face === 'code' ? 500 : 360);
    return () => clearTimeout(t);
  }, [face]);

  return (
    <div className="wl-login-card">
      <div className="wl-login-flipper" data-face={face}>
        <Face
          side="email"
          hidden={face !== 'email'}
          title="Sign in"
          lede={
            methods?.oidc && !methods.magic
              ? 'Continue with your organization to access your account.'
              : undefined
          }
        >
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
          title="Enter the code"
          lede={
            <>
              Check <span className="font-medium text-fg-strong">{sent?.email ?? ''}</span> for a
              code.
            </>
          }
        >
          <CodeFace
            key={sent?.at ?? 0}
            email={sent?.email ?? ''}
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
        <div
          className={challengeShown ? 'flex justify-center pt-4' : 'h-0 overflow-hidden'}
          data-shown={challengeShown || undefined}
        >
          <Turnstile
            siteKey={methods.siteKey}
            {...request.widget}
            onInteractive={setChallengeShown}
          />
        </div>
      ) : null}
    </div>
  );
}
