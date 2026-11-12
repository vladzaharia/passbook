import type { AssetEntry, PassJson, PassStyle, TemplateManifest } from '../types.ts';
import { PASS_STYLES } from '../types.ts';
import { classifyAsset } from './package.ts';
import type { ResolvedTemplate, TemplateRegistry, TemplateSummary } from './registry.ts';

export interface InMemoryTemplateInput {
  id: string;
  orgId?: string | null;
  slug?: string;
  version?: string;
  origin?: 'baked' | 'uploaded';
  manifest: TemplateManifest;
  passJson: PassJson;
  /** name -> bytes. Entries become inline assets. */
  assets?: Record<string, Uint8Array>;
}

/** Test registry. Real registries (baked + D1/R2) are built by the templates module. */
export class InMemoryTemplateRegistry implements TemplateRegistry {
  #templates = new Map<string, ResolvedTemplate>();
  #bytes = new Map<string, Uint8Array>();

  add(input: InMemoryTemplateInput): ResolvedTemplate {
    const version = input.version ?? 'v1';
    const entries: AssetEntry[] = Object.entries(input.assets ?? {}).map(([name, bytes]) => {
      this.#bytes.set(`${input.id}@${version}/${name}`, bytes);
      return {
        name,
        // The slot a package of this name would get: provider projections read it.
        ...(classifyAsset(name) ?? { slot: 'other', scale: 1 }),
        size: bytes.length,
        sha1: '',
        crc32: 0,
        source: { kind: 'inline' },
      };
    });
    const styles = PASS_STYLES.filter((s): s is PassStyle => typeof input.passJson[s] === 'object');
    const template: ResolvedTemplate = {
      id: input.id,
      version,
      orgId: input.orgId ?? null,
      origin: input.origin ?? 'uploaded',
      manifest: input.manifest,
      passJson: input.passJson,
      assets: entries,
      styles,
    };
    this.#templates.set(`${input.id}@${version}`, template);
    this.#templates.set(`${input.id}@`, template);
    return template;
  }

  async list(query: { orgId?: string | null }): Promise<TemplateSummary[]> {
    const out: TemplateSummary[] = [];
    for (const [key, t] of this.#templates) {
      if (!key.endsWith('@')) continue;
      if (query.orgId !== undefined && t.orgId !== null && t.orgId !== query.orgId) continue;
      out.push({
        id: t.id,
        orgId: t.orgId,
        slug: t.id,
        name: t.manifest.name,
        origin: t.origin,
        activeVersion: t.version,
        status: 'active',
        styles: t.styles,
      });
    }
    return out;
  }

  async resolve(id: string, version?: string): Promise<ResolvedTemplate> {
    const found = this.#templates.get(`${id}@${version ?? ''}`);
    if (!found) throw new Error(`Template ${id}${version ? `@${version}` : ''} not found`);
    return found;
  }

  async openAsset(template: ResolvedTemplate, name: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.#bytes.get(`${template.id}@${template.version}/${name}`);
    if (!bytes) throw new Error(`Asset ${name} not found`);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
}
