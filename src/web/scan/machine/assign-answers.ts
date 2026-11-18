/** What the server's answers do to the assign loop: the next step, or the error to show. */
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import type { BindResult } from '../assign/types.ts';
import {
  ASSIGN_TIMING,
  type AssignError,
  type AssignEvent,
  type AssignState,
  asCmd,
} from './assign-state.ts';
import type { Env, MachineState, Out } from './internal.ts';
import { out, same } from './internal.ts';
import type { Cmd } from './types.ts';

type Of<T extends AssignEvent['type']> = Extract<AssignEvent, { type: T }>;

const commit = (s: MachineState, a: AssignState, env: Env, cmds: Cmd[] = []): Out =>
  out(
    {
      ...s,
      assign: { ...a, idleAt: a.source === 'request' ? a.idleAt : env.now + ASSIGN_TIMING.IDLE },
      assignStrip: null,
      lastActivity: env.now,
    },
    cmds,
  );

const refuse: Cmd[] = [
  { c: 'sound', tone: 'refused' },
  { c: 'beat', beat: 'shake' },
];

export function inspected(s: MachineState, ev: Of<'assign.inspected'>, env: Env): Out {
  const a = s.assign;
  if (!a || a.key !== ev.key || a.busy !== 'inspect') return same(s);
  const r = ev.result;
  const base: AssignState = { ...a, inspected: r, busy: null, key: null };
  const web = a.tag?.read.source === 'webnfc';
  const fail = (error: AssignError): Out =>
    commit(s, { ...base, step: 'error', error }, env, refuse);
  switch (r.state) {
    case 'lost':
      return fail({ kind: 'lost', at: r.lostAt });
    case 'retired':
      return fail({ kind: 'unreadable', web });
    case 'not_allowed':
      return fail({ kind: 'secure_needed' });
    case 'invalid':
      return fail(a.tag?.read.uidRandom ? { kind: 'random_id' } : { kind: 'unreadable', web });
    default:
      break;
  }
  // The pass is known (a result card's Add tag): go straight to its preview.
  if (a.card && a.tag) return previewOf(s, base, env);
  return commit(s, { ...base, step: 'pass' }, env, [
    { c: 'sound', tone: 'read' },
    { c: 'beat', beat: 'look' },
    { c: 'announce', text: 'Tag read. Scan their pass.', polite: true },
    { c: 'focus', target: 'card-heading' },
  ]);
}

function previewOf(s: MachineState, a: AssignState, env: Env): Out {
  const key = env.id();
  if (!a.tag || !a.card) return commit(s, a, env);
  const body = { tag: a.tag.read, card: a.card, preview: true, binding: 'pass' as const };
  const cmd = { c: 'assign.bind' as const, key, body };
  return commit(s, { ...a, key, busy: 'preview', retry: cmd }, env, [asCmd(cmd)]);
}

function alreadyHere(s: MachineState, a: AssignState, r: BindResult, env: Env): Out {
  return commit(
    s,
    {
      ...a,
      busy: null,
      key: null,
      preview: r,
      step: 'error',
      error: {
        kind: 'already_here',
        at: a.inspected?.boundAt ?? null,
        by: a.inspected?.boundByName ?? null,
      },
    },
    env,
    [
      { c: 'sound', tone: 'heads_up' },
      { c: 'beat', beat: 'wrist' },
    ],
  );
}

export function previewed(s: MachineState, ev: Of<'assign.previewed'>, env: Env): Out {
  const a = s.assign;
  if (!a || a.key !== ev.key || a.busy !== 'preview') return same(s);
  const r = ev.result;
  if (r.status === 'already_bound') return alreadyHere(s, a, r, env);
  return commit(
    s,
    {
      ...a,
      busy: null,
      key: null,
      preview: r,
      step: 'confirm',
      scope: 'pass',
      banner: null,
      note: null,
    },
    env,
    [
      { c: 'sound', tone: 'read' },
      { c: 'beat', beat: 'look' },
      { c: 'announce', text: `${r.card.holderName ?? r.card.title}.`, polite: true },
      { c: 'focus', target: 'card-heading' },
    ],
  );
}

export function bound(s: MachineState, ev: Of<'assign.bound'>, env: Env): Out {
  const a = s.assign;
  if (!a || a.key !== ev.key || (a.busy !== 'bind' && a.busy !== 'complete')) return same(s);
  const r = ev.result;
  const name = r.card.holderName ?? r.card.title;
  if (r.status === 'already_bound' && a.busy === 'bind') return alreadyHere(s, a, r, env);
  return commit(
    s,
    {
      ...a,
      busy: null,
      key: null,
      step: 'done',
      result: r,
      pin: null,
      waiting: false,
      error: null,
    },
    env,
    [
      { c: 'sound', tone: 'ok' },
      { c: 'beat', beat: 'hop' },
      {
        c: 'announce',
        text: `${r.status === 'moved' ? SCAN_TAG_COPY.ok.moved : SCAN_TAG_COPY.ok.assigned}. ${name}.${r.undoUntil ? ' Undo available.' : ''}`,
        polite: true,
      },
      { c: 'focus', target: 'card-heading' },
    ],
  );
}

export function undone(s: MachineState, ev: Of<'assign.undone'>, env: Env): Out {
  const a = s.assign;
  if (a?.key === ev.key && a.busy === 'undo')
    return out(
      {
        ...s,
        assign: null,
        assignStrip: { kind: 'undone', at: env.now },
        lastActivity: env.now,
      },
      [{ c: 'sound', tone: 'undo' }],
    );
  if (s.assignStrip?.undoKey === ev.key)
    return out({ ...s, assignStrip: { kind: 'undone', at: env.now } }, [
      { c: 'sound', tone: 'undo' },
    ]);
  return same(s);
}

