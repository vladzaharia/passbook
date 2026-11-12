import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Local `send_email` binding (miniflare) drops each message under .wrangler/tmp/email/<id>/email-text/.
 * Files carry no recipient, so callers snapshot before triggering a send and read what is new.
 */
const ROOT = '.wrangler/tmp/email';

function textFiles(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT).flatMap((dir) => {
    const text = join(ROOT, dir, 'email-text');
    return existsSync(text) ? readdirSync(text).map((f) => join(text, f)) : [];
  });
}

export const snapshotMail = () => new Set(textFiles());

export interface SignInMail {
  link: string;
  code: string | null;
  text: string;
}

export async function nextSignInMail(before: Set<string>, timeoutMs = 20_000): Promise<SignInMail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = textFiles().filter((f) => !before.has(f));
    for (const file of fresh) {
      const text = readFileSync(file, 'utf8');
      const link = /https?:\/\/\S+\/auth\/magic\?t=\S+/.exec(text)?.[0];
      if (link) return { link, code: /Code:\s*(\d{6})/.exec(text)?.[1] ?? null, text };
    }
    await delay(200);
  }
  throw new Error('no sign-in email arrived');
}

/** Returns only the fragment secret from a newly delivered organization invitation. */
export async function nextOrgInvitationToken(
  before: Set<string>,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = textFiles().filter((f) => !before.has(f));
    for (const file of fresh) {
      const text = readFileSync(file, 'utf8');
      const token =
        /https?:\/\/[^\s<>"']+\/api\/v1\/orgs\/invitations\/accept#([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(
          text,
        )?.[1];
      if (token) return token;
    }
    await delay(200);
  }
  throw new Error('no organization invitation email arrived');
}
