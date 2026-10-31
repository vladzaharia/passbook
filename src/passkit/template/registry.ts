import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../types.ts';

export interface ResolvedTemplate {
  id: string;
  /** Content hash. Immutable, so resolutions can be cached for the life of the isolate. */
  version: string;
  orgId: string | null;
  origin: 'baked' | 'uploaded';
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  styles: PassStyle[];
}

export interface TemplateSummary {
  id: string;
  orgId: string | null;
  slug: string;
  name: string;
  origin: 'baked' | 'uploaded';
  activeVersion: string | null;
  status: 'active' | 'archived' | 'deleted';
  styles: PassStyle[];
}

export interface TemplateRegistry {
  list(query: { orgId?: string | null; includeArchived?: boolean }): Promise<TemplateSummary[]>;
  /** Resolves `version` or the active version. Throws NotFound-style errors for unknown ids. */
  resolve(id: string, version?: string): Promise<ResolvedTemplate>;
  /** Streams one asset of a resolved template. */
  openAsset(template: ResolvedTemplate, name: string): Promise<ReadableStream<Uint8Array>>;
}

export interface MutableTemplateRegistry extends TemplateRegistry {
  upload(
    orgId: string,
    archive: ReadableStream<Uint8Array>,
    by: string,
  ): Promise<{ id: string; version: string; report: ValidationReport }>;
  /** Makes `version` active. Optionally starts the BulkReissue workflow. */
  activate(id: string, version: string, options?: { rebuildPasses?: boolean }): Promise<void>;
  /** Soft delete; hard delete only when no pass references any version. */
  archive(id: string): Promise<void>;
}
