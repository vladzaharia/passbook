import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import type { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority } from './events.ts';
import { archiveEvent, createEvent } from './events-mutations.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { insertScanningSession } from './scanning-session-insert.ts';
import {
  applyScanningSessionUpdate,
  createScanningSession,
  loadScanningSession,
  updateScanningSession,
} from './scanning-sessions.ts';

type Accepts = { templateIds: string[]; eventIds: string[] };
type Made = { id: string; name: string };

/** The four writes a template's scan setup makes, as the caller: the console session, or a key. */
export interface SetupActor {
  createEvent(body: z.infer<typeof CreateScanEventSchema>, setupKey: string): Promise<Made>;
  archiveEvent(id: string): Promise<void>;
  createSession(
    body: z.infer<typeof CreateScanningSessionSchema>,
    templateId: string,
  ): Promise<Made>;
  updateSession(id: string, accepts: Accepts): Promise<void>;
}

/**
 * A console session writes under its membership and answers with counts it may read. A key writes
 * under its own principal (`scanning:write`): its grants re-check the key at commit, the rows it
 * makes have no user creator, and the audit rows name the key.
 */
export async function setupActor(
  ctx: ServiceContext,
  auth: SessionAuth | ApiKeyAuth,
  authority: TenantPassWrite,
  mode: Mode,
): Promise<SetupActor> {
  if (auth.kind === 'api_key') {
    const id = auth.keyId;
    return {
      createEvent: async (body, key) => createEvent(ctx, id, mode, body, authority, key),
      archiveEvent: async (event) => {
        await archiveEvent(ctx, id, event, authority);
      },
      createSession: async (body, templateId) => {
        const made = await insertScanningSession(ctx, id, mode, body, authority, templateId);
        const row = await loadScanningSession(ctx, made, mode, authority.orgId);
        return { id: row.id, name: row.name };
      },
      updateSession: async (session, accepts) => {
        await applyScanningSessionUpdate(ctx, id, session, { accepts }, authority);
      },
    };
  }
  const read = await tenantAuthorityOf(ctx, auth, authority.orgId, 'scanning:read');
  const countAuthority = await captureConsoleSessionCountAuthority(ctx, auth, read);
  const events = () => captureEventAuthority(ctx, auth, authority);
  return {
    createEvent: async (body, key) =>
      createEvent(ctx, auth.userId, mode, body, await events(), key),
    archiveEvent: async (event) => {
      await archiveEvent(ctx, auth.userId, event, await events());
    },
    createSession: async (body, templateId) =>
      createScanningSession(ctx, auth.userId, mode, body, authority, countAuthority, templateId),
    updateSession: async (session, accepts) => {
      await updateScanningSession(
        ctx,
        auth.userId,
        session,
        { accepts },
        authority,
        countAuthority,
      );
    },
  };
}
