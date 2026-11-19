import { type ChannelInputs, effectiveChannels } from '../../../shared/channels.ts';
import type {
  Channel,
  ChannelReason,
  PassChannelsDto,
  TemplateChannelsDto,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings, getPlatformSettings } from '../settings/service.ts';
import { walletProviderDisabledReason } from '../wallet-providers/provider-policy.ts';
import * as repo from './repo.ts';

type Per<T> = Partial<Record<Channel, T>>;

/** Platform and org levels: the same for every template of the org. */
async function levels(
  ctx: ServiceContext,
  orgId: string,
): Promise<Pick<ChannelInputs, 'platform' | 'org'>> {
  const [platformSettings, org] = await Promise.all([
    getPlatformSettings(ctx),
    getOrgSettings(ctx, orgId),
  ]);
  const platform: Per<ChannelReason> = {};
  if (!platformSettings['print.enabled']) platform.paper = 'printing_off';
  for (const p of ['google', 'samsung'] as const)
    if (walletProviderDisabledReason(p)) platform[p] = 'not_released';
  const blocked: Per<ChannelReason> = {};
  for (const c of org['channels.blocked']) blocked[c] = 'blocked';
  if (!org['nfc.tags'].enabled) blocked.nfc = 'tags_off';
  return { platform, org: blocked };
}

export function capabilityReasons(cap: repo.Capability): Per<ChannelReason> {
  const out: Per<ChannelReason> = {};
  if (!cap.google) out.google = 'no_design';
  if (!cap.samsung) out.samsung = 'no_design';
  return out;
}

export interface LoadedPass {
  inputs: ChannelInputs;
  rows: repo.PassChannelRows;
  /** The pinned version's paper block allows a holder print. */
  paperHolder: boolean;
}

type PassKey = {
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  templateVersion: string;
};

/**
 * Inputs for many passes: one rows query for all of them, and levels, policy and capability read
 * once per org, template and version however many passes share them.
 */
export async function loadMany(
  ctx: ServiceContext,
  passes: readonly PassKey[],
): Promise<Map<string, LoadedPass>> {
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = make();
      cache.set(key, hit);
    }
    return hit;
  };
  const lv = new Map<string, ReturnType<typeof levels>>();
  const pol = new Map<string, Promise<repo.Policy | null>>();
  const cap = new Map<string, Promise<repo.Capability>>();
  const allRows = await repo.getPassChannelRowsMany(
    ctx.env.DB,
    passes.map((p) => p.id),
  );
  const out = new Map<string, LoadedPass>();
  await Promise.all(
    passes.map(async (pass) => {
      const [levelsOf, policy, capability] = await Promise.all([
        memo(lv, pass.orgId, () => levels(ctx, pass.orgId)),
        memo(pol, `${pass.orgId}:${pass.mode}:${pass.templateId}`, () =>
          repo
            .getPolicy(ctx.env.DB, pass.orgId, pass.mode, pass.templateId)
            .then((r) => r?.channels ?? null),
        ),
        memo(cap, `${pass.templateId}:${pass.templateVersion}`, () =>
          repo.capabilityOf(ctx.env.DB, pass.templateId, pass.templateVersion),
        ),
      ]);
      const rows = allRows.get(pass.id) ?? repo.emptyRows();
      out.set(pass.id, {
        rows,
        paperHolder: capability.paperHolder,
        inputs: {
          ...levelsOf,
          capability: capabilityReasons(capability),
          template: policy,
          pass: rows.overrides,
          retired: rows.retired,
          retiredCause: rows.retiredCause,
        },
      });
    }),
  );
  return out;
}

/** The pass's inputs: capability from its pinned version, policy from its template, its own rows. */
export async function loadPass(ctx: ServiceContext, pass: PassKey): Promise<LoadedPass> {
  const loaded = (await loadMany(ctx, [pass])).get(pass.id);
  if (!loaded) throw new Error('unreachable: loadMany returns every pass');
  return loaded;
}

export async function passChannels(
  ctx: ServiceContext,
  pass: Parameters<typeof loadPass>[1],
): Promise<PassChannelsDto> {
  const { inputs } = await loadPass(ctx, pass);
  return { effective: effectiveChannels(inputs), overrides: inputs.pass };
}

/** The template's own view: platform, org and capability of the org's released version, before any pass override. */
export async function loadTemplate(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
  policyOverride?: repo.Policy,
): Promise<{ inputs: ChannelInputs; policy: repo.Policy | null; revision: number }> {
  const [lv, stored, version] = await Promise.all([
    levels(ctx, template.orgId),
    repo.getPolicy(ctx.env.DB, template.orgId, mode, template.id),
    repo.releasedVersion(ctx.env.DB, template.id, template.orgId, mode),
  ]);
  const cap = await repo.capabilityOf(ctx.env.DB, template.id, version ?? template.activeVersion);
  const policy = policyOverride ?? stored?.channels ?? null;
  return {
    policy: stored?.channels ?? null,
    revision: stored?.revision ?? 0,
    inputs: {
      ...lv,
      capability: capabilityReasons(cap),
      template: policy,
      pass: {},
      retired: {},
    },
  };
}

export async function templateChannels(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
): Promise<TemplateChannelsDto> {
  const { inputs, policy, revision } = await loadTemplate(ctx, template, mode);
  return { channels: policy, revision, effective: effectiveChannels(inputs) };
}
