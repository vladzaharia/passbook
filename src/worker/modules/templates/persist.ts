import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationReport,
} from '../../../passkit/types.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  activateStmt,
  findTemplateBySlug,
  getVersion,
  insertUploadedTemplateStmt,
  insertVersionStmt,
  type TemplateRow,
} from './repo.ts';

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : 'template';
}

export interface TemplatePlan {
  templateId: string;
  isNew: boolean;
  existing: TemplateRow | null;
}

/** Re-uploading a slug adds a version to the same template. Baked slugs are off limits. */
export async function planTemplate(
  ctx: ServiceContext,
  orgId: string | null,
  slug: string,
): Promise<TemplatePlan> {
  const existing = await findTemplateBySlug(ctx.env.DB, orgId, slug);
  if (existing?.origin === 'baked')
    throw new ForbiddenError('A baked template uses this name. Pick another.', 'TEMPLATE_BAKED');
  return { templateId: existing?.id ?? ctx.ids.id(), isNew: !existing, existing };
}

export interface VersionBody {
  version: string;
  manifest: TemplateManifest;
  passJson: PassJson;
  assets: AssetEntry[];
  report: ValidationReport;
  styles: PassStyle[];
}

export interface CommitArgs {
  plan: TemplatePlan;
  orgId: string | null;
  slug: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  body: VersionBody;
  /** Make the version active (the default). A new template always starts active. */
  activate?: boolean;
}

/** Writes the version and makes it active, in one batch. Returns whether the version was new. */
export async function commitVersion(
  ctx: ServiceContext,
  args: CommitArgs,
): Promise<{ templateId: string; versionCreated: boolean }> {
  const db = ctx.env.DB;
  const { plan, body } = args;
  const now = ctx.clock.now();
  const versionCreated = plan.isNew || !(await getVersion(db, plan.templateId, body.version));
  const statements: D1PreparedStatement[] = [];
  if (plan.isNew) {
    statements.push(
      insertUploadedTemplateStmt(db, {
        id: plan.templateId,
        orgId: args.orgId,
        slug: args.slug,
        name: args.name,
        description: args.description,
        activeVersion: body.version,
        styles: body.styles,
        createdBy: args.createdBy,
        now,
      }),
    );
  }
  statements.push(
    insertVersionStmt(db, {
      templateId: plan.templateId,
      version: body.version,
      manifest: body.manifest,
      passJson: body.passJson,
      assets: body.assets,
      report: body.report,
      createdBy: args.createdBy,
      createdAt: now,
    }),
  );
  if (!plan.isNew && args.activate !== false)
    statements.push(
      activateStmt(db, plan.templateId, body.version, {
        name: args.name,
        description: args.description,
        styles: body.styles,
        now,
      }),
    );
  try {
    await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message))
      throw new ConflictError(
        'A template with this name was created meanwhile. Retry.',
        'TEMPLATE_SLUG_CONFLICT',
      );
    throw error;
  }
  return { templateId: plan.templateId, versionCreated };
}
