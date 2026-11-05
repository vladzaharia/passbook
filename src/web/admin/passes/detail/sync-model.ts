import type { PassEventDto } from '@/shared/contracts/events.ts';
import { humanizeStatus } from '../../../lib/status.ts';

/** First 8 of the 12 hex characters: enough to tell devices apart in a row. */
export const shortDevice = (hash: string) => hash.slice(0, 8);

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** "12 s", "3 min", "2 h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Apple's and the transport's words, in plain ones. The raw reason stays under Details. */
export function pushReason(reason: string): string {
  if (reason.startsWith('NetworkError')) return 'Could not reach Apple';
  if (/^(BadDeviceToken|Unregistered|DeviceTokenNotForTopic|push_gone)$/.test(reason))
    return 'Device token no longer valid';
  if (/ProviderToken$/.test(reason)) return 'Apple rejected the push key';
  if (reason === 'PushUnavailable') return 'Push is not set up';
  if (reason === 'TooManyRequests') return 'Apple is limiting pushes';
  return 'Apple rejected the push';
}

/** What happened to one version after it was published. */
export interface SyncFact {
  text: string;
  tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
}

export interface SyncRow {
  id: string;
  /** Newest event of the row. */
  at: number;
  title: string;
  /** A group is a version and what followed it; a single row is one event. */
  group: boolean;
  tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  facts: SyncFact[];
  /** Newest first. */
  events: PassEventDto[];
  /** The message or schedule behind the row. */
  broadcastId?: string;
  /** Repeats folded into one row ("opened 12 times"): the row's time is the latest. */
  folded?: boolean;
}

/** Kinds that carry a `version` and belong to the push cycle of that version. */
const CYCLE = new Set([
  'pass.issued',
  'pass.updated',
  'pass.removed',
  'pass.restored',
  'push.queued',
  'push.sent',
  'push.failed',
  'device.fetched',
]);

const isFile = (e: PassEventDto) => e.kind === 'device.fetched' && e.data.step === 'file';
const versionOf = (e: PassEventDto) => num(e.data.version);

/** Events that open a version: what changed. */
const HEAD_TITLE: Record<string, (v: number) => string> = {
  'pass.issued': (v) => `Issued v${v}`,
  'pass.updated': (v) => `Updated to v${v}`,
  'pass.removed': (v) => `Removed from Wallet (v${v})`,
  'pass.restored': (v) => `Restored (v${v})`,
};

const SINGLE_TITLE: Record<string, string> = {
  'pass.voided': 'Voided',
  'pass.unvoided': 'Unvoided',
  'pass.link_rotated': 'Link rotated',
  'email.queued': 'Email queued',
  'email.sent': 'Email sent',
  'email.failed': 'Email failed',
  'email.captured': 'Email captured in the Test inbox',
  'page.opened': 'Pass page opened',
  'pass.downloaded': '.pkpass downloaded',
  'bundle.opened': 'Bundle page opened',
  'bundle.downloaded': 'Bundle downloaded',
  'device.registered': 'Device added the pass',
  'device.unregistered': 'Stopped updates',
  'device.log': 'Wallet log line',
  'push.sent': 'Push sent',
  'push.failed': 'Push failed',
  'push.queued': 'Push queued',
  'device.fetched': 'Device fetched the pass',
  'message.applied': 'Message applied',
  'schedule.applied': 'Scheduled change applied',
  'scan.checked_in': 'Checked in',
  'scan.redeemed': 'Redeemed',
  'scan.adjusted': 'Balance adjusted',
  'scan.rejected': 'Scan rejected',
};

const FAILED = new Set(['email.failed', 'push.failed', 'scan.rejected']);

function singleTitle(e: PassEventDto): string {
  if (e.kind === 'device.unregistered' && e.data.reason === 'push_gone')
    return 'Stopped updates: device token no longer valid';
  if (e.kind === 'device.fetched')
    return e.data.step === 'listed' ? 'Device checked for updates' : 'Device fetched the pass';
  const head = HEAD_TITLE[e.kind];
  const v = versionOf(e);
  if (head && v !== null) return head(v);
  return SINGLE_TITLE[e.kind] ?? e.kind;
}

