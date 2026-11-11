import type {
  ResolvedTemplate,
  TemplateRegistry,
  TemplateSummary,
} from '../../../passkit/template/registry.ts';
import type { AssetEntry } from '../../../passkit/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';
import { sha1Hex } from './package/hash.ts';
import { stylesOf } from './package/slots.ts';
import { ReleaseContentError, readReleaseExtra } from './release-content.ts';
import { getTemplate, getVersion } from './repo.ts';
import { listTemplates } from './repo-list.ts';
import { listVersionExtras } from './repo-preview-extras.ts';
import { generatedSource, type SyncSource, syncBakedTemplates } from './sync.ts';

export const BAKED_PREFIX = 'baked:';

/** Key segment for templates with no org. */
const PLATFORM_SEGMENT = 'platform';

export function r2Key(
  orgId: string | null,
  templateId: string,
  version: string,
  name: string,
): string {
  return `templates/${orgId ?? PLATFORM_SEGMENT}/${templateId}/${version}/${name}`;
}

export function r2Prefix(orgId: string | null, templateId: string): string {
  return `templates/${orgId ?? PLATFORM_SEGMENT}/${templateId}/`;
}

export interface RegistryOptions {
  source?: SyncSource;
  ctx?: ServiceContext;
}

// Versions are immutable, so a resolution is valid for the life of the isolate.
const caches = new WeakMap<object, Map<string, ResolvedTemplate>>();

export function clearTemplateCache(env: AppEnv, templateId?: string): void {
  const cache = caches.get(env.DB);
  if (!cache) return;
  if (!templateId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) if (key.startsWith(`${templateId}@`)) cache.delete(key);
}

export class CompositeTemplateRegistry implements TemplateRegistry {
  readonly #env: AppEnv;
  readonly #source: SyncSource;
  readonly #ctx: ServiceContext;
  readonly #cache: Map<string, ResolvedTemplate>;

  constructor(env: AppEnv, options: RegistryOptions = {}) {
    this.#env = env;
    this.#source = options.source ?? generatedSource;
    this.#ctx = options.ctx ?? createDetachedContext(env);
    let cache = caches.get(env.DB);
    if (!cache) {
      cache = new Map();
      caches.set(env.DB, cache);
    }
    this.#cache = cache;
  }

  async list(query: {
    orgId?: string | null;
    includeArchived?: boolean;
  }): Promise<TemplateSummary[]> {
    await syncBakedTemplates(this.#ctx, this.#source);
    const rows = await listTemplates(this.#env.DB, {
      orgId: query.orgId,
      includeArchived: query.includeArchived,
      limit: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      slug: r.slug,
      name: r.name,
      origin: r.origin,
      activeVersion: r.activeVersion,
      status: r.status,
      styles: r.styles,
    }));
  }

  async resolve(id: string, version?: string): Promise<ResolvedTemplate> {
    const notFound = () => new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
    // Baked assets are copied to immutable version storage during sync. Resolve the stored
    // version, not the current bundle's static files, so issuance uses the approved bytes.
    if (id.startsWith(BAKED_PREFIX)) await syncBakedTemplates(this.#ctx, this.#source);
    const row = await getTemplate(this.#env.DB, id);
    if (!row || row.status === 'deleted') throw notFound();
    const wanted = version ?? row.activeVersion;
    if (!wanted) throw notFound();
    const cached = this.#cache.get(`${id}@${wanted}`);
    // A cached resolution is valid only while the template still belongs to the same org.
    if (cached && cached.orgId === row.orgId && cached.origin === row.origin) return cached;
    const v = await getVersion(this.#env.DB, id, wanted);
    if (!v) throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
    const resolved: ResolvedTemplate = {
      id,
      version: v.version,
      orgId: row.orgId,
      origin: row.origin,
      manifest: v.manifest,
      passJson: v.passJson,
      assets: v.assets,
      styles: stylesOf(v.passJson),
    };
    this.#cache.set(`${id}@${wanted}`, resolved);
    return resolved;
  }

  async openAsset(template: ResolvedTemplate, name: string): Promise<ReadableStream<Uint8Array>> {
    const entry = template.assets.find((a) => a.name === name);
    if (!entry) throw new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
    return this.#openSource(entry);
  }

  /** Extras are versioned and verified just like the approved bundle assets. */
  async openExtra(template: ResolvedTemplate, name: string): Promise<ReadableStream<Uint8Array>> {
    try {
      const extras = await listVersionExtras(this.#env.DB, template.id, template.version);
      const extra = extras.find((entry) => entry.name === name);
      if (!extra) throw new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
      const bytes = await readReleaseExtra(this.#ctx, extra);
      return new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>;
    } catch (error) {
      if (!(error instanceof ReleaseContentError)) throw error;
      this.#ctx.log.error('templates.extra_unavailable', {
        code: 'TEMPLATE_EXTRA_UNAVAILABLE',
        templateId: template.id,
        error,
      });
      throw new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
    }
  }

  async #openSource(entry: AssetEntry): Promise<ReadableStream<Uint8Array>> {
    const { source } = entry;
    const missing = () => new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
    if (source.kind === 'static') {
      const response = await this.#env.ASSETS.fetch(
        new Request(new URL(source.path, this.#env.PUBLIC_BASE_URL)),
      );
      // The SPA fallback answers unknown paths with index.html and a 200.
      const html = response.headers.get('content-type')?.startsWith('text/html');
      if (!response.ok || !response.body || html) throw missing();
      return response.body;
    }
    if (source.kind === 'r2') {
      const object = await this.#env.BUCKET.get(source.key);
      if (!object) throw missing();
      // The pass build trusts the metadata sha1 and crc32, so the bytes are checked once here, before
      // the asset cache can keep them.
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== entry.size || (await sha1Hex(bytes)) !== entry.sha1.toLowerCase())
        throw new ConflictError(
          'The approved template content or release policy changed.',
          'TEMPLATE_CONTENT_CHANGED',
        );
      return new Response(bytes as BufferSource).body as ReadableStream<Uint8Array>;
    }
    throw missing();
  }
}

/** The registry the rest of the app builds against. Keep this signature. */
export function createTemplateRegistry(
  env: AppEnv,
  options: RegistryOptions = {},
): CompositeTemplateRegistry {
  return new CompositeTemplateRegistry(env, options);
}
