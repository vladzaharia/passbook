import type { PaperTicket } from './paper.ts';
import { canonical } from './pdf-cache.ts';

/** sha256 of what a ticket draws: design, words and image names. Not the code, print number or time. */
export async function paperHash(ticket: PaperTicket): Promise<string> {
  const data = new TextEncoder().encode(
    canonical({ design: ticket.design, content: ticket.content, files: ticket.files }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
