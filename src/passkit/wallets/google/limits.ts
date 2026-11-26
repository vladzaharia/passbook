/**
 * What the Google compilers enforce. Google publishes no hard text limits (google-wallet.md
 * section 1, UNCONFIRMED), so these are PassBook bounds: display text over them is shortened with
 * an ellipsis (Q20); identity values are never cut and block the pass instead.
 */
import type { TextLimit } from '../text.ts';

const chars = (max: number): TextLimit => ({ unit: 'chars', max });

export const TEXT = {
  /** Card title, header, program and provider names, labels. */
  title: chars(100),
  /** Subheader, venue, offer title. */
  line: chars(200),
  /** A text module body. */
  body: chars(500),
  /** Offer details and fine print. */
  long: chars(2000),
} as const;

/** Member id, gift card number and pin, ticket number, confirmation code, event id. */
export const IDENTITY: TextLimit = chars(512);
/** The most a QR code can hold in byte mode: no barcode Google renders is longer. */
export const BARCODE_MESSAGE: TextLimit = { unit: 'bytes', max: 2953 };

/** Text modules and link URIs shown from the object; locations and messages the API allows. */
export const MAX_MODULES = 10;
export const MAX_URIS = 10;
export const MAX_LOCATIONS = 10;
/** A class or object body larger than this is refused (carried over from the first Google projection). */
export const MAX_BODY_BYTES = 32_768;

/** Image minimums from the brand guidelines; a smaller file is never upscaled (architecture 2.4). */
export const MIN_LOGO = { width: 660, height: 660 } as const;
export const MIN_WIDE_LOGO = { height: 400 } as const;
export const MIN_HERO = { width: 1032 } as const;
export const MIN_MODULE_IMAGE = { width: 1860 } as const;

export const DEFAULT_LANGUAGE = 'en';
/** Bump with any change to compiled output: it joins the release candidate digest. */
export const COMPILER_REVISION = 6;
