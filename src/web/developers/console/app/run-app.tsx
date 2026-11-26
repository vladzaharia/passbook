import { useEffect, useState } from 'react';
import { loadIndex } from '../data.ts';
import type { Session } from '../session.ts';
import { Ready } from './ready.tsx';
import { sessionState } from './states.tsx';

export interface RunAppProps {
  session: Exclude<Session, { kind: 'out' }>;
  mode: 'op' | 'sheet';
  slug?: string | undefined;
  opId?: string | undefined;
}

/** The Try it of a reference page (`op`) or its phone sheet (`sheet`): one operation's console. */
export function RunApp({ session, mode, slug, opId }: RunAppProps) {
  const [codes, setCodes] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void loadIndex().then(
      (i) => setCodes(new Set(i.codes)),
      (error: unknown) => reportError(error),
    );
  }, []);
  const state = sessionState(session);
  if (state) return state;
  if (session.kind !== 'ready') return null;
  return (
    <Ready
      sandbox={session.sandbox}
      csrf={session.csrf}
      mode={mode}
      slug={slug}
      opId={opId}
      codes={codes}
    />
  );
}
