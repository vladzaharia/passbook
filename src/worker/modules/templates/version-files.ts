import type { z } from 'zod';
import type { AssetEntry, ValidationIssue } from '../../../passkit/types.ts';
import type { VersionAssetInputSchema } from '../../../shared/contracts/index.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { LIMITS } from './package/unzip.ts';
import { createTemplateRegistry } from './registry.ts';
import { listVersions } from './repo.ts';

type Input = z.infer<typeof VersionAssetInputSchema>;

/** Base64 inflates by a third: room for 15 MB of files and the documents. */
export const VERSION_BODY_LIMIT = Math.ceil((LIMITS.totalBytes * 4) / 3) + 512 * 1024;

export interface Resolved {
  files: Map<string, Uint8Array>;
  /** Source of each file that is carried over unchanged, so its bytes are not copied again. */
  carried: Map<string, { sha1: string; source: AssetEntry['source'] }>;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text.replace(/^data:[^,]*,/, ''));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const fail = (issues: ValidationIssue[]) =>
  new ValidationError(
    'The assets are invalid.',
    issues.map((i) => ({ path: i.path ?? '', message: i.message, code: i.code })),
    'ASSETS_INVALID',
  );

async function read(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Turns the designer's asset list into files: `{ name, sha1 }` must match a file this template
 * already has (any version), `{ name, upload }` is a base64 PNG. Anything else is refused, so a
 * hash from another template never reaches its bytes.
 */
export async function resolveVersionFiles(
  ctx: ServiceContext,
  templateId: string,
  inputs: readonly Input[],
): Promise<Resolved> {
  const files = new Map<string, Uint8Array>();
  const carried: Resolved['carried'] = new Map();
  const issues: ValidationIssue[] = [];
  const known = new Map<string, AssetEntry>();
  const versionOf = new Map<AssetEntry, string>();
  if (inputs.some((i) => 'sha1' in i)) {
    for (const v of await listVersions(ctx.env.DB, templateId))
      for (const a of v.assets) {
        known.set(`${a.name}|${a.sha1}`, a);
        versionOf.set(a, v.version);
      }
  }
  const registry = createTemplateRegistry(ctx.env, { ctx });
  let total = 0;
  for (const input of inputs) {
    const bad = (code: string, message: string) =>
      issues.push({ severity: 'error', code, message, path: input.name });
    if (files.has(input.name)) {
      bad('ASSET_DUPLICATE', `${input.name} is listed twice.`);
      continue;
    }
    if ('sha1' in input) {
      const entry = known.get(`${input.name}|${input.sha1}`);
      const version = entry ? versionOf.get(entry) : undefined;
      if (!entry || !version) {
        bad('ASSET_UNKNOWN', `${input.name} is not a file of this template. Upload it again.`);
        continue;
      }
      const template = await registry.resolve(templateId, version);
      const bytes = await read(await registry.openAsset(template, input.name));
      files.set(input.name, bytes);
      carried.set(input.name, { sha1: entry.sha1, source: entry.source });
      total += bytes.length;
    } else {
      const bytes = fromBase64(input.upload);
      if (!bytes) {
        bad('ASSET_ENCODING', `${input.name} is not valid base64.`);
        continue;
      }
      if (bytes.length > LIMITS.entryBytes) {
        bad('ENTRY_TOO_LARGE', `${input.name} is larger than 5 MB.`);
        continue;
      }
      files.set(input.name, bytes);
      total += bytes.length;
    }
  }
  if (total > LIMITS.totalBytes)
    issues.push({
      severity: 'error',
      code: 'ARCHIVE_TOO_LARGE',
      message: 'The files add up to more than 15 MB.',
    });
  if (issues.length > 0) throw fail(issues);
  return { files, carried };
}
