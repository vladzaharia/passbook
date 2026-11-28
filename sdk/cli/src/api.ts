import type { LogsApi } from './logs.ts';

/** The slice of `PassBook` (@passbook/sdk) the CLI calls. A `PassBook` satisfies it; tests pass a fake. */
export interface Capture {
  id: string;
  eventId: string;
  type: string;
  headers: Record<string, string>;
  /** The exact text that was signed. */
  body: string;
  createdAt: number;
}

export interface CapturePage {
  items: Capture[];
  nextCursor: string | null;
}

export interface Api extends LogsApi {
  webhookEndpoints: {
    ensureCapture(body: object): Promise<{ endpoint: { id: string }; secret: string | null }>;
    captures: {
      list(id: string, query?: { limit?: number; cursor?: string }): Promise<CapturePage>;
    };
  };
  templates: {
    retrieve(id: string): Promise<{ name: string }>;
    retrieveInputSchema(id: string): Promise<Record<string, unknown>>;
  };
  passes: {
    create(body: object, options?: { idempotencyKey?: string }): Promise<unknown>;
    update(id: string, body: object, options?: { idempotencyKey?: string }): Promise<unknown>;
    list(query?: { limit?: number }): PromiseLike<{ items: ReadonlyArray<{ id: string }> }>;
    simulate(id: string, body: { event: string; deviceId?: string }): Promise<unknown>;
  };
}
