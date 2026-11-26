import type { z } from 'zod';
import { ownBrandParts } from '../../../passkit/template/brand.ts';
import { effectiveChannels } from '../../../shared/channels.ts';
import { CHANNELS, type Channel, type ChannelLevel } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import type {
  BrandPart,
  SetupChannel,
  SetupTemplate,
} from '../../../shared/contracts/pass-setup.ts';
import type {
  WalletEnrolment,
  WalletProvider,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SetupFacts } from '../../../shared/org-setup-checks.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { upperLevels } from '../channels/chain.ts';
import * as channelsRepo from '../channels/repo.ts';
import { levels } from '../channels/service.ts';
import { defaultPlatformPassIdentity } from '../identities/repo-platform-default.ts';
import { latestRun } from '../identities/repo-runs.ts';
import { toRunDto } from '../identities/runs-service.ts';
import { listWalletIdentities } from '../identities/wallet-list.ts';
import { placeholderSlots, sourceArtHashes } from '../passes/branding.ts';
import { orgSettingsStmt } from '../settings/repo.ts';
import {
  getOrgSettings,
  getPlatformSettings,
  type OrgSettings,
  primeOrgSettings,
} from '../settings/service.ts';
import { enrolmentView } from '../wallet-providers/enrolment-read.ts';
import { type EnrolmentRow, enrolmentsOf } from '../wallet-providers/repo-enrolments.ts';
import { webSameAsLogo } from './brand.ts';
import { allowedMarks, effectiveMark } from './brand-mark.ts';
import { type OrgRow, orgRowStmt } from './repo.ts';
import {
  apnsHealthOf,
  passCountOf,
  policiesOf,
  setupTemplateRows,
  sharedPassCountOf,
} from './repo-pass-setup.ts';

type Branding = z.infer<typeof OrgBrandingSchema>;
const PROVIDERS = ['google', 'samsung'] as const;

/** What the caller may change, per level, for `canChange`. */
export interface SetupCan {
  /** PassBook and Plan: a platform admin only. */
  platform: boolean;
  org: boolean;
  template: boolean;
}

export interface LoadedSetup {
  facts: SetupFacts;
  /** The org row's `config_revision` and the enrolment rows, which make the revision. */
  enrolments: EnrolmentRow[];
  branding: StoredBranding;
  /** The org's settings as read with the org row. */
  settings: OrgSettings;
  /** The org's `config_revision` the view was read at: the save's compare-and-set. */
  config: number;
}

/** The stored branding, unparsed: images carry their `storageVersion`, which a save must keep. */
export type StoredBranding = Branding & {
  logo?: Branding['logo'] & { storageVersion?: string };
  icon?: Branding['icon'] & { storageVersion?: string };
};

const brandingOf = (json: string): StoredBranding => {
  const parsed = OrgBrandingSchema.safeParse(JSON.parse(json));
  return parsed.success ? (JSON.parse(json) as StoredBranding) : {};
};

/** An image as the view shows it: no storage detail. */
const shown = (image: Branding['logo']) =>
  image ? { sha: image.sha, w: image.w, h: image.h } : null;

/** Opaque: it moves with the org's profile and settings, template policies, and the mode's enrolments. */
export function revisionOf(mode: Mode, config: number, rows: readonly EnrolmentRow[]): string {
  const rev = (p: string) => rows.find((r) => r.provider === p)?.enrolment_revision ?? 0;
  return `${mode}.${config}.${rev('google')}.${rev('samsung')}`;
}

const by = <T>(value: T | null | undefined, source: 'org' | 'passbook' = 'org') => ({
  value: value ?? null,
  source: value === null || value === undefined ? ('passbook' as const) : source,
});

const ownCount = (templates: readonly SetupTemplate[], part: BrandPart) =>
  templates.filter((t) => t.ownBrand.includes(part)).length;

