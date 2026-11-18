/** Samsung attribute limits (samsung-wallet.md section 2). Counted in UTF-8 bytes, the safe reading of `String(n)`. */
import type { TextLimit } from '../text.ts';

const bytes = (max: number): TextLimit => ({ unit: 'bytes', max });

export const SAMSUNG_LIMITS = {
  title: bytes(32),
  providerName: bytes(32),
  appLinkLogo: bytes(256),
  appLinkName: bytes(32),
  appLinkData: bytes(256),
  logoImage: bytes(256),
  bgImage: bytes(256),
  mainImg: bytes(256),
  noticeDesc: bytes(5000),
  locations: bytes(1024),
  amount: bytes(32),
  balance: bytes(32),
  'barcode.value': bytes(4096),
  reservationNumber: bytes(32),
  eventId: bytes(32),
  'csInfo.call': bytes(32),
  'csInfo.email': bytes(64),
  'csInfo.webSite': bytes(256),
} as const;
export type LimitedAttribute = keyof typeof SAMSUNG_LIMITS;

/** Samsung shows at most this many locations; the JSON also has to fit `locations`. */
export const MAX_LOCATIONS = 10;
/** A line is shortened into the rest of the notice only when at least this many bytes are left. */
export const NOTICE_MIN_ROOM = 64;
