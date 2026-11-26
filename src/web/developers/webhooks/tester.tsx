import { useEffect, useState } from 'react';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';
import type { TesterAuth } from './client.ts';
import { Notice, Workspace } from './workspace.tsx';

export function Tester({
  connect,
  types,
}: {
  connect: () => Promise<TesterAuth>;
  types: readonly string[];
}) {
  const [auth, setAuth] = useState<TesterAuth | 'loading' | 'error'>('loading');
  const [pending, setPending] = useState(connect);
  useEffect(() => {
    let live = true;
    setAuth('loading');
    pending.then(
      (a) => live && setAuth(a),
      () => live && setAuth('error'),
    );
    return () => {
      live = false;
    };
  }, [pending]);

  if (auth === 'loading') return <Notice title="Opening your sandbox">One moment.</Notice>;
  if (auth === 'error')
    return (
      <Notice title="Could not open the tester">
        <button type="button" className="btn outline sm" onClick={() => setPending(connect())}>
          Try again
        </button>
      </Notice>
    );
  if (auth.kind === 'signed-out')
    return (
      <Gate
        title={GATE_COPY.lines.webhooks}
        next={PATHS.webhooks}
        docs={`${PATHS.reference}/webhook-endpoints`}
      />
    );
  if (auth.kind === 'no-sandbox')
    return (
      <Notice title="Make your sandbox first">
        <a className="btn" href="/developers/quickstart">
          Open the quickstart
        </a>
      </Notice>
    );
  return <Workspace api={auth.api} types={types} />;
}
