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

function capabilityReasons(cap: repo.Capability): Per<ChannelReason> {
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

/** The pass's inputs: capability from its pinned version, policy from its template, its own rows. */
export async function loadPass(
  ctx: ServiceContext,
  pass: { id: string; orgId: string; mode: Mode; templateId: string; templateVersion: string },
): Promise<LoadedPass> {
  const [lv, policy, cap, rows] = await Promise.all([
    levels(ctx, pass.orgId),
    repo
      .getPolicy(ctx.env.DB, pass.orgId, pass.mode, pass.templateId)
      .then((r) => r?.channels ?? null),
    repo.capabilityOf(ctx.env.DB, pass.templateId, pass.templateVersion),
    repo.getPassChannelRows(ctx.env.DB, pass.id),
  ]);
  return {
    rows,
    paperHolder: cap.paperHolder,
    inputs: {
      ...lv,
      capability: capabilityReasons(cap),
      template: policy,
      scanTags: cap.scanTags,
      pass: rows.overrides,
      retired: rows.retired,
      retiredCause: rows.retiredCause,
    },
  };
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
      scanTags: cap.scanTags,
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
