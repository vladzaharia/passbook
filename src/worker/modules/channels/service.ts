import {
  anyDigitalOn,
  blockedByEntitlement,
  type ChannelInputs,
  DIGITAL_CHANNELS,
  defaultOf,
  effectiveChannels,
} from '../../../shared/channels.ts';
import {
  CHANNELS,
  type Channel,
  type ChannelReason,
  type PassChannelsDto,
  type TemplateChannelsDto,
} from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { CHANNEL_COPY } from '../../../shared/copy/channels.ts';
import { isEntitled } from '../../platform/entitlements.ts';
import { entitlementsIn } from '../../platform/feature-guard.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { getOrgSettings, getPlatformSettings, type OrgSettings } from '../settings/service.ts';
import { walletProviderDisabledReason } from '../wallet-providers/provider-policy.ts';
import { type ChainCan, passChains, templateChains } from './chain.ts';
import { passReplaceable } from './replaceable.ts';
import * as repo from './repo.ts';
import { rotationOwed } from './repo-replace.ts';
import { overrideCounts, overridePassCount } from './repo-reset.ts';
import { openWindows, splitWindows } from './windows.ts';

type Per<T> = Partial<Record<Channel, T>>;

/** Platform and org levels: the same for every template of the org. */
export async function levels(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  /** The org's settings when the caller already has them, or a change not yet saved. */
  settings?: OrgSettings,
): Promise<Pick<ChannelInputs, 'platform' | 'entitlement' | 'org'>> {
  const [platformSettings, org, entitlements] = await Promise.all([
    getPlatformSettings(ctx),
    settings ?? getOrgSettings(ctx, orgId),
    entitlementsIn(ctx, orgId, mode),
  ]);
  const platform: Per<ChannelReason> = {};
  if (!platformSettings['print.enabled']) platform.paper = 'printing_off';
  if (!platformSettings['nfc.tagsEnabled']) platform.nfc = 'tags_off';
  const blocked: Per<ChannelReason> = {};
  for (const p of ['google', 'samsung'] as const) {
    const reason = await walletProviderDisabledReason(
      ctx.env.DB,
      p,
      orgId,
      mode,
      isEntitled(entitlements, `wallet.${p}`),
    );
    if (reason === 'not_released') platform[p] = reason;
    else if (reason === 'not_enrolled') blocked[p] = reason;
  }
  for (const c of org['channels.blocked']) blocked[c] = 'blocked';
  if (!org['nfc.tags'].enabled) blocked.nfc = 'tags_off';
  const entitlement = blockedByEntitlement(entitlements);
  // A developer org's passes are never added to Apple Wallet: the channel reads as not included.
  if (await isPreviewOnlyOrg(ctx.env.DB, orgId)) entitlement.apple = 'not_included';
  return { platform, entitlement, org: blocked };
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
        memo(lv, `${pass.orgId}:${pass.mode}`, () => levels(ctx, pass.orgId, pass.mode)),
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
          defaults: capability.defaults,
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

/** The caller sees every level; it may change PassBook and Plan only as a platform admin. */
export const CAN_ORG: ChainCan = { platform: false, org: true, template: true };

export async function passChannels(
  ctx: ServiceContext,
  pass: Parameters<typeof loadPass>[1],
  can: ChainCan = CAN_ORG,
): Promise<PassChannelsDto> {
  const { inputs, rows } = await loadPass(ctx, pass);
  const now = ctx.clock.now();
  const [supported, windows] = await Promise.all([
    passReplaceable(ctx, pass),
    openWindows(ctx, pass.orgId, pass.mode, pass.templateId, now),
  ]);
  // A code is owed when a digital channel with a copy goes off and the last code predates it.
  const copies = rows.copies.filter((c) => DIGITAL_CHANNELS.includes(c));
  const owed =
    supported &&
    copies.length > 0 &&
    (await rotationOwed(
      ctx.env.DB,
      pass.orgId,
      pass.id,
      { ...rows.retired, ...Object.fromEntries(copies.map((c) => [c, now])) },
      copies,
    ));
  const split = splitWindows(windows);
  const effective = effectiveChannels(inputs);
  return {
    effective,
    levels: passChains(inputs, effective, can),
    overrides: inputs.pass,
    replace: {
      supported,
      owed,
      windows: split.windows,
      blocked: owed ? split.blocked : null,
      lastDigital: DIGITAL_CHANNELS.filter(
        (c) =>
          !anyDigitalOn(effectiveChannels({ ...inputs, pass: { ...inputs.pass, [c]: 'off' } })),
      ),
    },
  };
}

/** The template's own view: platform, org and capability of the org's released version, before any pass override. */
export async function loadTemplate(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
  policyOverride?: repo.Policy,
): Promise<{ inputs: ChannelInputs; policy: repo.Policy | null; revision: number }> {
  const [lv, stored, version] = await Promise.all([
    levels(ctx, template.orgId, mode),
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
      defaults: cap.defaults,
      pass: {},
      retired: {},
    },
  };
}

export const channelDefaults = (inputs: ChannelInputs): TemplateChannelsDto['defaults'] =>
  Object.fromEntries(
    CHANNELS.map((c) => [c, defaultOf(inputs, c)]),
  ) as TemplateChannelsDto['defaults'];

/** What a template's channel responses add to its effective view: the chain and the override counts. */
export async function templateExtras(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
  inputs: ChannelInputs,
  can: ChainCan = CAN_ORG,
): Promise<Pick<TemplateChannelsDto, 'levels' | 'overrides' | 'overridePasses'>> {
  const overrides = await overrideCounts(ctx.env.DB, template.orgId, mode, template.id);
  const any = CHANNELS.some((c) => (overrides[c] ?? 0) > 0);
  return {
    levels: templateChains(inputs, effectiveChannels(inputs), can),
    overrides,
    overridePasses: any
      ? await overridePassCount(ctx.env.DB, template.orgId, mode, template.id, CHANNELS)
      : 0,
  };
}

export async function templateChannels(
  ctx: ServiceContext,
  template: repo.TemplateRef,
  mode: Mode,
  can: ChainCan = CAN_ORG,
): Promise<TemplateChannelsDto> {
  const { inputs, policy, revision } = await loadTemplate(ctx, template, mode);
  return {
    channels: policy,
    revision,
    effective: effectiveChannels(inputs),
    defaults: channelDefaults(inputs),
    ...(await templateExtras(ctx, template, mode, inputs, can)),
  };
}

const NOTICE_DAYS = 14;

/**
 * The line the hosted pass page shows when the code changed, whether or not an email went out (it may
 * be capped or skipped), and its holder opens the page to see the new code. Shown for two weeks.
 */
export async function codesReplacedNotice(
  ctx: ServiceContext,
  pass: { id: string; orgId: string },
): Promise<string | undefined> {
  const rotated = await repo.rotatedSince(
    ctx.env.DB,
    pass.orgId,
    pass.id,
    ctx.clock.now() - NOTICE_DAYS * 86_400_000,
  );
  return rotated ? CHANNEL_COPY.codesReplaced : undefined;
}
