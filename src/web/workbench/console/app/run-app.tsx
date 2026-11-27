import { useEffect, useMemo, useState } from 'react';
import { tryClient } from '../client.ts';
import { loadIndex } from '../data.ts';
import type { Session } from '../session.ts';
import { retain } from '../token.ts';
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
  const csrf = session.kind === 'ready' ? session.csrf : null;
  const client = useMemo(() => (csrf ? tryClient(csrf) : null), [csrf]);
  // A console is open: keep a fresh try token for it.
  useEffect(() => (csrf ? retain(csrf) : undefined), [csrf]);
  const state = sessionState(session);
  if (state) return state;
  if (session.kind !== 'ready' || !client) return null;
  return (
    <Ready
      client={client}
      templateId={session.sandbox.templateId}
      mode={mode}
      slug={slug}
      opId={opId}
      codes={codes}
    />
  );
}
