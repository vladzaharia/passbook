import { bumpIfStmt } from '../../platform/counters.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { PinReservationGuard } from './staff-pin.ts';

interface PinCounterScope {
  guard: PinReservationGuard;
  markerKey: string;
  personKey: string;
  personWindow: number;
  personCap: number;
  allKey: string;
  allWindow: number;
  scannerCap: number;
}

export function preparePinCounters(db: D1Database, scope: PinCounterScope) {
  const { guard, markerKey, personKey, personWindow, personCap, allKey, allWindow, scannerCap } =
    scope;
  const marker = (state: number): PinReservationGuard => ({
    sql: 'EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count=?)',
    params: [markerKey, personWindow, state],
  });
  const guarded = (predicate: PinReservationGuard): PinReservationGuard => ({
    sql: `(${guard.sql}) AND (${predicate.sql})`,
    params: [...guard.params, ...predicate.params],
  });
  const and = (
    left: PinReservationGuard,
    sql: string,
    params: readonly SqlValue[] = [],
  ): PinReservationGuard => ({
    sql: `(${left.sql}) AND (${sql})`,
    params: [...left.params, ...params],
  });
  const emptyMarker: PinReservationGuard = {
    sql: 'NOT EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=?)',
    params: [markerKey, personWindow],
  };
  const changed = (state: number) => and(marker(state), 'changes()=1');
  const underCap = (state: number, key: string, window: number, cap: number) =>
    and(
      marker(state),
      'COALESCE((SELECT count FROM counters WHERE key=? AND window_start=?),0) < ?',
      [key, window, cap],
    );
  const stmts = [
    bumpIfStmt(db, markerKey, personWindow, guarded(emptyMarker)),
    bumpIfStmt(
      db,
      personKey,
      personWindow,
      guarded(and(underCap(1, personKey, personWindow, personCap), 'changes()=1')),
    ),
    bumpIfStmt(db, markerKey, personWindow, guarded(changed(1))),
    bumpIfStmt(db, allKey, allWindow, guarded(underCap(2, allKey, allWindow, scannerCap))),
    bumpIfStmt(db, markerKey, personWindow, guarded(changed(2)), 2),
    // If the scanner is already locked, return the person's provisional reservation atomically.
    bumpIfStmt(db, personKey, personWindow, guarded(marker(2)), -1),
    bumpIfStmt(db, markerKey, personWindow, guarded(changed(2))),
  ];
  return {
    stmts,
    refundStatements(): D1PreparedStatement[] {
      const personHeld: PinReservationGuard = {
        sql: 'EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count IN (2,4))',
        params: [markerKey, personWindow],
      };
      const personStillCounted = and(
        personHeld,
        'EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count>0)',
        [personKey, personWindow],
      );
      const scannerStillCounted = and(
        marker(4),
        'EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count>0)',
        [allKey, allWindow],
      );
      return [
        bumpIfStmt(db, personKey, personWindow, personStillCounted, -1),
        bumpIfStmt(db, allKey, allWindow, scannerStillCounted, -1),
        bumpIfStmt(db, markerKey, personWindow, marker(2), -2),
        bumpIfStmt(db, markerKey, personWindow, marker(4), -4),
      ];
    },
  };
}
