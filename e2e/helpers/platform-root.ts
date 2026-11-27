import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { certDetails } from '../../src/worker/modules/identities/cert.ts';
import {
  credentialAad,
  encryptSecret,
  importKek,
  type KekRing,
} from '../../src/worker/platform/crypto.ts';
import { toHex } from '../../src/worker/platform/ids.ts';
import { E2E_KEK_V1 } from '../../tools/lib/e2e-kek.ts';

const STATE = '.wrangler/e2e-state';

/**
 * Runs SQL against the e2e server's local database and returns the rows of the last statement. The Worker writes
 * the same file, so a write that meets its lock is tried again.
 */
export function d1<T = Record<string, unknown>>(sql: string): T[] {
  const args = ['wrangler', 'd1', 'execute', 'wallet-platform', '--local', '--persist-to', STATE];
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync('npx', [...args, '--json', '--command', sql], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      const parsed = JSON.parse(out.slice(out.indexOf('['))) as { results: T[] }[];
      return parsed.at(-1)?.results ?? [];
    } catch (error) {
      const detail = String((error as { stderr?: unknown }).stderr ?? error);
      if (attempt >= 5 || !/locked|busy/i.test(detail))
        throw new Error(`d1 failed: ${detail.slice(0, 600)}`);
      execFileSync('sleep', ['1']);
    }
  }
}

const blob = (bytes: Uint8Array) => `x'${toHex(bytes)}'`;
const text = (v: string) => `'${v.replaceAll("'", "''")}'`;

/**
 * Seeds the platform's root pass type as a signing identity the way a finished setup run leaves it: a
 * certificate for that pass type (made by the generator the Worker tests use), its key sealed under the e2e
 * KEK, and a platform row that issues but is not the default. Nothing is dropped or bypassed.
 */
export async function seedPlatformRoot(): Promise<{ id: string; passType: string }> {
  // Made by tools/e2e-server.ts under the Worker's own intermediate, as Apple's pass types all chain to one WWDR.
  const fixture = JSON.parse(readFileSync(`${STATE}/platform-root.json`, 'utf8')) as {
    identity: { passTypeIdentifier: string; teamIdentifier: string };
    certificate: string;
    privateKey: string;
  };
  const passType = fixture.identity.passTypeIdentifier;
  // A server that outlives a run keeps the row: its pass type is unique, so the next run takes it back into use.
  const [held] = d1<{ id: string }>(
    `SELECT id FROM signing_identities WHERE pass_type_identifier = ${text(passType)}`,
  );
  if (held) {
    d1(`UPDATE signing_identities SET issuing = 1 WHERE id = ${text(held.id)}`);
    return { id: held.id, passType };
  }
  const details = await certDetails(fixture.certificate);
  const id = `e2e-root-${Date.now().toString(36)}`;
  const credentialId = `${id}-cred`;
  const ring: KekRing = { current: 1, keys: new Map([[1, await importKek(E2E_KEK_V1)]]) };
  const sealed = await encryptSecret(
    ring,
    fixture.privateKey,
    credentialAad(credentialId, null, 'pass_signer'),
  );
  const now = Date.now();
  d1(
    `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
     VALUES (${text(credentialId)}, NULL, 'pass_signer', ${sealed.kekVersion}, ${blob(sealed.iv)}, ${blob(sealed.wrappedDek)}, ${blob(sealed.ciphertext)}, ${text(details.sha256)}, ${now})`,
  );
  d1(
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, cert_sha256,
        not_before, not_after, is_default, issuing, provenance, purpose, created_at)
     VALUES (${text(id)}, NULL, 'PassBook', ${text(passType)}, ${text(fixture.identity.teamIdentifier)}, 'db', ${text(credentialId)},
        ${text(fixture.certificate)}, ${text(details.sha256)}, ${details.notBefore}, ${details.notAfter}, 0, 1, 'platform', 'passes', ${now})`,
  );
  return { id, passType };
}

/** Stops the seeded identity issuing, so a later spec on the same server never picks it up. */
export function retirePlatformRoot(id: string): void {
  d1(`UPDATE signing_identities SET issuing = 0 WHERE id = ${text(id)}`);
}