/** One short label for an event inside a row's expanded list. */
export function eventLabel(e: PassEventDto): string {
  switch (e.kind) {
    case 'push.sent':
      return 'Push sent';
    case 'push.failed':
      return 'Push failed';
    case 'push.queued':
      return 'Push queued';
    case 'device.fetched':
      return e.data.step === 'listed' ? 'Checked for updates' : 'Fetched the pass';
    case 'device.unregistered':
      return 'Stopped updates';
    default:
      return SINGLE_TITLE[e.kind] ?? humanizeStatus(e.kind);
  }
}

/** Raw codes for the Details disclosure; never part of the inline line. */
export function eventCodes(e: PassEventDto): string | null {
  const parts = [str(e.data.code), e.kind === 'push.failed' ? str(e.data.reason) : null].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length ? parts.join(' · ') : null;
}

/** Why a single event looks the way it does, as one short line. Codes are left to eventCodes. */
export function eventDetail(e: PassEventDto): string | null {
  const parts: string[] = [];
  const v = versionOf(e);
  if (v !== null && !HEAD_TITLE[e.kind]) parts.push(`v${v}`);
  const status = num(e.data.status);
  if (status !== null) parts.push(`HTTP ${status}`);
  const reason = str(e.data.reason);
  if (reason && e.kind !== 'device.unregistered')
    parts.push(e.kind === 'push.failed' ? pushReason(reason) : reason);
  const line = str(e.data.line);
  if (line) parts.push(line);
  return parts.length ? parts.join(' · ') : null;
}

/** Whether holders were told, or silenced over the daily limit. */
function notifyFacts(data: PassEventDto['data']): SyncFact[] {
  if (data.overBudget === true) return [{ text: 'Silent: daily limit reached', tone: 'warning' }];
  return data.notified === true ? [{ text: 'Notified', tone: 'info' }] : [];
}

function single(e: PassEventDto): SyncRow {
  const message = e.kind === 'message.applied' || e.kind === 'schedule.applied';
  const broadcastId = message ? str(e.data.broadcastId) : null;
  return {
    id: e.id,
    at: e.at,
    title: singleTitle(e),
    group: false,
    tone: FAILED.has(e.kind) ? 'danger' : 'neutral',
    facts: message ? notifyFacts(e.data) : [],
    events: [e],
    ...(broadcastId ? { broadcastId } : {}),
  };
}

/** Repeats that would bury what matters when each had its own row. */
const FOLD_TITLE: Record<string, string> = {
  'page.opened': 'Pass page opened',
  'bundle.opened': 'Bundle page opened',
  'pass.downloaded': '.pkpass downloaded',
  'device.fetched': 'Devices checked for updates',
};
const foldKey = (row: SyncRow): string | null => {
  const e = row.events[0];
  if (row.group || !e || !(e.kind in FOLD_TITLE)) return null;
  if (e.kind === 'device.fetched' && e.data.step !== 'listed') return null;
  return e.kind;
};

/** Consecutive rows of one repeating kind become one expandable row. */
function fold(rows: SyncRow[]): SyncRow[] {
  const out: SyncRow[] = [];
  let run: SyncRow[] = [];
  const flush = () => {
    if (run.length > 1) {
      const events = run.flatMap((r) => r.events);
      const kind = foldKey(run[0] as SyncRow) as string;
      out.push({
        id: (run[0] as SyncRow).id,
        at: (run[0] as SyncRow).at,
        title: `${FOLD_TITLE[kind]} ${events.length} times`,
        group: true,
        folded: true,
        tone: 'neutral',
        facts: [],
        events,
      });
    } else out.push(...run);
    run = [];
  };
  for (const row of rows) {
    const key = foldKey(row);
    if (key && run.length > 0 && foldKey(run[0] as SyncRow) === key) run.push(row);
    else {
      flush();
      if (key) run = [row];
      else out.push(row);
    }
  }
  flush();
  return out;
}

