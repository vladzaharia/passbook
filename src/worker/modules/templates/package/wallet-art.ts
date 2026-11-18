import type { AssetEntry, ValidationIssue } from '../../../../passkit/types.ts';
import { crc32, sha1Hex } from './hash.ts';
import { parsePng } from './png.ts';

/**
 * `wallets/**` art as version assets in the `source` slot: stored with the version, never shipped
 * in a pass. A file that is not a well-formed PNG is an error.
 */
export async function walletArtAssets(
  art: ReadonlyMap<string, Uint8Array>,
  files: Map<string, Uint8Array>,
  push: (issue: ValidationIssue) => void,
): Promise<Omit<AssetEntry, 'source'>[]> {
  const out: Omit<AssetEntry, 'source'>[] = [];
  for (const [path, bytes] of art) {
    const png = parsePng(bytes);
    if ('error' in png) {
      push({ severity: 'error', code: 'WALLET_ART_PNG', message: png.error, path });
      continue;
    }
    files.set(path, bytes);
    out.push({
      name: path,
      slot: 'source',
      scale: 1,
      size: bytes.length,
      sha1: await sha1Hex(bytes),
      crc32: crc32(bytes),
      width: png.width,
      height: png.height,
    });
  }
  return out;
}
