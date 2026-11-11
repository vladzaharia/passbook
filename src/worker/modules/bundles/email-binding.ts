import { z } from 'zod';
import { sha256Hex } from '../../platform/ids.ts';
import { bindPass, matchesPass, PassDeliveryBindingSchema } from '../delivery/binding.ts';
import { DeliveryActorSchema } from '../delivery/delivery-actor.ts';
import { mapPass, type Pass } from '../passes/repo-map.ts';
import { type BundleRow, bundleEmailRows } from './repo.ts';

export const BundleEmailIntentSchema = z.object({
  format: z.literal(1),
  to: z.string(),
  bundleId: z.string(),
  orgId: z.string(),
  mode: z.enum(['live', 'test']),
  holderEmail: z.string().nullable(),
  name: z.string(),
  tokenHash: z.string().length(64),
  positions: z.array(z.number().int().nonnegative()).min(1),
  members: z.array(PassDeliveryBindingSchema).min(1),
  /** Who queued it; checked again when the mail goes out. */
  actor: DeliveryActorSchema.optional(),
});
export type BundleEmailIntent = z.infer<typeof BundleEmailIntentSchema>;

export interface BundleEmailSnapshot {
  bundle: BundleRow;
  passes: Pass[];
  positions: number[];
}

/** Bundle metadata and all members are read in one statement, not across a transfer. */
export async function bundleEmailSnapshot(
  db: D1Database,
  id: string,
): Promise<BundleEmailSnapshot | null> {
  const rows = await bundleEmailRows(db, id);
  const first = rows[0];
  if (!first) return null;
  const bundle: BundleRow = {
    id: first.email_bundle_id,
    org_id: first.email_bundle_org_id,
    mode: first.email_bundle_mode,
    name: first.email_bundle_name,
    token: first.email_bundle_token,
    token_rotated_at: first.email_bundle_token_rotated_at,
    holder_email: first.email_bundle_holder_email,
    created_at: first.email_bundle_created_at,
  };
  const passes = rows.map(mapPass);
  if (passes.some((pass) => pass.orgId !== bundle.org_id || pass.mode !== bundle.mode)) return null;
  return { bundle, passes, positions: rows.map((row) => row.email_bundle_position) };
}

export async function bindBundle(
  snapshot: BundleEmailSnapshot,
  to: string,
): Promise<BundleEmailIntent> {
  const { bundle, passes, positions } = snapshot;
  return {
    format: 1,
    to,
    bundleId: bundle.id,
    orgId: bundle.org_id,
    mode: bundle.mode,
    holderEmail: bundle.holder_email,
    name: bundle.name,
    tokenHash: await sha256Hex(bundle.token),
    positions,
    members: await Promise.all(passes.map(bindPass)),
  };
}

export async function matchesBundle(
  snapshot: BundleEmailSnapshot,
  binding: BundleEmailIntent,
): Promise<boolean> {
  const { bundle, passes, positions } = snapshot;
  if (
    bundle.id !== binding.bundleId ||
    bundle.org_id !== binding.orgId ||
    bundle.mode !== binding.mode ||
    bundle.holder_email !== binding.holderEmail ||
    passes.length !== binding.members.length ||
    positions.length !== binding.positions.length ||
    positions.some((position, index) => position !== binding.positions[index]) ||
    (await sha256Hex(bundle.token)) !== binding.tokenHash
  )
    return false;
  return passes.every((pass, i) => {
    const member = binding.members[i];
    return member ? matchesPass(pass, member) : false;
  });
}
