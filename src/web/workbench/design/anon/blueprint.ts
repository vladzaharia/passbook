import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import type { DesignDoc } from '../../../admin/templates/designer/model.ts';
import type { BlueprintPreview } from '../../playground/model.ts';
import { fromBlueprint, type PgTemplate } from '../../playground/templates.ts';

type Template = z.infer<typeof TemplateDetailSchema>;

/** One blueprint as the designer core takes it: a template, its document, and the values the page edits. */
export interface AnonBlueprint {
  preview: BlueprintPreview;
  pg: PgTemplate;
  template: Template;
  doc: DesignDoc;
}

export function anonBlueprint(b: BlueprintPreview): AnonBlueprint {
  const pg = fromBlueprint(b);
  const manifest = { ...pg.manifest, sample: b.sample };
  return {
    preview: b,
    pg,
    doc: {
      passJson: b.passJson,
      manifest,
      assets: b.assets.map((a) => ({
        name: a.name,
        slot: a.slot,
        scale: a.scale,
        size: 0,
        ...(a.width ? { width: a.width } : {}),
        ...(a.height ? { height: a.height } : {}),
      })),
    },
    template: {
      id: b.id,
      orgId: null,
      orgName: null,
      slug: b.slug,
      name: b.name,
      description: b.description,
      origin: 'baked',
      status: 'active',
      activeVersion: '1',
      styles: [],
      blueprint: true,
      shared: false,
      icon: null,
      group: null,
      aliases: [],
      fromBlueprint: null,
      openReview: false,
      passCount: 0,
      createdAt: 0,
      updatedAt: 0,
      inputSchema: b.inputs as never,
      sample: b.sample as never,
      manifest: manifest as never,
      versions: [],
      passesOnOlderVersions: 0,
      passesBlocked: 0,
      restorable: false,
    },
  };
}
