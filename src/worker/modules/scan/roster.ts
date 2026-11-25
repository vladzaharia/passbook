import type { z } from 'zod';
import { effectiveChannels } from '../../../shared/channels.ts';
import type { ScanRosterSchema } from '../../../shared/contracts/scan-session.ts';
import { ROSTER_MAX_ENTRIES, ROSTER_TTL_MS } from '../../../shared/scan-offline.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { ValidationError } from '../../platform/errors.ts';
import { sha256Hex, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { loadMany } from '../channels/service.ts';
import { type ScanActor, scopeSessionId } from './actor.ts';
import { type AdmitsPass, matchesEvent } from './admits.ts';
import { localDay } from './counts.ts';
import { requireOfflineList } from './offline-policy.ts';
import { type RosterRow, rosterPage, voidedPrintsSince } from './repo-roster.ts';
import { configEpochOf, credentialEpochOfActor } from './scan-epochs.ts';

type Roster = z.infer<typeof ScanRosterSchema>;
type Entry = Roster['entries'][number];

const PAGE = 2000;

/**
 * The session and its configuration revision (the scanner's `config_epoch`, which a staff sign-in, sign-out or idle unbind never moves). A switch of session, or a change to its settings or
 * passes, makes every earlier roster stamp stop verifying, so a stale list cannot label a read `listed`.
 */
export const scopeKeyOf = (actor: ScanActor): string =>
  `${scopeSessionId(actor) ?? ''}:${actor.scanningSession?.updatedAt ?? 0}:${configEpochOf(actor)}:${credentialEpochOfActor(actor)}`;

/**
 * The window MAC. It binds the device's scope to `asOf` and `validUntil`, so `batch` can tell a
 * roster this server issued to this session from a made-up one.
 */
export async function rosterSig(
  ctx: ServiceContext,
  actor: ScanActor,
  asOf: number,
  validUntil: number,
): Promise<string> {
  const key = await derivedHmacKey(ctx.env, 'scan-roster.v1');
  const frame = new TextEncoder().encode(
    JSON.stringify([actor.actorKey, scopeKeyOf(actor), actor.orgId, actor.mode, asOf, validUntil]),
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, frame)));
}

/** The 128-bit hex hash a device computes from a code: the first 32 of the SHA-256 hex. */
const short = (hex: string) => hex.slice(0, 32);

/**
 * What one pass puts on the list: up to two hashes (scan code, printed code), one status and one
 * state. Never a name, a title, an input or a template. The barcode message's own hash is left off:
 * the roster cannot tell a random token from a member number, and an unkeyed hash of a number is
 * brute-forced offline from a stolen door. Only the scan code (128 random bits) and the printed
 * code are checked offline; a barcode that is the scan code is covered by the first.
 */
async function entriesOf(
  row: RosterRow,
  opts: { inside: boolean; day: boolean; paper: boolean; delta: boolean; group: () => string },
  ended: readonly string[],
): Promise<{ live: Entry[]; gone: Entry[] }> {
  const status: Entry['status'] =
    row.removed_at !== null || row.deleted_at !== null
      ? 'removed'
      : row.status === 'voided'
        ? 'voided'
        : 'active';
  const hashes = new Set<string>();
  if (row.scan_code) hashes.add(short(await sha256Hex(row.scan_code)));
  // Paper that is not effectively on is left off, so offline never admits what the online door refuses.
  if (row.print_hash && opts.paper) hashes.add(row.print_hash);
  const state: Entry['state'] = opts.inside ? 'in' : null;
  const day = opts.day ? { day: true } : {};
  // An ordinal shared by one pass's entries in this response lets the device mark the phone and paper codes together.
  const g = hashes.size > 1 ? { g: opts.group() } : {};
  return {
    live: [...hashes].map((h) => ({ h, status, state, ...day, ...g })),
    // On a delta the device still holds a print that paper-off took off the list: tell it to drop it.
    gone: [...ended, ...(opts.delta && row.print_hash && !opts.paper ? [row.print_hash] : [])]
      .filter((h, i, all) => !hashes.has(h) && all.indexOf(h) === i)
      .map((h) => ({ h, status: 'voided', state: null, ...day })),
  };
}

function gateScopes(actor: ScanActor, now: number): string[] {
  return [
    `day:${localDay(now, actor.timeZone)}`,
    ...(actor.events ?? (actor.event ? [{ event: actor.event }] : [])).map(
      (e) => `event:${e.event.id}`,
    ),
  ];
}

/**
 * `GET /roster`: one page of the session's offline list. A cursor continues a download; `since`
 * asks for what changed after an earlier `asOf`. The scope is the actor's own: its admitted templates,
 * narrowed by its events' pass filters, so a device never learns of a pass its door would not admit.
 */
export async function rosterFor(
  ctx: ServiceContext,
  actor: ScanActor,
  cursor: string | null,
  since: number | null,
): Promise<Roster> {
  const daily = await requireOfflineList(ctx, actor);
  const now = ctx.clock.now();
  const [after = '', countText = '0'] = (cursor ?? '').split('.');
  let count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 0) throw new ValidationError('Bad cursor.');
  const rows = await rosterPage(
    ctx.env.DB,
    {
      orgId: actor.orgId,
      mode: actor.mode,
      templateIds: actor.templateIds,
      gateScopes: gateScopes(actor, now),
      since,
    },
    after,
    PAGE,
  );
  const entries: Entry[] = [];
  const ended = new Map<string, string[]>();
  if (since !== null)
    for (const v of await voidedPrintsSince(
      ctx.env.DB,
      rows.map((r) => r.id),
      since,
    ))
      ended.set(v.pass_id, [...(ended.get(v.pass_id) ?? []), v.roster_hash]);
  const inScope = rows.filter((row) =>
    matchesEvent(actor, {
      templateId: row.template_id,
      personalization: JSON.parse(row.personalization),
    } satisfies AdmitsPass),
  );
  const printed = inScope.filter((row) => row.print_hash);
  const loaded = await loadMany(
    ctx,
    printed.map((r) => ({
      id: r.id,
      orgId: actor.orgId,
      mode: actor.mode,
      templateId: r.template_id,
      templateVersion: r.template_version,
    })),
  );
  let ordinal = 0;
  for (const row of inScope) {
    const inputs = loaded.get(row.id)?.inputs;
    const paper = inputs ? effectiveChannels({ ...inputs, entitlement: {} }).paper.on : false;
    const { live, gone } = await entriesOf(
      row,
      {
        inside: row.inside === 1,
        day: daily.has(row.template_id),
        paper,
        delta: since !== null,
        group: () => String(++ordinal),
      },
      ended.get(row.id) ?? [],
    );
    entries.push(...live, ...gone);
    // A pass that ended a print only drops hashes: it does not count against the list's size.
    count += live.length;
  }
  if (count > ROSTER_MAX_ENTRIES)
    throw new ValidationError(
      'Too many passes for an offline list. Narrow the session.',
      [],
      'OFFLINE_TOO_BIG',
    );
  const validUntil = now + ROSTER_TTL_MS;
  const last = rows[rows.length - 1];
  return {
    entries,
    cursor: rows.length === PAGE && last ? `${last.id}.${count}` : null,
    asOf: now,
    validUntil,
    sig: await rosterSig(ctx, actor, now, validUntil),
  };
}
