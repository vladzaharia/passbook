// Uploaded template packages for the demo: a joinable guest pass with a paper block, a crew badge
// and one broken file. Each is a copy of a built-in package with the baked-only parts removed.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { zipSync } from 'fflate';
import type { Session } from './demo-client.ts';

const root = resolve(import.meta.dirname, '../..');

function* filesOf(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesOf(path);
    else yield path;
  }
}

/** The package of `source` (a folder under templates/) renamed `name`, including wallets/ images. */
function variantZip(source: string, name: string, joinable = false): Uint8Array {
  const dir = resolve(root, 'templates', source);
  const files: Record<string, Uint8Array> = {};
  for (const path of filesOf(dir)) {
    const key = relative(dir, path);
    let bytes: Uint8Array = readFileSync(path);
    if (key === 'wallet.template.json') {
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
      manifest.name = name;
      // An uploaded package is never a blueprint.
      manifest.blueprint = undefined;
      // Uploads are untrusted: baked-only keywords and /semantics bindings are rejected.
      if (manifest.inputs?.properties?.website)
        manifest.inputs.properties.website.pattern = undefined;
      if (manifest.inputs) manifest.inputs.dependentRequired = undefined;
      manifest.bindings = (manifest.bindings ?? []).filter(
        (b: { to: { pointer?: string } }) => !b.to.pointer?.startsWith('/semantics'),
      );
      // A join link needs a barcode that carries only the scan code, so its alt text names no input.
      if (joinable)
        for (const b of manifest.bindings)
          if (b.to.barcode === '*' && b.to.prop === 'altText') b.value = 'Member code';
      bytes = Buffer.from(JSON.stringify(manifest, null, 2));
    }
    files[key] = bytes;
  }
  return zipSync(files);
}

/** Harbor's uploads: Join Badge (paper on, joinable), Crew Badge, and a package that fails to import. */
export async function uploadVariants(
  owner: Session,
  harbor: string,
  byName: (name: string) => unknown,
): Promise<void> {
  const upload = (query: string, zip: Uint8Array) =>
    owner.send('POST', `/api/v1/templates/uploads?${query}`, zip, {
      'content-type': 'application/zip',
    });
  if (!byName('Harbor Join Badge'))
    await upload(
      `orgId=${harbor}&name=Harbor%20Join%20Badge`,
      variantZip('starter-guest-pass', 'Harbor Join Badge', true),
    );
  if (!byName('Harbor Crew Badge')) {
    await upload(
      `orgId=${harbor}&name=Harbor%20Crew%20Badge`,
      variantZip('starter-generic', 'Harbor Crew Badge'),
    );
    await upload(
      `orgId=${harbor}&name=Broken%20Badge`,
      zipSync({ 'wallet.template.json': Buffer.from('{') }),
    );
  }
}
