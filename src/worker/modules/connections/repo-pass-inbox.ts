// Webhook events and inbox
export interface InboxItem {
  ref: string;
  record: Record<string, unknown> | null;
  deleted: boolean;
}
