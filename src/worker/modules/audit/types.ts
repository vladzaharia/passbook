export type AuditActorType = 'user' | 'api_key' | 'system' | 'connection' | 'device';

export interface AuditEntry {
  orgId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ipPrefix?: string | null;
  /** Redacted diff. Never include secrets, tokens or personalization values. */
  detail?: Record<string, unknown> | null;
}
