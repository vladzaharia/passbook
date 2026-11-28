import { CLI_CODE_ALPHABET, CLI_CODE_LENGTH } from '../../../shared/contracts/cli.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import type { AppEnv } from '../../platform/env.ts';
import { randomBytes, sha256Hex, toBase64Url, toHex } from '../../platform/ids.ts';

const encoder = new TextEncoder();

/** 8 letters from the 20-letter alphabet (about 2^34.6), drawn without modulo bias. */
export function newUserCode(): string {
  const limit = 256 - (256 % CLI_CODE_ALPHABET.length);
  let code = '';
  while (code.length < CLI_CODE_LENGTH)
    for (const byte of randomBytes(16)) {
      if (byte < limit && code.length < CLI_CODE_LENGTH)
        code += CLI_CODE_ALPHABET[byte % CLI_CODE_ALPHABET.length];
    }
  return code;
}

async function mac(env: AppEnv, label: string, value: string): Promise<Uint8Array> {
  const key = await derivedHmacKey(env, label);
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value) as BufferSource),
  );
}

/** The stored form of a user code: an HMAC (`cli-user-code.v1`), so a leaked table gives no codes. */
export const userCodeMac = async (env: AppEnv, code: string): Promise<string> =>
  toHex(await mac(env, 'cli-user-code.v1', code));

/** The stored form of a device code. It is 32 random bytes, so a plain digest is enough. */
export const deviceCodeHash = (deviceCode: string): Promise<string> => sha256Hex(deviceCode);

/**
 * The secret tail of a session's key (43 characters). Derived under the server's key from the session and the
 * key's lookup prefix, so the poll that wins can hand it over once and nothing in D1 holds it.
 */
export async function tokenTail(env: AppEnv, sessionId: string, prefix: string): Promise<string> {
  return toBase64Url(await mac(env, 'cli-token.v1', `${sessionId}.${prefix}`));
}
