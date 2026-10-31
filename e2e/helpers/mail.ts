import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no sign-in email arrived');
}
