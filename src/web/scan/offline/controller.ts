/**
 * Offline check-in for one scanning session: decides reads while the connection is down, keeps the
 * list fresh and the queue draining while it is up. The machine only sees verdicts and counts.
 */
import type { OfflineMode } from '../../../shared/scan-offline.ts';
import { todayKey } from '../../lib/format.ts';
import { localOutcome } from '../machine/outcome.ts';
import type { ClockPort } from '../machine/ports.ts';
import type { Counts, ScanInput, ScanOutcome } from '../machine/types.ts';
import { decide } from './decide.ts';
import { rosterHash } from './hash.ts';
import { pendingOf, type QueueStore } from './queue-store.ts';
import { type QueueView, queueView } from './queue-view.ts';
import type { RosterApi, RosterStore } from './roster.ts';
import { type BatchApi, syncQueue } from './sync.ts';
import type { KeyValue } from './wipe.ts';

const REFRESH_MS = 60_000;
const DRAIN_MS = 15_000;
const BACKOFF_MS = [2000, 4000, 8000, 16_000, 32_000, 60_000] as const;
const CONFLICTS = 'conflicts';
/** A scan code is 26 base32 characters, a print code `P` plus 26; a typed one may be lower case, spaced or dashed. */
const SCAN_CODE = /^P?[A-Z2-7]{26}$/;

export interface OfflineEmit {
  outcome(key: string, outcome: ScanOutcome): void;
  queue(q: { pending: number; oldestAt: number | null; conflicts: number }): void;
  status(s: { listAt: number | null; syncing: boolean }): void;
}

export interface OfflineDeps {
  mode: Exclude<OfflineMode, 'stop'>;
  scannerId: string;
  api: RosterApi & BatchApi;
  queue: QueueStore;
  roster: RosterStore;
  meta: KeyValue<number>;
  clock: ClockPort;
  online(): boolean;
  /** The session and config revision the door is running now. A list cut for another is stale. */
  scope(): string;
  /** The venue's zone: a daily `in` lasts one day there. */
  timeZone(): string;
  counts(): Counts | null;
  emit: OfflineEmit;
}

/** The hashes a read could be on the list as: the code as read, and its scan-code form. */
async function hashesOf(code: string): Promise<string[]> {
  const read = code.trim();
  const canonical = read.toUpperCase().replace(/[\s-]/g, '');
  const forms = SCAN_CODE.test(canonical) && canonical !== read ? [read, canonical] : [read];
  return Promise.all(forms.map(rosterHash));
}

/** How long an online request waits for the queue to be sent. */
const SYNC_WAIT_MS = 30_000;

export function createOfflineController(d: OfflineDeps) {
  const dayOf = (t: number) => todayKey(d.timeZone(), t);
  let timer: unknown = null;
  let stopped = false;
  let running = false;
  let failures = 0;
  let refreshedAt = 0;
  let conflicts = 0;

  async function publish(syncing = false) {
    const stamp = await d.roster.meta();
    const live =
      d.mode === 'list' &&
      stamp !== null &&
      stamp.scopeKey === d.scope() &&
      stamp.validUntil > d.clock.now();
    d.emit.status({ listAt: live ? stamp.asOf : null, syncing });
    d.emit.queue({ ...pendingOf(await d.queue.all()), conflicts });
  }

  /** One pass: top up the list, then send what is queued. A failure backs the next pass off. */
  let current: Promise<void> | null = null;
  function cycle(): Promise<void> {
    if (running || stopped) return current ?? Promise.resolve();
    current = run();
    return current;
  }
  async function run() {
    running = true;
    try {
      if (d.online()) {
        const now = d.clock.now();
        // The queue goes first: the server dates a read no earlier than the last list it served, so a
        // refresh before the send would make every read queued on the old list late.
        if ((await d.queue.all()).length > 0) {
          await publish(true);
          const result = await syncQueue(d.api, d.queue, await d.roster.meta());
          conflicts += result.conflicts;
          if (result.conflicts > 0) await d.meta.set(CONFLICTS, conflicts);
        }
        if (d.mode === 'list' && now - refreshedAt >= REFRESH_MS) {
          await d.roster.refresh(d.api, now, d.scope(), dayOf);
          refreshedAt = now;
        }
      }
      failures = 0;
    } catch (error) {
      // The connection or the server failed; the queue is intact and the same keys go up again.
      void error;
      failures += 1;
    } finally {
      running = false;
      await publish().catch((error: unknown) => void error);
      schedule();
    }
  }

  function schedule() {
    if (stopped) return;
    if (timer !== null) d.clock.clearTimeout(timer);
    const wait =
      failures > 0 ? (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? DRAIN_MS) : DRAIN_MS;
    timer = d.clock.setTimeout(() => void cycle(), wait);
  }

  return {
    /** Loads what a reload left, then starts the loop. */
    async start() {
      conflicts = (await d.meta.get(CONFLICTS)) ?? 0;
      await publish();
      void cycle();
    },
    /** A read with no connection. The verdict goes back to the machine under the same key. */
    async decide(key: string, input: ScanInput, unverified: boolean) {
      const code = input.code?.trim() ?? '';
      const now = d.clock.now();
      // A card picked from a search has no code to hash or send: it needs a connection.
      if (!code) {
        d.emit.outcome(key, localOutcome('system', 'network', d.counts()));
        return;
      }
      const hashes = d.mode === 'list' ? await hashesOf(code) : [];
      const stamp = await d.roster.meta();
      const fresh = stamp !== null && stamp.scopeKey === d.scope() && stamp.validUntil > now;
      const found = fresh ? await d.roster.find(hashes) : null;
      // A daily `in` from an earlier venue day no longer holds.
      const entry =
        found?.day && found.state === 'in' && found.inDay !== dayOf(now)
          ? { ...found, state: null }
          : found;
      const verdict = decide({
        mode: d.mode,
        unverified,
        entry,
        listAt: fresh && stamp ? stamp.asOf : null,
        counts: d.counts(),
        now,
      });
      if (verdict.door) {
        await d.queue.add({
          key,
          scannerId: d.scannerId,
          code,
          method: input.method,
          clientTs: now,
          door: verdict.door,
        });
        if (verdict.markIn) for (const h of hashes) await d.roster.markIn(h, dayOf(now));
      }
      d.emit.outcome(key, verdict.outcome);
      await publish();
    },
    /** The session or its config changed: the list is stale; fetch the new one now. */
    rescope() {
      refreshedAt = 0;
      void publish().then(() => this.kick());
    },
    /** The queue as the shift sheet lists it. */
    async queueRows(): Promise<QueueView[]> {
      return queueView(await d.queue.all());
    },
    /**
     * Send what is queued before an online request, waiting for it (30 s at most). A failed sync, no
     * connection or an empty queue returns at once: the request goes on.
     */
    async syncNow() {
      if (stopped || !d.online() || (await d.queue.all()).length === 0) return;
      await Promise.race([
        cycle(),
        new Promise<void>((resolve) => setTimeout(resolve, SYNC_WAIT_MS)),
      ]);
    },
    /** Sync now: the button, `online` and a return to the page. */
    kick() {
      failures = 0;
      void cycle();
    },
    dispose() {
      stopped = true;
      if (timer !== null) d.clock.clearTimeout(timer);
    },
  };
}

export type OfflineController = ReturnType<typeof createOfflineController>;
