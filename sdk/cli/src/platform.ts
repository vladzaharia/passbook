import { execFile, spawn } from 'node:child_process';
import { platform as osPlatform } from 'node:os';
import type { CredentialStore } from './credentials.ts';
import { credentialsPath, fileStore } from './credentials-file.ts';
import { type Exec, keychainStore } from './credentials-keychain.ts';

/** Runs `file` with no shell; the secret, when there is one, goes in on stdin and never in the arguments. */
export const exec: Exec = (file, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ code: 127, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
  });

/** The OS keychain where there is one (macOS, libsecret), else a 0600 file under `~/.config/passbook`. */
export async function defaultStore(
  env: Record<string, string | undefined>,
): Promise<CredentialStore> {
  const file = fileStore(credentialsPath(env));
  if (env.PASSBOOK_CREDENTIAL_STORE === 'file') return file;
  const keychain = keychainStore(osPlatform(), exec);
  if (!keychain) return file;
  // A keyring that is missing or locked (no `secret-tool`, a headless box) falls back to the file.
  const probe = osPlatform() === 'darwin' ? ['security', ['help']] : ['secret-tool', ['--version']];
  const found = await exec(probe[0] as string, probe[1] as string[]);
  return found.code === 127 ? file : keychain;
}

/** The browser's own opener, with no shell: the URL is one argument. */
export function openBrowser(url: string): Promise<void> {
  const os = osPlatform();
  const [file, args]: [string, string[]] =
    os === 'darwin'
      ? ['open', [url]]
      : os === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    execFile(file, args, () => resolve());
  });
}

export const osName = (): string => {
  const os = osPlatform();
  return os === 'darwin' ? 'macOS' : os === 'win32' ? 'Windows' : os === 'linux' ? 'Linux' : os;
};
