import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { sessionOperationsClient } from '../lib/operations-client.ts';
import { sessionQuery } from '../lib/session.ts';
import { onSessionEnd } from '../lib/session-signal.ts';
import {
  isTerminal,
  OperationsProvider,
  trackOperation,
  useClaimOperation,
  useOperation,
  useOperationParam,
} from '../ui/operation/index.ts';
import { resetOperationCache, useMineOperations } from '../ui/operation/store.ts';
import { myPassesKey } from './api.ts';

export interface FollowOptions {
  /** Starts the same action again: the sheet's Retry. A holder reaches no server retry, so the page does it. */
  restart?: () => void;
  /** Opens the sheet now. Off, it opens only if the operation fails, so Retry is in reach. */
  open?: boolean;
}

interface Holder {
  follow: (id: string, options?: FollowOptions) => void;
}

// The panel, the buddy and the sheet load when a sheet opens, not with the portal.
const HolderSheet = lazy(() => import('./holder-sheet.tsx'));

const Context = createContext<Holder>({ follow: () => undefined });

/** The holder's actions start operations; this follows them and shows the one a person opens. */
export const useHolderOperations = (): Holder => useContext(Context);

/** Puts one started operation in the page's cache and the tray, and calls back once if it fails. */
function Follow({ id, onFailed }: { id: string; onFailed: () => void }) {
  const { operation } = useOperation(id);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const told = useRef(false);
  useEffect(() => {
    if (operation) trackOperation(operation);
    if (operation?.status === 'failed' && !told.current) {
      told.current = true;
      failed.current();
    }
  }, [operation]);
  return null;
}

const HOLDER_KIND = /^holder\./;

/** One provider for the portal: the sheet, and a fresh My passes when a holder operation ends. */
export function HolderOperationsProvider({ children }: { children: ReactNode }) {
  const client = useMemo(sessionOperationsClient, []);
  const queries = useQueryClient();
  const [id, setId] = useOperationParam();
  // A reload restores the sheet from `?op`; the tray opens none for an id this sheet owns.
  useClaimOperation(id);
  // The tray read the same `?op` when it mounted: it must not open that one when this sheet moves on to another.
  const [restored] = useState(id);
  useClaimOperation(restored);
  const [followed, setFollowed] = useState<readonly string[]>([]);
  const restarts = useRef(new Map<string, () => void>());

  const follow = useCallback(
    (opId: string, { restart, open = true }: FollowOptions = {}) => {
      if (restart) restarts.current.set(opId, restart);
      setFollowed((ids) => (ids.includes(opId) ? ids : [...ids, opId]));
      if (open) setId(opId);
    },
    [setId],
  );

  // An operation that ends changes what My passes shows (a pass leaves, a refresh lands).
  const mine = useMineOperations();
  const ended = useRef(new Set<string>());
  useEffect(() => {
    for (const op of mine) {
      if (!HOLDER_KIND.test(op.kind) || !isTerminal(op.status) || ended.current.has(op.id))
        continue;
      ended.current.add(op.id);
      void queries.invalidateQueries({ queryKey: myPassesKey });
    }
  }, [mine, queries]);

  // Another tab signed out or switched account: this tab drops what it holds and asks who it is now.
  useEffect(
    () =>
      onSessionEnd(() => {
        resetOperationCache();
        setFollowed([]);
        void queries.invalidateQueries({ queryKey: sessionQuery.queryKey });
      }),
    [queries],
  );

  const value = useMemo(() => ({ follow }), [follow]);
  return (
    <OperationsProvider client={client}>
      <Context.Provider value={value}>
        {children}
        {followed.map((opId) => (
          <Follow key={opId} id={opId} onFailed={() => setId(opId)} />
        ))}
        {id ? (
          <Suspense fallback={null}>
            <HolderSheet
              id={id}
              restart={restarts.current.get(id)}
              follow={follow}
              onClose={() => setId(null)}
            />
          </Suspense>
        ) : null}
      </Context.Provider>
    </OperationsProvider>
  );
}
