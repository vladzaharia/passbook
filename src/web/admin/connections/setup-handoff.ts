// The secret PassBook made at Create is shown once. It crosses from the wizard to the page that
// shows it in this tab's memory: never in the address, never in storage, and read once.
const held = new Map<string, string>();

export function holdSecret(connectionId: string, secret: string): void {
  held.set(connectionId, secret);
}

export const heldSecret = (connectionId: string): string | undefined => held.get(connectionId);

export function dropSecret(connectionId: string): void {
  held.delete(connectionId);
}