/** Templates with their own channel view, and the per-channel template counts. */
async function loadTemplates(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  upper: Awaited<ReturnType<typeof levels>>,
): Promise<{ templates: SetupTemplate[]; counts: Record<Channel, SetupChannel['templates']> }> {
  const db = ctx.env.DB;
  const [rows, policies] = await Promise.all([
    setupTemplateRows(db, orgId),
    policiesOf(db, orgId, mode),
  ]);
  const counts = Object.fromEntries(
    CHANNELS.map((c) => [c, { on: 0, off: 0, never: 0, total: rows.length }]),
  ) as Record<Channel, SetupChannel['templates']>;
  const templates = await Promise.all(
    rows.map(async (row): Promise<SetupTemplate> => {
      const released = await channelsRepo.releasedVersion(db, row.id, orgId, mode);
      const cap = await channelsRepo.capabilityOf(db, row.id, released ?? row.active_version);
      const stored = policies.get(row.id);
      const policy = stored ? channelsRepo.parsePolicy(stored) : null;
      const inputs = {
        ...upper,
        capability: {
          ...(cap.google ? {} : { google: 'no_design' as const }),
          ...(cap.samsung ? {} : { samsung: 'no_design' as const }),
        },
        template: policy,
        defaults: cap.defaults,
        pass: {},
        retired: {},
      };
      // The template's own state, whatever stops the channel above it.
      const own = effectiveChannels({ ...inputs, platform: {}, entitlement: {}, org: {} });
      for (const c of CHANNELS) {
        const status = own[c];
        if (status.reason === 'never') counts[c].never += 1;
        else if (status.on) counts[c].on += 1;
        else counts[c].off += 1;
      }
      const assets = row.assets ? (JSON.parse(row.assets) as { slot: string; sha1: string }[]) : [];
      const placeholders = placeholderSlots(row.id, assets, await sourceArtHashes(db, row.id));
      return {
        id: row.id,
        name: row.name,
        ownBrand: ownBrandParts({ brand: row.brand ? JSON.parse(row.brand) : undefined }),
        placeholders: placeholders.filter(
          (s): s is 'logo' | 'icon' => s === 'logo' || s === 'icon',
        ),
        channels: effectiveChannels(inputs),
      };
    }),
  );
  return { templates, counts };
}

function chainOf(
  c: Channel,
  upper: Awaited<ReturnType<typeof levels>>,
  held: boolean,
  tplState: SetupChannel['templates'],
  can: SetupCan,
): ChannelLevel[] {
  const state =
    tplState.total === 0 || tplState.on === tplState.total
      ? 'ok'
      : tplState.on > 0
        ? 'partial'
        : 'off';
  return [
    ...upperLevels(c, upper, held, can),
    { level: 'template', state, canChange: can.template },
  ];
}

async function loadApple(ctx: ServiceContext, orgId: string, mode: Mode, managed: boolean) {
  const db = ctx.env.DB;
  const own = (await listWalletIdentities(ctx, { orgId, limit: 50 })).items.filter(
    (i) => i.kind !== 'platform',
  );
  // The identity new passes sign with: the default one while it still issues, else the newest issuing one.
  const identity =
    own.find((i) => i.isDefault && i.issuing) ?? own.findLast((i) => i.issuing) ?? null;
  const run = await latestRun(db, 'org', orgId, 'provision');
  return {
    identity,
    sharedIdentifier: (
      await defaultPlatformPassIdentity(db, {
        passTypeIdentifier: ctx.env.PLATFORM_PASS_TYPE_ID,
        teamIdentifier: ctx.env.PLATFORM_TEAM_ID,
      })
    ).passTypeIdentifier,
    push: identity ? await apnsHealthOf(db, identity.id) : ('unknown' as const),
    run: run ? toRunDto(run) : null,
    managedAllowed: managed,
    passesOnShared: await sharedPassCountOf(db, orgId, mode),
  };
}

/** A save not yet written: the view is built as if it had been (the dry run). */
export interface SetupChange {
  name?: string;
  branding?: string;
  settings?: OrgSettings;
  /** Enrolments the save turns on. */
  enable?: readonly WalletProvider[];
}

