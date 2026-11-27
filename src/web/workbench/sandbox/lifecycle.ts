import type { ConfirmCopy } from '../../lib/confirms.ts';
import {
  deleteSandboxConfirm,
  resetSandboxConfirm,
  startOverSandboxConfirm,
} from '../../lib/confirms-developer.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { ActionError, startDelete, startRecreate, startReset } from '../console/sandbox-actions.ts';
import { loadSession } from '../console/session.ts';
import { verify } from '../console/turnstile.ts';
import { startedOperation } from './operation.tsx';

/** The action is already under way: the id is the operation to follow. */
export class RunningError extends Error {
  readonly operationId: string;
  constructor(operationId: string, message: string) {
    super(message);
    this.operationId = operationId;
  }
}

export type Act = 'reset' | 'start-over' | 'delete';

export const ACT_COPY: Record<Act, ConfirmCopy> = {
  reset: resetSandboxConfirm,
  'start-over': startOverSandboxConfirm,
  delete: deleteSandboxConfirm,
};

/** A reload brings the confirm back after Polaris ID asked for a fresh sign-in. */
export const RESUME_KEY = 'wb-sandbox-resume';

/** What a refused action says, and where a step-up sends the person. */
export interface Refusal {
  text: string;
  signInUrl: string | undefined;
}

export const refusalOf = (e: unknown): Refusal =>
  e instanceof ActionError
    ? { text: e.message, signInUrl: e.signInUrl }
    : { text: "Couldn't reach PassBook. Try again.", signInUrl: undefined };

/**
 * Starts one action: the Turnstile check (Delete has none), then the call. These are the person's own
 * (the server holds them to the session), so they carry the write token and no Workbench token. The
 * operation goes into the cache at once. One already running (another tab, a reload) is followed
 * instead of refused.
 */
export async function startAct(
  act: Act,
  host: HTMLElement | null,
  shown: (on: boolean) => void,
): Promise<Operation> {
  const session = await loadSession();
  if (session.kind === 'out' || session.kind === 'failed' || session.kind === 'none')
    throw new ActionError('Reload and try again.');
  try {
    let started: Operation;
    if (act === 'delete') started = await startDelete(session.csrf);
    else {
      if (!session.siteKey || !host) throw new ActionError('Reload and try again.');
      host.replaceChildren();
      const token = await verify(host, session.siteKey, shown).catch(() => {
        throw new ActionError('The check did not pass. Try again.');
      });
      started =
        act === 'reset'
          ? await startReset(session.csrf, token)
          : await startRecreate(session.csrf, token);
    }
    startedOperation(started);
    return started;
  } catch (e) {
    if (e instanceof ActionError && e.operationId) throw new RunningError(e.operationId, e.message);
    throw e;
  }
}
