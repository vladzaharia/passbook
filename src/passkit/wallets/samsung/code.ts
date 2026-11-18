/** The barcode, locations, customer service contacts and the required app link. */
import { measure, shorten } from '../text.ts';
import type { BarcodeKind, ViewLink, WalletPassView } from '../types.ts';
import { block, isChosen, note, type Run, setDisplay, setWhole } from './context.ts';
import { MAX_LOCATIONS, SAMSUNG_LIMITS } from './limits.ts';
import { pickImage } from './media.ts';

const FORMATS: Record<BarcodeKind, { subFormat: string; serialType: string }> = {
  qr: { subFormat: 'QR_CODE', serialType: 'QRCODE' },
  pdf417: { subFormat: 'PDF_417', serialType: 'BARCODE' },
  aztec: { subFormat: 'AZTEC', serialType: 'BARCODE' },
  code128: { subFormat: 'CODE_128', serialType: 'BARCODE' },
  code39: { subFormat: 'CODE_39', serialType: 'BARCODE' },
  codabar: { subFormat: 'CODABAR', serialType: 'BARCODE' },
  ean13: { subFormat: 'EAN_13', serialType: 'BARCODE' },
  i2of5: { subFormat: 'ITF', serialType: 'BARCODE' },
};

/**
 * The first Apple barcode Samsung can draw, message byte for byte (scanner parity). Returns the
 * serial text Samsung shows under the code, so a role that repeats it is not listed twice.
 */
export function setBarcode(run: Run): string | undefined {
  const { barcodes } = run.view;
  const index = barcodes.findIndex((b) => b.kind !== 'other');
  if (index < 0) {
    if (barcodes.length > 0)
      note(run, 'barcode.format', 'barcodes.0', 'omitted', 'Samsung cannot draw this code format.');
    return undefined;
  }
  const code = barcodes[index];
  if (!code || code.kind === 'other') return undefined;
  if (!setWhole(run, 'barcode.value', code.message, 'IDENTITY_TOO_LONG', 'The barcode message'))
    return undefined;
  const { subFormat, serialType } = FORMATS[code.kind];
  let serial: string | undefined;
  let format = serialType;
  if (code.altText) {
    if (isChosen(run, 'barcode.altText'))
      note(run, 'barcode.altText', '', 'omitted', 'Left out by the author.');
    else if (code.altText === code.message) {
      format = `${serialType}SERIAL`;
      serial = code.message;
    } else
      note(
        run,
        'barcode.altText',
        '',
        'difference',
        'Samsung cannot show alt text that differs from the code.',
      );
  }
  run.attrs['barcode.serialType'] = serialType;
  run.attrs['barcode.ptFormat'] = format;
  run.attrs['barcode.ptSubFormat'] = subFormat;
  return serial;
}

/** `locations`: a JSON array string, greedy until the limit or the count is reached. */
export function setLocations(run: Run): void {
  const { view } = run;
  const places = view.relevance.locations.map((l) => ({
    lat: l.latitude,
    lng: l.longitude,
    ...(l.relevantText?.trim() ? { name: l.relevantText.trim() } : {}),
  }));
  const venue = view.roles.venueLocation;
  if (places.length === 0 && venue?.kind === 'location')
    places.push({ lat: venue.latitude, lng: venue.longitude });
  if (places.length === 0) return;
  if (run.type === 'coupon') {
    note(run, 'relevance.locations', 'locations', 'omitted', 'Samsung coupons have no locations.');
    return;
  }
  const kept: typeof places = [];
  for (const [i, place] of places.entries()) {
    const path = `locations.${i}`;
    if (isChosen(run, 'relevance.locations', path)) {
      note(run, 'relevance.locations', path, 'omitted', 'Left out by the author.');
      continue;
    }
    const named = place.name
      ? { ...place, name: shorten(place.name, { unit: 'bytes', max: 48 }).text }
      : place;
    const next = JSON.stringify([...kept, named]);
    if (kept.length >= MAX_LOCATIONS || measure(next, 'bytes') > SAMSUNG_LIMITS.locations.max) {
      note(
        run,
        'relevance.locations',
        path,
        'omitted',
        'It does not fit in the locations Samsung allows.',
      );
      continue;
    }
    kept.push(named);
  }
  if (kept.length > 0) run.attrs.locations = JSON.stringify(kept);
}

export interface Contacts {
  /** Every link the contacts carry, so a field that only repeats them is not listed again. */
  urls: Set<string>;
}

/** `csInfo`: the first phone, email and website of the support role, when each fits. */
export function setContacts(run: Run): Contacts {
  const urls = new Set<string>();
  const support = run.view.roles.support;
  if (support?.kind !== 'links') return { urls };
  if (isChosen(run, 'role.support')) {
    note(run, 'role.support', '', 'omitted', 'Left out by the author.');
    return { urls };
  }
  const first = (kind: ViewLink['kind']) => support.links.find((l) => l.kind === kind);
  const put = (
    key: 'csInfo.call' | 'csInfo.email' | 'csInfo.webSite',
    link: ViewLink | undefined,
    strip: RegExp,
  ) => {
    const value = link?.url.replace(strip, '');
    if (link && value && measure(value, 'bytes') <= SAMSUNG_LIMITS[key].max) {
      run.attrs[key] = value;
      urls.add(link.url);
    }
  };
  put('csInfo.call', first('tel'), /^tel:/iu);
  put('csInfo.email', first('mailto'), /^mailto:/iu);
  put('csInfo.webSite', first('web'), /^$/u);
  return { urls };
}

/** The org logo as the app link logo: the template `logo`, then `primaryLogo`, then `icon`. */
const orgLogo = (view: WalletPassView): string | undefined =>
  pickImage(view, 'logo', ['logo', 'primaryLogo', 'icon'])?.url;

/**
 * The required `appLink*` (Q22): the app link role, then the org logo, name and website; the
 * website falls back to the holder portal URL. Never a capability link. Missing parts block.
 */
export function setAppLink(run: Run): string | undefined {
  const { view, opts } = run;
  const app = view.roles.appLink?.kind === 'app' ? view.roles.appLink : undefined;
  const name = (app?.name ?? view.org).trim();
  const logo = app?.logo ?? orgLogo(view);
  const data = app?.url ?? opts.portalUrl;
  const missing = [!name && 'a name', !logo && 'a logo', !data && 'an address'].filter(Boolean);
  if (missing.length > 0 || !name || !logo || !data) {
    block(run, 'REQUIRED_ROLE_EMPTY', `Samsung needs an app link with ${missing.join(', ')}.`);
    return undefined;
  }
  setDisplay(run, 'appLinkName', name);
  setWhole(run, 'appLinkLogo', logo, 'IDENTITY_TOO_LONG', 'The app link logo address');
  setWhole(run, 'appLinkData', data, 'IDENTITY_TOO_LONG', 'The app link address');
  return data;
}
