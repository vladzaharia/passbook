import type { z } from 'zod';
import {
  MAPPING_SIGNATURE_OVERLAP,
  PASS_IMPORT_SAVED_MAX,
  type SavedImportMappingSchema,
  SavedImportMappingsSchema,
} from '../../../shared/contracts/pass-imports.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { ImportPlan } from './import-plan.ts';
import { parsePlan } from './import-plan.ts';
import { savedPlan, savePlan } from './repo-import-mappings.ts';

export type SavedMapping = z.infer<typeof SavedImportMappingSchema>;
export interface Mappings {
  saved: SavedMapping[];
  last: ImportPlan | null;
}

export const who = (a: TenantPassWrite) => (a.kind === 'session' ? a.userId : a.keyId);

/** What an org keeps for a template: named mappings and the last plan checked. A bare plan is the old form of `last`. */
export async function readMappings(
  ctx: ServiceContext,
  orgId: string,
  templateId: string,
): Promise<Mappings> {
  const json = await savedPlan(ctx.env.DB, orgId, templateId);
  if (json === null) return { saved: [], last: null };
  let raw: unknown = null;
  try {
    raw = JSON.parse(json);
  } catch {
    // Logged by parsePlan below as unreadable.
  }
  if (typeof raw === 'object' && raw !== null && (raw as { v?: unknown }).v === 2) {
    const parsed = SavedImportMappingsSchema.safeParse(raw);
    if (parsed.success) return { saved: parsed.data.saved, last: parsed.data.last ?? null };
    ctx.log.warn('pass_import.plan_unreadable', { code: 'IMPORT_PLAN_UNREADABLE' });
    return { saved: [], last: null };
  }
  return { saved: [], last: parsePlan(json, ctx.log) };
}

async function writeMappings(
  ctx: ServiceContext,
  a: TenantPassWrite,
  templateId: string,
  m: Mappings,
): Promise<void> {
  const value = { v: 2, saved: m.saved, ...(m.last ? { last: m.last } : {}) };
  await savePlan(ctx, a, templateId, JSON.stringify(value), who(a));
}

/** Remembers the plan of a check as the unnamed last one; cell fixes belong to one file and are dropped. */
export async function rememberPlan(
  ctx: ServiceContext,
  a: TenantPassWrite,
  templateId: string,
  plan: ImportPlan,
): Promise<void> {
  const { overrides: _fixes, ...rest } = plan;
  const m = await readMappings(ctx, a.orgId, templateId);
  await writeMappings(ctx, a, templateId, { saved: m.saved, last: rest });
}

const fold = (h: string) => h.trim().toLowerCase();

/** The saved mapping whose columns share at least 80% with the file's headers. */
export function pickSaved(
  saved: readonly SavedMapping[],
  header: readonly string[],
): SavedMapping | null {
  const file = new Set(header.map(fold));
  let best: { s: SavedMapping; share: number } | null = null;
  for (const s of saved) {
    const own = new Set(s.columns.map(fold));
    const shared = [...own].filter((h) => file.has(h)).length;
    const share = shared / Math.max(own.size, file.size, 1);
    if (share >= MAPPING_SIGNATURE_OVERLAP && (!best || share > best.share)) best = { s, share };
  }
  return best?.s ?? null;
}

export async function putSaved(
  ctx: ServiceContext,
  a: TenantPassWrite,
  templateId: string,
  mapping: Omit<SavedMapping, 'savedAt'>,
): Promise<SavedMapping[]> {
  const m = await readMappings(ctx, a.orgId, templateId);
  const { overrides: _fixes, ...plan } = mapping.plan;
  const next: SavedMapping = { ...mapping, plan, savedAt: ctx.clock.now() };
  const others = m.saved.filter((s) => s.name !== mapping.name);
  if (others.length >= PASS_IMPORT_SAVED_MAX)
    throw new ValidationError(
      `Keep at most ${PASS_IMPORT_SAVED_MAX} saved mappings. Delete one first.`,
      [],
      'IMPORT_MAPPINGS_FULL',
    );
  const saved = [...others, next];
  await writeMappings(ctx, a, templateId, { saved, last: m.last });
  return saved;
}

export async function deleteSaved(
  ctx: ServiceContext,
  a: TenantPassWrite,
  templateId: string,
  name: string,
): Promise<SavedMapping[]> {
  const m = await readMappings(ctx, a.orgId, templateId);
  const saved = m.saved.filter((s) => s.name !== name);
  if (saved.length !== m.saved.length)
    await writeMappings(ctx, a, templateId, { saved, last: m.last });
  return saved;
}
