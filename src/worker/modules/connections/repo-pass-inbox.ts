// Webhook events and inbox
export interface InboxItem {
  ref: string;
  record: Record<string, unknown> | null;
  deleted: boolean;
  /** Recipes only: false = update an existing pass, never create. */
  create?: boolean;
  /** Recipes only: source order of the record. */
  version?: number;
}
