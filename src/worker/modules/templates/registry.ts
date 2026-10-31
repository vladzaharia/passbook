import type {
  ResolvedTemplate,
  TemplateRegistry,
  TemplateSummary,
} from '../../../passkit/template/registry.ts';
import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import type { AppEnv } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import { stylesOf } from './package/slots.ts';
import { getTemplate, getVersion, listTemplates } from './repo.ts';
import { generatedSource, type SyncSource, syncBakedTemplates } from './sync.ts';

export const BAKED_PREFIX = 'baked:';

export function r2Key(orgId: string, templateId: string, version: string, name: string): string {
  return `templates/${orgId}/${templateId}/${version}/${name}`;
}

export function r2Prefix(orgId: string, templateId: string): string {
  return `templates/${orgId}/${templateId}/`;
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

function fromBaked(t: BakedTemplate, orgId: string | null): ResolvedTemplate {
  return {
    id: t.id,
    version: t.version,
    orgId,
    origin: 'baked',
    manifest: t.manifest,
    passJson: t.passJson as PassJson,
    assets: t.assets as AssetEntry[],
    styles: t.styles,
  };
}

export class CompositeTemplateRegistry implements TemplateRegistry {
  readonly #env: AppEnv;
  readonly #source: SyncSource;
  readonly #ctx: ServiceContext;
  readonly #cache: Map<string, ResolvedTemplate>;

  constructor(env: AppEnv, options: RegistryOptions = {}) {
    this.#env = env;
    this.#source = options.source ?? generatedSource;
    this.#ctx = options.ctx ?? createServiceContext(env);
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
    if (id.startsWith(BAKED_PREFIX)) {
      await syncBakedTemplates(this.#ctx, this.#source);
      const baked = this.#source.templates.find((t) => t.id === id);
      if (baked && (!version || version === baked.version)) {
        const key = `${id}@${baked.version}`;
        const hit = this.#cache.get(key);
        if (hit) return hit;
        const row = await getTemplate(this.#env.DB, id);
        const resolved = fromBaked(baked, row?.orgId ?? null);
        this.#cache.set(key, resolved);
        return resolved;
      }
    }
    const row = await getTemplate(this.#env.DB, id);
    if (!row || row.status === 'deleted') throw notFound();
    const wanted = version ?? row.activeVersion;
    if (!wanted) throw notFound();
    const cached = this.#cache.get(`${id}@${wanted}`);
    if (cached) return cached;
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
    return this.#openSource(entry.source);
  }

  /** Static preview files that are not part of the pass bundle (baked only). */
  async openExtra(template: ResolvedTemplate, name: string): Promise<ReadableStream<Uint8Array>> {
    const extra = this.#source.templates
      .find((t) => t.id === template.id && t.version === template.version)
      ?.extras.find((e) => e.name === name);
    if (!extra) throw new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
    return this.#openSource({ kind: 'static', path: extra.path });
  }

  async #openSource(source: AssetEntry['source']): Promise<ReadableStream<Uint8Array>> {
    const missing = () => new NotFoundError('Asset not found.', 'ASSET_NOT_FOUND');
    if (source.kind === 'static') {
      const response = await this.#env.ASSETS.fetch(
        new Request(new URL(source.path, this.#env.PUBLIC_BASE_URL)),
      );
      if (!response.ok || !response.body) throw missing();
      return response.body;
    }
    if (source.kind === 'r2') {
      const object = await this.#env.BUCKET.get(source.key);
      if (!object) throw missing();
      return object.body;
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
