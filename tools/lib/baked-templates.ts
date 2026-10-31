// Scans templates/*/ and emits the baked index plus immutable static assets.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { BehaviorRegistry } from '../../src/passkit/behaviors/registry.ts';
import type { BakedTemplate } from '../../src/worker/modules/templates/baked-types.ts';
import { analyzePackage } from '../../src/worker/modules/templates/package/analyze.ts';

export interface BakedOptions {
  /** Directory holding one folder per template. Folders starting with `_` are skipped. */
  templatesDir: string;
  /** Static asset root; files land in <publicDir>/templates/<slug>/<version>/. */
  publicDir: string;
  behaviors?: BehaviorRegistry;
  log?: (line: string) => void;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
    })
    .map((p) => p.split(sep).join('/'))
    .filter((p) => !p.endsWith('.DS_Store'));
}

function packageDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && statSync(join(dir, n)).isDirectory())
    .sort();
}

function writeFile(file: string, bytes: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

export async function collectBaked(options: BakedOptions): Promise<BakedTemplate[]> {
  const log = options.log ?? (() => {});
  const out: BakedTemplate[] = [];
  const failures: string[] = [];
  const staticRoot = join(options.publicDir, 'templates');
  rmSync(staticRoot, { recursive: true, force: true });

  for (const slug of packageDirs(options.templatesDir)) {
    const dir = join(options.templatesDir, slug);
    const input = new Map<string, Uint8Array>();
    for (const name of walk(dir)) input.set(name, new Uint8Array(readFileSync(join(dir, name))));

    const result = await analyzePackage(input, {
      uploaded: false,
      fallbackName: slug,
      behaviors: options.behaviors,
    });
    for (const issue of result.report.issues) {
      const line = `templates/${slug}: ${issue.severity} ${issue.code} ${issue.path ?? ''} ${issue.message}`;
      if (issue.severity === 'error') failures.push(line);
      else log(line);
    }
    if (!('version' in result)) {
      if (result.report.issues.every((i) => i.severity !== 'error'))
        failures.push(`templates/${slug}: could not be analyzed`);
      continue;
    }

    const raw = result.manifest as unknown as { org?: { slug?: unknown; name?: unknown } };
    const org =
      typeof raw.org?.slug === 'string' && typeof raw.org.name === 'string'
        ? { slug: raw.org.slug, name: raw.org.name }
        : null;
    const base = `/templates/${slug}/${result.version}`;
    for (const [name, bytes] of result.files)
      writeFile(join(staticRoot, slug, result.version, name), bytes);
    for (const extra of result.extras) {
      const bytes = input.get(extra.name);
      if (bytes) writeFile(join(staticRoot, slug, result.version, extra.name), bytes);
    }
    out.push({
      id: `baked:${slug}`,
      slug,
      version: result.version,
      name: result.manifest.name,
      description: result.manifest.description ?? null,
      org,
      styles: result.styles,
      manifest: result.manifest,
      passJson: result.passJson,
      assets: result.assets.map((a) => ({
        ...a,
        source: { kind: 'static' as const, path: `${base}/${a.name}` },
      })),
      extras: result.extras.map((e) => ({ ...e, path: `${base}/${e.name}` })),
      report: result.report,
    });
  }
  if (failures.length) throw new Error(`Template packages are invalid:\n${failures.join('\n')}`);
  if (out.length > 0) writeFileSync(join(staticRoot, '.gitignore'), '*\n');
  return out;
}

export function bakedBuildHash(templates: readonly BakedTemplate[]): string {
  const hash = createHash('sha256');
  for (const t of templates) hash.update(`${t.id}@${t.version}\n`);
  return hash.digest('hex').slice(0, 40);
}

export function renderBakedModule(templates: readonly BakedTemplate[], header: string): string {
  return `${header}import type { BakedTemplate } from '../worker/modules/templates/baked-types.ts';

/** Hash of every template id@version; syncBakedTemplates() runs once per isolate per value. */
export const BAKED_BUILD_HASH = ${JSON.stringify(bakedBuildHash(templates))};

export const bakedTemplates: readonly BakedTemplate[] = ${JSON.stringify(templates, null, 2)};
`;
}
