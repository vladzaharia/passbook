/** A vendor webhook the connector registered for one connection. */
export interface ManagedHook {
  id: string;
  topic: string;
  /** Null when the vendor never expires it. */
  expiresAt: number | null;
}

/** Only for `inbound.webhook: 'managed'`: register and unregister are both required, renew is optional. */
export interface ConnectorHooks<Ctx> {
  registerWebhooks?(ctx: Ctx, url: string): Promise<ManagedHook[]>;
  renewWebhooks?(ctx: Ctx, hooks: readonly ManagedHook[]): Promise<ManagedHook[]>;
  unregisterWebhooks?(ctx: Ctx, hooks: readonly ManagedHook[]): Promise<void>;
}
