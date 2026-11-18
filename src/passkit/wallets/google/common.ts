/** Pieces every type builder shares: class base, typed class base and the common object body. */
import type { Ctx } from './ctx.ts';
import { moduleBodies } from './fields.ts';
import { type PickSpec, pickImage } from './images.ts';
import { MIN_HERO, MIN_LOGO, MIN_MODULE_IMAGE, MIN_WIDE_LOGO } from './limits.ts';
import { backgroundColor, barcodeOf, stateOf, timeInterval } from './parts.ts';
import type {
  GoogleClassCommon,
  GoogleImage,
  GoogleObjectCommon,
  GoogleTypedClassCommon,
} from './types.ts';

/** Why a typed class without a program logo falls back to Generic. */
export const NEEDS_LOGO = `Needs a logo of at least ${MIN_LOGO.width} x ${MIN_LOGO.height} px.`;

export const LOGO: PickSpec = {
  override: 'logo',
  apple: ['icon', 'logo'],
  min: MIN_LOGO,
  loss: 'omitted',
};
const WIDE_LOGO: PickSpec = { apple: ['logo'], min: MIN_WIDE_LOGO, loss: 'omitted', quiet: true };
const HERO: PickSpec = {
  override: 'hero',
  apple: ['strip', 'background', 'artwork'],
  min: MIN_HERO,
  loss: 'omitted',
};
const THUMBNAIL: PickSpec = {
  override: 'thumbnail',
  apple: ['thumbnail'],
  min: MIN_MODULE_IMAGE,
  loss: 'omitted',
};

export const logoOf = (ctx: Ctx, spec: PickSpec = LOGO): GoogleImage | undefined =>
  pickImage(ctx, spec);
export const wideLogoOf = (ctx: Ctx): GoogleImage | undefined => pickImage(ctx, WIDE_LOGO);
export const heroOf = (ctx: Ctx): GoogleImage | undefined => pickImage(ctx, HERO);

/** One holder per save link (google-wallet.md section 7, G6), background colour on typed classes. */
export function classBase(ctx: Ctx, withColor: boolean): GoogleClassCommon {
  const hexBackgroundColor = withColor ? backgroundColor(ctx) : undefined;
  return {
    multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    ...(hexBackgroundColor ? { hexBackgroundColor } : {}),
  };
}

/** A typed class: the issuer name is the organization and the class goes through review (Q16). */
export function typedClass(ctx: Ctx, hero: GoogleImage | undefined): GoogleTypedClassCommon {
  return {
    ...classBase(ctx, true),
    issuerName: ctx.display('org', ctx.view.org, { unit: 'chars', max: 100 }),
    reviewStatus: 'UNDER_REVIEW',
    ...(hero ? { heroImage: hero } : {}),
  };
}

export interface ObjectOptions {
  start?: string;
  end?: string;
  /** Types that show one event and list the rest as text. */
  events: boolean;
}

/** State, barcode, dates, thumbnail module, text and link modules. Call it after the native roles are taken. */
export function objectCommon(ctx: Ctx, options: ObjectOptions): GoogleObjectCommon {
  const state = stateOf(ctx);
  const barcode = barcodeOf(ctx);
  const interval = timeInterval(ctx, options.start, options.end);
  const thumbnail = pickImage(ctx, THUMBNAIL);
  const modules = moduleBodies(ctx, { events: options.events });
  return {
    ...state,
    ...(barcode ? { barcode } : {}),
    ...(interval ? { validTimeInterval: interval } : {}),
    ...(thumbnail ? { imageModulesData: [{ id: 'thumbnail', mainImage: thumbnail }] } : {}),
    ...modules,
  };
}
