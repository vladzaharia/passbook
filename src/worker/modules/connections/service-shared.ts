import type { z } from 'zod';
import type {
  ConnectionCreatedSchema,
  CreateConnectionSchema,
  UpdateConnectionSchema,
} from '../../../shared/contracts/index.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import { parseWith, type requireConnector } from './validate.ts';

export type CreateInput = z.infer<typeof CreateConnectionSchema>;
export type UpdateInput = z.infer<typeof UpdateConnectionSchema>;
export type Created = z.infer<typeof ConnectionCreatedSchema>;

/** Changing any of these invalidates runs already in flight. */
export const FENCED = [
  'config',
  'secrets',
  'webhookSecret',
  'mapping',
  'defaultTemplateId',
  'holderEmailField',
  'autoCreate',
  'autoEmail',
  'onMissing',
  'mode',
  'enabled',
] as const;

export function auditActor(actor: Actor): { actorType: Actor['type']; actorId: string | null } {
  return { actorType: actor.type, actorId: actor.id };
}

export async function requireConnection(sctx: ServiceContext, id: string): Promise<ConnectionRow> {
  const conn = await getConnection(sctx.env.DB, id);
  if (!conn) throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
  return conn;
}

export function secretsFor(
  def: ReturnType<typeof requireConnector>,
  secrets: Record<string, string>,
): string {
  if (!def.secretSchema) {
    if (Object.keys(secrets).length > 0) {
      throw new ValidationError('This connector takes no secrets.', [
        { path: 'secrets', message: 'Not supported.' },
      ]);
    }
    return '{}';
  }
  return JSON.stringify(parseWith(def.secretSchema, secrets, 'secrets'));
}
