import { z } from 'zod';
import { ApiScopeSchema, ModeSchema, RoleSchema } from '../../../shared/contracts/common.ts';
import {
  type ConnectionMode,
  ConnectionModeSchema,
} from '../../../shared/contracts/connections.ts';
import { OrgCapabilitySchema, OrgRoleSchema } from '../../../shared/contracts/org-membership.ts';
import type { PassIssuanceExecution } from '../passes/create-types.ts';
import type { SampleScannerScope } from '../scan/sample-scope-fence.ts';
import type { ConnectionEmailAuthority, IssuedPassEmailRelease } from './binding.ts';

export type IssuanceContext = {
  execution: PassIssuanceExecution;
  release: IssuedPassEmailRelease;
  connection: ConnectionEmailAuthority | null;
  connectionMode: ConnectionMode | null;
  orgRevision?: number | undefined;
  userRevision?: number | null | undefined;
  additionalUserRevision?: number | null | undefined;
};

const AuthoritySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    orgId: z.string(),
    orgUpdatedAt: z.number(),
    userId: z.string(),
    sessionId: z.string(),
    sessionRoles: z.array(RoleSchema),
    amr: z.enum(['oidc', 'magic_link', 'breakglass']),
    membershipId: z.string(),
    roles: z.array(OrgRoleSchema),
    capability: OrgCapabilitySchema,
    mode: ModeSchema,
  }),
  z.object({
    kind: z.literal('api_key'),
    orgId: z.string(),
    orgUpdatedAt: z.number(),
    keyId: z.string(),
    keyOrgId: z.string().nullable(),
    scopes: z.array(ApiScopeSchema),
    scope: ApiScopeSchema,
    mode: ModeSchema,
  }),
]);
const ContextSchema = z.object({
  execution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('system') }),
    z.object({
      kind: z.literal('connection'),
      connectionId: z.string(),
      generation: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('tenant'),
      authority: AuthoritySchema,
      additionalAuthority: AuthoritySchema.optional(),
      sampleScannerScope: z
        .custom<SampleScannerScope>(
          (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
        )
        .optional(),
    }),
  ]),
  release: z.object({
    id: z.string(),
    templateId: z.string(),
    version: z.string(),
    orgId: z.string().nullable(),
    mode: ModeSchema,
    provider: z.literal('apple'),
    generation: z.number().int().positive(),
    candidateHash: z.string(),
  }),
  connection: z
    .object({
      orgId: z.string(),
      connectionId: z.string(),
      externalRef: z.string().nullable(),
      generation: z.number().int().positive(),
    })
    .nullable(),
  connectionMode: ConnectionModeSchema.nullable(),
  /** The org `access_revision` when the pass was created: pins system and connection work. */
  orgRevision: z.number().int().positive().optional(),
  /** The issuing user's `access_revision` (and the second authority's) at create. */
  userRevision: z.number().int().positive().nullish(),
  additionalUserRevision: z.number().int().positive().nullish(),
});

export interface IssuanceRow {
  pass_id: string;
  org_id: string;
  mode: 'live' | 'test';
  recipient: string;
  template_id: string;
  context: string;
  transfer_id: string | null;
  state: 'pending' | 'queued' | 'cancelled';
  outbox_id: string | null;
  outcome: 'sent' | 'partial' | 'failed' | 'cancelled' | null;
  error_code: string | null;
}

export function parseContext(row: IssuanceRow): IssuanceContext | null {
  try {
    const parsed = ContextSchema.safeParse(JSON.parse(row.context));
    if (
      !parsed.success ||
      parsed.data.release.templateId !== row.template_id ||
      parsed.data.release.mode !== row.mode
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}