/** Facts for the push cycle of one version, e.g. "Pushed to 2 devices · 1 fetched in 12 s". */
function cycle(version: number, events: PassEventDto[]): SyncRow {
  const newestFirst = [...events].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const oldest = newestFirst.at(-1) as PassEventDto;
  const head = newestFirst.find((e) => HEAD_TITLE[e.kind]);
  const queued = newestFirst.find((e) => e.kind === 'push.queued');
  const sent = newestFirst.filter((e) => e.kind === 'push.sent');
  const failed = newestFirst.filter((e) => e.kind === 'push.failed');
  const fetched = newestFirst.filter(isFile);
  const unregistered = newestFirst.filter((e) => e.kind === 'device.unregistered');
  const facts: SyncFact[] = [];

  // The count at queue time can be stale: devices that registered since still sent or fetched.
  const registered = num(queued?.data.devices);
  const seen = sent.length > 0 || failed.length > 0 || fetched.length > 0;
  if (head?.kind === 'pass.updated') facts.push(...notifyFacts(head.data));
  if (queued && registered === 0 && !seen)
    facts.push({ text: 'No devices registered', tone: 'neutral' });
  else if (sent.length > 0) {
    const n = new Set(sent.map((e) => e.device)).size;
    facts.push({ text: `Pushed to ${plural(n, 'device')}`, tone: 'info' });
  } else if (queued && !seen) facts.push({ text: 'Push queued', tone: 'neutral' });

  const unavailable = failed.filter((e) => e.data.code === 'PUSH_UNAVAILABLE');
  if (unavailable.length > 0) facts.push({ text: 'Push is not set up', tone: 'danger' });
  const rejected = failed.filter((e) => e.data.code !== 'PUSH_UNAVAILABLE');
  if (rejected.length > 0) {
    const reason = str(rejected[0]?.data.reason);
    facts.push({
      text: `${plural(new Set(rejected.map((e) => e.device)).size, 'push', 'pushes')} failed${reason ? `: ${pushReason(reason)}` : ''}`,
      tone: 'danger',
    });
  }
  if (fetched.length > 0) {
    const first = fetched.at(-1) as PassEventDto;
    const start = (queued ?? sent.at(-1) ?? oldest).at;
    const devices = new Set(fetched.flatMap((e) => (e.device ? [e.device] : []))).size;
    const count = devices > 0 ? devices : fetched.length;
    facts.push({
      text: `${count} fetched${first.at >= start ? ` in ${duration(first.at - start)}` : ''}`,
      tone: 'success',
    });
  } else if (sent.length > 0) facts.push({ text: 'Not fetched yet', tone: 'warning' });
  if (unregistered.length > 0) {
    const n = new Set(unregistered.map((e) => e.device)).size;
    facts.push({ text: `${plural(n, 'device')} stopped updates`, tone: 'neutral' });
  }

  const title = head ? singleTitle(head) : `Version ${version}`;
  const tone: SyncRow['tone'] = facts.some((f) => f.tone === 'danger')
    ? 'danger'
    : fetched.length > 0
      ? 'success'
      : facts.some((f) => f.tone === 'warning')
        ? 'warning'
        : 'info';
  return {
    id: `v${version}`,
    at: (newestFirst[0] as PassEventDto).at,
    title,
    group: newestFirst.length > 1,
    tone,
    facts,
    events: newestFirst,
  };
}

/**
 * Folds the ledger into rows: each version's change, push and fetches become one row; everything
 * else stays a row of its own. Input and output are newest first. Fetches that were not credited
 * to a device (version only) still join the version they fetched.
 */
export function groupEvents(events: readonly PassEventDto[]): SyncRow[] {
  const byVersion = new Map<number, PassEventDto[]>();
  const rows: { at: number; id: string; build: () => SyncRow }[] = [];
  const loose: PassEventDto[] = [];
  for (const e of events) {
    const v = versionOf(e);
    if (v !== null && CYCLE.has(e.kind)) byVersion.set(v, [...(byVersion.get(v) ?? []), e]);
    else if (e.kind === 'device.unregistered') loose.push(e);
    else rows.push({ at: e.at, id: e.id, build: () => single(e) });
  }
  // A device that unregisters after a version was published belongs to that version's row.
  const starts = [...byVersion].map(
    ([v, list]) => [v, Math.min(...list.map((e) => e.at))] as const,
  );
  for (const e of loose) {
    const owner = starts.filter(([, start]) => start <= e.at).sort((a, b) => b[1] - a[1])[0];
    if (owner) byVersion.set(owner[0], [...(byVersion.get(owner[0]) ?? []), e]);
    else rows.push({ at: e.at, id: e.id, build: () => single(e) });
  }
  for (const [version, list] of byVersion) {
    const newest = list.reduce((a, b) => (b.at > a.at ? b : a));
    rows.push({ at: newest.at, id: newest.id, build: () => cycle(version, list) });
  }
  return fold(rows.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).map((r) => r.build()));
}