const PASS_BANNERS: Record<string, AssignState['banner']> = {
  PASS_NOT_FOUND: 'not_found',
  TAG_PASS_VOIDED: 'voided',
  TAG_PASS_REMOVED: 'removed',
  TAG_PASS_EXPIRED: 'expired',
  TAG_PASS_NOT_ACCEPTED: 'not_accepted',
  TAG_CARD_AMBIGUOUS: 'ambiguous',
};

export function failed(s: MachineState, ev: Of<'assign.failed'>, env: Env): Out {
  const a = s.assign;
  const stripUndo = !a && s.assignStrip?.undoKey === ev.key;
  if (stripUndo)
    return out(
      {
        ...s,
        assignStrip: {
          ...(s.assignStrip as NonNullable<MachineState['assignStrip']>),
          undoKey: undefined,
        },
      },
      [{ c: 'announce', text: 'Undo expired. An admin can remove the tag.', polite: false }],
    );
  if (!a || a.key !== ev.key || !a.busy) return same(s);
  const busy = a.busy;
  const idle: AssignState = { ...a, busy: null, key: null };
  const code = ev.code ?? '';
  const web = a.tag?.read.source === 'webnfc';
  const error = (e: AssignError, step: AssignState['step'] = 'error'): Out =>
    commit(s, { ...idle, step, error: e }, env, refuse);

  if (busy === 'undo')
    return commit(s, idle, env, [
      { c: 'announce', text: 'Undo expired. An admin can remove the tag.', polite: false },
    ]);
  // A wrong Manager PIN keeps the sheet open with the tries left.
  if (a.pin?.open && (code === 'PIN_INVALID' || (ev.status === 429 && ev.locked)))
    return commit(
      s,
      {
        ...idle,
        pin: {
          ...a.pin,
          note: ev.locked
            ? { locked: true, ...(ev.retryAfterMs ? { retryAfterMs: ev.retryAfterMs } : {}) }
            : { triesLeft: ev.triesLeft ?? 0 },
        },
      },
      env,
    );
  if (ev.network) return error({ kind: 'not_assigned' });
  if (ev.status === 429)
    return error({
      kind: 'too_many',
      seconds: Math.max(1, Math.ceil((ev.retryAfterMs ?? 10_000) / 1000)),
    });
  const banner = PASS_BANNERS[code];
  if (banner && busy === 'preview')
    return commit(s, { ...idle, step: 'pass', card: null, banner }, env, [
      { c: 'sound', tone: 'refused' },
      { c: 'beat', beat: 'shake' },
    ]);
  if (code === 'TAG_APPROVAL_REQUIRED' || code === 'PIN_MANAGER_REQUIRED')
    return commit(
      s,
      {
        ...idle,
        step: 'confirm',
        pin: { open: true, move: a.retry?.c === 'assign.bind' && a.retry.body.move === true },
      },
      env,
    );
  if (code === 'TAG_HELD_BY_OTHER') {
    if (busy === 'complete') return commit(s, { ...idle, step: 'tag', waiting: true }, env);
    return commit(s, { ...idle, step: 'confirm', pin: { open: true, move: true } }, env);
  }
  if (code === 'TAG_NO_ACCOUNT')
    return commit(
      s,
      {
        ...idle,
        step: 'confirm',
        scope: 'pass',
        preview: a.preview ? { ...a.preview, ownerAccount: false } : a.preview,
      },
      env,
      refuse,
    );
  const over = (kind: 'requestTimedOut' | 'adminCancelled'): Out =>
    out({ ...s, assign: null, assignStrip: { kind, at: env.now }, tagRequest: null }, refuse);
  // The admin lost the right to ask: the request is over, the scanner stays paired.
  if (code === 'TAG_REQUEST_REVOKED') return over('adminCancelled');
  if (
    code === 'TAG_REQUEST_EXPIRED' ||
    code === 'ENROLLMENT_ENDED' ||
    (busy === 'complete' && ev.status === 404)
  )
    return over('requestTimedOut');
  // The pass changed hands inside the window: the request cannot finish, the admin sends a new one.
  if (code === 'TAG_HOLDER_CHANGED' && busy === 'complete')
    return error({ kind: 'holder_changed' });
  switch (code) {
    case 'TAG_LOST':
      return error({ kind: 'lost' });
    case 'TAG_RETIRED':
      return error({ kind: 'unreadable', web });
    case 'TAG_UNREADABLE':
      return error({ kind: 'unreadable', web });
    case 'TAG_UID_RANDOM':
      return error({ kind: 'random_id' });
    case 'TAG_SECURE_REQUIRED':
    case 'TAG_ASSURANCE_LOW':
      return error({ kind: 'secure_needed' });
    case 'TAG_CHECK_FAILED':
      return error({ kind: 'failed_check' });
    case 'TAGS_OFF':
      return error({ kind: 'off' });
    case 'TAG_LIMIT':
    case 'TAG_BINDING_LIMIT':
      return error({ kind: 'limit' });
    default:
      return error({ kind: 'went_wrong', ...(ev.requestId ? { requestId: ev.requestId } : {}) });
  }
}

export function applyAnswer(s: MachineState, ev: AssignEvent, env: Env): Out | null {
  switch (ev.type) {
    case 'assign.inspected':
      return inspected(s, ev, env);
    case 'assign.previewed':
      return previewed(s, ev, env);
    case 'assign.bound':
      return bound(s, ev, env);
    case 'assign.undone':
      return undone(s, ev, env);
    case 'assign.failed':
      return failed(s, ev, env);
    default:
      return null;
  }
}
