// Part of `npm run build`, after `vite build`: prerenders the developer portal into
// dist/client/developers/ from docs/api/openapi.v1.json, sdk-names.json and docs/api/reference/*.json.
// - one HTML page per page of the portal and a markdown twin for each (check-developers fails without one), llms.txt, sitemap.xml and manifest.json (the Worker serves only what the manifest lists);
// - the pages link the hashed script and stylesheet Vite built from developers.html.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runnerImport } from 'vite';
import { PATHS } from '../src/shared/developers.ts';
import { type GuideInputs, loadGuideInputs } from '../src/web/developers/guide/load.ts';
import { loadInputs } from '../src/web/developers/model/load.ts';
import { buildSite } from '../src/web/developers/model/site.ts';
import type { OutFile, Site } from '../src/web/developers/model/types.ts';
import { searchIndexFile } from '../src/web/developers/search/build.ts';
import { publicBaseUrl } from './lib/site-origin.ts';

const root = resolve(import.meta.dirname, '..');

/** src/web/developers/render.tsx, loaded through Vite's runner (it is JSX, which Node does not run). */
interface Renderer {
  renderSite(site: Site, origin: string, assets: string, guides: GuideInputs): OutFile[];
  sitemap(origin: string, urls: string[]): string;
}

/** The anonymous playground's data (src/web/workbench/playground/build.tsx). */
interface PreviewBuilder {
  blueprintPreviews(root: string, origin: string): { json: string; files: OutFile[] };
}

export interface BuildOptions {
  /** The asset directory the Worker serves (dist/client). */
  out: string;
  /** Script and stylesheet tags for every page's head (from Vite's developers.html). */
  head: string;
  apiDir?: string;
  origin?: string;
}

export interface Manifest {
  [url: string]: { asset: string; type: string };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atom': 'application/atom+xml; charset=utf-8',
};

/** What the asset layer is asked for: `.html` stripped (it redirects otherwise), a directory index as `dir/`. */
function assetPath(file: string): string {
  if (!file.endsWith('.html')) return file;
  const bare = file.slice(0, -'.html'.length);
  return bare.endsWith('/index') ? bare.slice(0, -'index'.length) : bare;
}

/** The `<script>` and `<link>` tags Vite put in developers.html's head. */
export function headTags(viteHtml: string): string {
  const head = /<head>([\s\S]*?)<\/head>/.exec(viteHtml)?.[1] ?? '';
  return (head.match(/<script\b[^>]*><\/script>|<link\b[^>]*>/g) ?? []).join('');
}

export async function buildDevelopers(
  options: BuildOptions,
): Promise<{ files: string[]; manifest: Manifest; built: OutFile[] }> {
  const origin = options.origin ?? publicBaseUrl(join(root, 'wrangler.jsonc'));
  const inputs = loadInputs(root, options.apiDir);
  const site = buildSite(inputs);
  const load = async <T>(file: string): Promise<T> =>
    (
      await runnerImport<T>(join(root, file), {
        configFile: false,
        root,
        logLevel: 'error',
        plugins: [
          {
            name: 'no-side-effect-css',
            enforce: 'pre',
            resolveId: (id) => (id.endsWith('.css') ? '\0no-css' : null),
            load: (id) => (id === '\0no-css' ? 'export {}' : null),
          },
        ],
      })
    ).module;
  const module = await load<Renderer>('src/web/developers/render.tsx');
  const previews = (
    await load<PreviewBuilder>('src/web/workbench/playground/build.tsx')
  ).blueprintPreviews(root, origin);
  const rendered: OutFile[] = module.renderSite(site, origin, options.head, loadGuideInputs(root));
  const urls = rendered.flatMap((f) => (f.url ? [f.url] : []));
  rendered.push({ file: PATHS.sitemap, body: module.sitemap(origin, urls) });
  rendered.push({ file: PATHS.previews, body: previews.json }, ...previews.files);
  // The ⌘K index: one file, fetched on the first search; the build fails past its 150 kB gzip budget.
  rendered.push(searchIndexFile(site));

  const manifest: Manifest = {};
  for (const f of rendered) {
    const ext = f.file.slice(f.file.lastIndexOf('.'));
    const type = TYPES[ext] ?? 'application/octet-stream';
    manifest[f.url ?? f.file] = { asset: assetPath(f.file), type };
    const target = join(options.out, f.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.body);
  }
  writeFileSync(join(options.out, 'developers/manifest.json'), JSON.stringify(manifest));
  return { files: rendered.map((f) => f.file), manifest, built: rendered };
}

if (import.meta.main) {
  const out = resolve(root, process.argv[2] ?? 'dist/client');
  const head = headTags(readFileSync(join(out, 'developers.html'), 'utf8'));
  const { files } = await buildDevelopers({ out, head });
  process.stdout.write(`developers: ${files.length} files\n`);
}
