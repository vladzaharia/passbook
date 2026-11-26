import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import type { Operation } from './types.ts';

// The page's operations by id, so a start mutation can put its 202 body here and every panel,
// row and the tray read one copy. A lower revision never replaces a higher one.
const ops = new Map<string, Operation>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const sub of subs) sub();
};
const subscribe = (sub: () => void) => {
  subs.add(sub);
  return () => subs.delete(sub);
};

// Ids the person started (a start mutation's 202, or the tray's `mine=true` list): the tray's rows.
const mine = new Set<string>();

/** `mine`: the person started it, so the tray lists it and its end gets a completion toast. */
export function seedOperation(op: Operation, { mine: own = false }: { mine?: boolean } = {}): void {
  if (own) mine.add(op.id);
  const have = ops.get(op.id);
  if (have && have.revision > op.revision) {
    if (own) emit();
    return;
  }
  ops.set(op.id, op);
  emit();
}

/** A start mutation's 202: the operation is in the cache and the tray, no poll needed to find it. */
export const trackOperation = (op: Operation): void => seedOperation(op, { mine: true });

let cached: readonly Operation[] = [];
let cachedAt = -1;
function mineSnapshot(): readonly Operation[] {
  if (cachedAt !== version) {
    cached = [...mine].flatMap((id) => ops.get(id) ?? []).sort((a, b) => b.createdAt - a.createdAt);
    cachedAt = version;
  }
  return cached;
}

/** The operations the person started, newest first. */
export const useMineOperations = (): readonly Operation[] =>
  useSyncExternalStore(subscribe, mineSnapshot, () => []);

export const cachedOperation = (id: string): Operation | undefined => ops.get(id);

export function useCachedOperation(id: string | null): Operation | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id ? ops.get(id) : undefined),
    () => undefined,
  );
}

export function resetOperationCache(): void {
  ops.clear();
  mine.clear();
  panels.clear();
  claims.clear();
  emit();
}

// Panels mounted now, by operation id (like ui/art/presence.ts): while one shows, the end of its
// operation needs no completion toast, and the tray opens no sheet for the same `?op`.
const panels = new Map<string, number>();

export function useRegisterOperationPanel(id: string | null): void {
  useEffect(() => {
    if (!id) return;
    panels.set(id, (panels.get(id) ?? 0) + 1);
    emit();
    return () => {
      const n = (panels.get(id) ?? 1) - 1;
      if (n <= 0) panels.delete(id);
      else panels.set(id, n);
      emit();
    };
  }, [id]);
}

// Ids an inline panel on the page owns (it restores from `?op`): the tray opens no sheet for them. Apart from
// `panels`, so the tray's own sheet, which draws a panel too, cannot claim the id it is trying to open.
const claims = new Map<string, number>();

/** A panel drawn inline claims the `?op` id it restores, even before it has the operation. Layout effect: before paint. */
export function useClaimOperation(id: string | null): void {
  useLayoutEffect(() => {
    if (!id) return;
    claims.set(id, (claims.get(id) ?? 0) + 1);
    emit();
    return () => {
      const n = (claims.get(id) ?? 1) - 1;
      if (n <= 0) claims.delete(id);
      else claims.set(id, n);
      emit();
    };
  }, [id]);
}

export const useOperationClaimed = (id: string | null): boolean =>
  useSyncExternalStore(
    subscribe,
    () => (id ? (claims.get(id) ?? 0) > 0 : false),
    () => false,
  );

export const isOperationOnScreen = (id: string): boolean => (panels.get(id) ?? 0) > 0;

export const useOperationOnScreen = (id: string | null): boolean =>
  useSyncExternalStore(
    subscribe,
    () => (id ? isOperationOnScreen(id) : false),
    () => false,
  );

export const storeVersion = () => version;
