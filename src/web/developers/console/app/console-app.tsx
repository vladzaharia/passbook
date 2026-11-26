import type { Session } from '../session.ts';
import { ConsolePage } from './console-page.tsx';
import { CreateSandbox } from './create-sandbox.tsx';
import { sessionState } from './states.tsx';

/** The Console tool: its state cards without a ready sandbox, else the index and the stage. */
export function ConsoleApp({ session }: { session: Exclude<Session, { kind: 'out' }> }) {
  const state = sessionState(
    session,
    session.kind === 'none' ? (
      <CreateSandbox
        csrf={session.csrf}
        siteKey={session.siteKey}
        onReady={() => {
          // A fresh document: the Turnstile script does not stay beside the tokens.
          location.reload();
        }}
      />
    ) : undefined,
  );
  if (state) return state;
  return session.kind === 'ready' ? (
    <ConsolePage sandbox={session.sandbox} csrf={session.csrf} />
  ) : null;
}
