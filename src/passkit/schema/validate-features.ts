import {
  FEATURED_ACTION_TYPES,
  MAX_FEATURED_ACTIONS,
  MAX_NFC_MESSAGE_BYTES,
  SHARING_METHODS,
} from './constants.ts';
import { hasStyle, isObject, parseUrl, utf8Length, type ValidationContext } from './util.ts';

const ACTION_TYPES: readonly string[] = FEATURED_ACTION_TYPES;
const PLACE_ID = /^I[0-9A-Fa-f]{1,16}$/;
// SubjectPublicKeyInfo prefix for an uncompressed P-256 point (91 bytes in total).
const P256_SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function validateFeaturedActions(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  const actions = pass.featuredActions;
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    error('FEATURED_ACTIONS', 'featuredActions must be an array.', 'featuredActions');
    return;
  }
  if (actions.length > MAX_FEATURED_ACTIONS)
    error('FEATURED_ACTIONS', 'Wallet supports at most two featured actions.', 'featuredActions');
  if (hasStyle(ctx, 'PET', 'SBP'))
    warn(
      'FEATURED_ACTIONS_STYLE',
      'Poster event tickets and semantic boarding passes do not show featured actions.',
      'featuredActions',
    );
  const ids = new Set<string>();
  actions.forEach((action: unknown, i) => {
    const path = `featuredActions.${i}`;
    if (!isObject(action)) {
      error('FEATURED_ACTIONS', 'Featured action must be an object.', path);
      return;
    }
    for (const key of Object.keys(action))
      if (!['identifier', 'type', 'url', 'placeIdentifier', '_id'].includes(key))
        warn('UNKNOWN_KEY', `Unknown key ${key}.`, `${path}.${key}`);
    if (
      typeof action.identifier !== 'string' ||
      action.identifier === '' ||
      ids.has(action.identifier)
    )
      error('FEATURED_ACTIONS', 'Featured actions need unique identifiers.', `${path}.identifier`);
    else ids.add(action.identifier);
    if (typeof action.type !== 'string' || action.type === '') {
      error('FEATURED_ACTIONS', 'Featured actions need a type.', `${path}.type`);
      return;
    }
    if (!ACTION_TYPES.includes(action.type))
      warn('FEATURED_ACTION_TYPE', `Unknown featured action type ${action.type}.`, `${path}.type`);
    if (action.type === 'place') {
      // A place action with a url is shown as broken on iOS 27.
      if (typeof action.placeIdentifier !== 'string' || !PLACE_ID.test(action.placeIdentifier))
        error(
          'FEATURED_ACTIONS',
          'Place actions need an Apple Maps place identifier.',
          `${path}.placeIdentifier`,
        );
      if (action.url !== undefined)
        error('FEATURED_ACTIONS', 'Place actions use placeIdentifier, not url.', `${path}.url`);
      return;
    }
    const url = parseUrl(action.url);
    const allowed = action.type === 'call' ? ['tel:'] : ['https:', 'tel:'];
    if (
      !url ||
      !allowed.includes(url.protocol) ||
      (url.protocol === 'https:' && url.hostname === '')
    )
      error(
        'FEATURED_ACTIONS',
        action.type === 'call'
          ? 'Call actions need a tel: URL.'
          : 'Featured actions need an https or tel URL.',
        `${path}.url`,
      );
    if (action.placeIdentifier !== undefined)
      warn(
        'FEATURED_ACTIONS',
        'placeIdentifier applies to place actions only.',
        `${path}.placeIdentifier`,
      );
  });
}

export function validateNfc(ctx: ValidationContext): void {
  const { pass, identity, error, warn } = ctx;
  const nfc = pass.nfc;
  if (nfc === undefined) {
    if (hasStyle(ctx, 'PET'))
      warn(
        'PET_NFC',
        'Poster layout needs nfc before iOS 27. Without it iOS 18-26 shows the classic event ticket.',
        'nfc',
      );
    return;
  }
  if (!identity.nfcEnabled)
    error('NFC_NOT_ENTITLED', 'The signing identity is not NFC-enabled.', 'nfc');
  if (!isObject(nfc)) {
    error('NFC', 'nfc must be an object.', 'nfc');
    return;
  }
  for (const key of Object.keys(nfc))
    if (!['message', 'encryptionPublicKey', 'requiresAuthentication', '_id'].includes(key))
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `nfc.${key}`);
  if (typeof nfc.message !== 'string' || nfc.message === '')
    error('NFC', 'nfc.message is required.', 'nfc.message');
  else if (utf8Length(nfc.message) > MAX_NFC_MESSAGE_BYTES)
    error('NFC', 'nfc.message is limited to 64 bytes.', 'nfc.message');
  const key =
    typeof nfc.encryptionPublicKey === 'string' ? decodeBase64(nfc.encryptionPublicKey) : undefined;
  if (key?.length !== 91 || !toHex(key).startsWith(P256_SPKI_PREFIX))
    error(
      'NFC',
      'nfc.encryptionPublicKey must be a base64 P-256 SubjectPublicKeyInfo.',
      'nfc.encryptionPublicKey',
    );
  if (nfc.requiresAuthentication !== undefined && typeof nfc.requiresAuthentication !== 'boolean')
    error('NFC', 'nfc.requiresAuthentication must be a boolean.', 'nfc.requiresAuthentication');
  if (nfc.requiresAuthentication === true && pass.sharingProhibited !== true)
    error(
      'NFC',
      'Set sharingProhibited with requiresAuthentication.',
      'nfc.requiresAuthentication',
    );
  if (hasStyle(ctx, 'PET') && nfc.requiresAuthentication === undefined)
    warn(
      'NFC',
      'Poster event tickets expect nfc.requiresAuthentication.',
      'nfc.requiresAuthentication',
    );
}

export function validateSharing(ctx: ValidationContext): void {
  const { pass, error, warn } = ctx;
  const sharing = pass.sharing;
  if (sharing === undefined) return;
  if (!isObject(sharing)) {
    error('SHARING', 'sharing must be an object.', 'sharing');
    return;
  }
  for (const key of Object.keys(sharing))
    if (!['method', 'url', 'text'].includes(key))
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, `sharing.${key}`);
  const method = sharing.method ?? 'PKPassSharingMethodPass';
  if (typeof method !== 'string' || !(SHARING_METHODS as readonly string[]).includes(method))
    error('SHARING', 'Unknown sharing method.', 'sharing.method');
  if (method === 'PKPassSharingMethodURL' && !parseUrl(sharing.url))
    error('SHARING', 'sharing.url is required for the URL method.', 'sharing.url');
  if (sharing.text !== undefined && typeof sharing.text !== 'string')
    error('SHARING', 'sharing.text must be a string.', 'sharing.text');
  if (pass.sharingProhibited === true)
    warn('SHARING', 'sharing is ignored when sharingProhibited is set.', 'sharing');
}