export async function loadSetupFacts(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  can: SetupCan,
  change: SetupChange = {},
): Promise<LoadedSetup> {
  const db = ctx.env.DB;
  // The org row and its settings in one read transaction, never from the settings cache: the plan and the
  // save's compare-and-set must see the same state.
  const [orgRes, settingsRes] = await db.batch([orgRowStmt(db, orgId), orgSettingsStmt(db, orgId)]);
  const found = orgRes?.results[0] as OrgRow | undefined;
  if (!found || !settingsRes) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  primeOrgSettings(ctx, orgId, settingsRes);
  const [saved, platform, plan, marks, enrolled] = await Promise.all([
    getOrgSettings(ctx, orgId),
    getPlatformSettings(ctx),
    entitlementsOf(ctx, orgId),
    allowedMarks(ctx, orgId),
    enrolmentsOf(db, orgId, mode),
  ]);
  const row = {
    ...found,
    name: change.name ?? found.name,
    branding: change.branding ?? found.branding,
  };
  const settings = change.settings ?? saved;
  const upper = await levels(ctx, orgId, mode, settings);
  const now = ctx.clock.now();
  const enrolments = enrolled.map((r) =>
    change.enable?.includes(r.provider) ? { ...r, enabled_at: now } : r,
  );
  for (const provider of change.enable ?? []) delete upper.org[provider];
  const stored = brandingOf(row.branding);
  const [{ templates, counts }, accounts, apple, passCount] = await Promise.all([
    loadTemplates(ctx, orgId, mode, upper),
    Promise.all(
      PROVIDERS.map((p) =>
        enrolmentView(ctx, orgId, mode, p, enrolments.find((r) => r.provider === p) ?? null),
      ),
    ),
    loadApple(ctx, orgId, mode, isEntitled(plan, 'identity.managed')),
    passCountOf(db, orgId, mode),
  ]);
  const account = new Map<string, WalletEnrolment>(accounts.map((a) => [a.provider, a]));
  const channels = Object.fromEntries(
    CHANNELS.map((c) => {
      const acc = account.get(c);
      const blocked = settings['channels.blocked'].includes(c);
      const levelsOf = chainOf(c, upper, acc?.state === 'held', counts[c], can);
      const channel: SetupChannel = {
        on: !levelsOf.slice(0, 3).some((l) => l.state !== 'ok'),
        // The switch: not blocked, and for NFC tags not turned off in its own setting.
        allowed: !blocked && (c !== 'nfc' || settings['nfc.tags'].enabled),
        levels: levelsOf,
        templates: counts[c],
        ...(acc ? { account: acc } : {}),
      };
      return [c, channel];
    }),
  ) as Record<Channel, SetupChannel>;
  const accent = stored.accent ?? settings['branding.accent'];
  const supportEmail = settings['support.email'] ?? stored.supportEmail;
  const supportUrl = settings['support.url'] ?? stored.supportUrl;
  const fromName = settings['email.fromName'];
  const facts: SetupFacts = {
    orgId,
    mode,
    revision: revisionOf(mode, row.config_revision, enrolments),
    passCount,
    brand: {
      name: { value: row.name, source: 'org' },
      logo: { ...by(shown(stored.logo)), templatesOwn: ownCount(templates, 'logo') },
      icon: { ...by(shown(stored.icon)), templatesOwn: ownCount(templates, 'icon') },
      webLogo: {
        ...by(shown(stored.web)),
        sameAsLogo: webSameAsLogo(settings['branding.webLogoSameAsLogo'], stored),
      },
      passColors: { ...by(stored.passColors), templatesOwn: ownCount(templates, 'colors') },
      logoHasName: by(stored.logoHasName),
      accent: by(accent),
      mark: {
        chosen: stored.mark ?? 'full',
        effective: effectiveMark(stored.mark, marks),
        allowed: [...marks],
      },
      support: { email: by(supportEmail), url: by(supportUrl) },
      email: {
        fromName: fromName
          ? by(fromName)
          : { value: `${row.name} via ${platform['email.senderName']}`, source: 'passbook' },
        buddy: settings['email.buddy'],
      },
    },
    channels,
    apple,
    templates,
  };
  return {
    facts,
    enrolments: enrolled,
    branding: brandingOf(found.branding),
    settings: saved,
    config: found.config_revision,
  };
}
