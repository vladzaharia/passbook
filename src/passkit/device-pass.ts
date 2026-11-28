import { AIRLINE_URL_KEYS, EVENT_URL_KEYS } from './schema/constants.ts';
import type { PassJson } from './schema/pass-types.ts';
import { PASS_STYLES } from './types.ts';

/** The issuer a device pass shows, whatever the source pass says. */
export const DEVICE_PASS_ORGANIZATION = 'PassBook Test';
export const DEVICE_PASS_NOTICE =
  'Test pass from a developer sandbox. Not valid for entry, payment or ID.';
export const DEVICE_PASS_NOTICE_KEY = 'passbook_device_test';
export const DEVICE_PASS_PREFIX = 'Test · ';

export interface DevicePassOverrides {
  passTypeIdentifier: string;
  teamIdentifier: string;
  /** `dp_<device pass id>`. */
  serialNumber: string;
  authenticationToken: string;
  webServiceURL: string;
  /** Created + 24 h. */
  expirationDate: number;
}

/** Keys that would make something on the pass tappable or launch an app. */
const STRIPPED = [
  'appLaunchURL',
  'associatedStoreIdentifiers',
  'auxiliaryStoreIdentifiers',
  'nfc',
  'sharing',
  'businessChatIdentifier',
  'featuredActions',
  ...EVENT_URL_KEYS,
  ...AIRLINE_URL_KEYS,
] as const;
/** Per upcoming-event entry: the remote URL map and the store ids. */
const ENTRY_STRIPPED = ['URLs', 'auxiliaryStoreIdentifiers', ...EVENT_URL_KEYS] as const;
const CAPTIVE_URL = 'captiveTokenAuthURL';
const LINK_KEY = /(?:URL|Email|PhoneNumber)$/;
const prefixed = (text: string) =>
  text.startsWith(DEVICE_PASS_PREFIX) ? text : DEVICE_PASS_PREFIX + text;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const entriesOf = (pass: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(pass.upcomingPassInformation) ? pass.upcomingPassInformation.filter(isObject) : [];
const wifiOf = (holder: Record<string, unknown>): Record<string, unknown>[] =>
  isObject(holder.semantics) && Array.isArray(holder.semantics.wifiAccess)
    ? holder.semantics.wifiAccess.filter(isObject)
    : [];
const styleDicts = (pass: PassJson): Record<string, unknown>[] =>
  PASS_STYLES.map((style) => (pass as Record<string, unknown>)[style]).filter(isObject);
const fieldsOf = (dict: Record<string, unknown>): Record<string, unknown>[] =>
  Object.entries(dict).flatMap(([name, value]) =>
    name.endsWith('Fields') && Array.isArray(value) ? value.filter(isObject) : [],
  );

function sanitizeField(field: Record<string, unknown>): void {
  field.dataDetectorTypes = [];
  delete field.attributedValue;
  for (const wifi of wifiOf(field)) delete wifi[CAPTIVE_URL];
  if (typeof field.changeMessage === 'string') field.changeMessage = prefixed(field.changeMessage);
}

/**
 * The source pass.json as a device pass: PassBook Test as issuer, not shareable, 24 h to live, this device
 * pass's serial and token, nothing tappable, and a fixed notice at the head of the back. Pure: the source is
 * not changed. Barcodes, locations and beacons stay.
 */
export function applyDevicePassOverrides(
  source: PassJson,
  overrides: DevicePassOverrides,
): PassJson {
  const pass = structuredClone(source) as Record<string, unknown>;
  for (const key of STRIPPED) delete pass[key];
  for (const key of Object.keys(pass)) if (LINK_KEY.test(key)) delete pass[key];
  for (const wifi of wifiOf(pass)) delete wifi[CAPTIVE_URL];
  for (const entry of entriesOf(pass)) {
    for (const key of ENTRY_STRIPPED) delete entry[key];
    for (const wifi of wifiOf(entry)) delete wifi[CAPTIVE_URL];
    for (const field of fieldsOf(entry)) sanitizeField(field);
  }
  Object.assign(pass, {
    passTypeIdentifier: overrides.passTypeIdentifier,
    teamIdentifier: overrides.teamIdentifier,
    serialNumber: overrides.serialNumber,
    organizationName: DEVICE_PASS_ORGANIZATION,
    sharingProhibited: true,
    expirationDate: new Date(overrides.expirationDate).toISOString(),
    authenticationToken: overrides.authenticationToken,
    webServiceURL: overrides.webServiceURL,
  });
  delete pass.voided;
  const typed = pass as unknown as PassJson;
  for (const dict of styleDicts(typed)) {
    for (const field of fieldsOf(dict)) sanitizeField(field);
    const back = Array.isArray(dict.backFields) ? dict.backFields.filter(isObject) : [];
    dict.backFields = [
      {
        key: DEVICE_PASS_NOTICE_KEY,
        label: 'Test pass',
        value: DEVICE_PASS_NOTICE,
        dataDetectorTypes: [],
      },
      ...back.filter((field) => field.key !== DEVICE_PASS_NOTICE_KEY),
    ];
  }
  for (const list of [pass.locations, pass.beacons])
    if (Array.isArray(list))
      for (const item of list.filter(isObject))
        if (typeof item.relevantText === 'string') item.relevantText = prefixed(item.relevantText);
  return typed;
}

/**
 * What a device pass must hold before it is signed: the overrides took effect. Returns the broken rules
 * (empty when sound), so a change to the overrides cannot ship a pass that breaks a guard.
 */
export function devicePassViolations(pass: PassJson, overrides: DevicePassOverrides): string[] {
  const json = pass as Record<string, unknown>;
  const broken: string[] = [];
  if (json.organizationName !== DEVICE_PASS_ORGANIZATION) broken.push('organizationName');
  if (json.sharingProhibited !== true) broken.push('sharingProhibited');
  if (json.expirationDate !== new Date(overrides.expirationDate).toISOString())
    broken.push('expirationDate');
  if (json.serialNumber !== overrides.serialNumber || !overrides.serialNumber.startsWith('dp_'))
    broken.push('serialNumber');
  if (json.passTypeIdentifier !== overrides.passTypeIdentifier) broken.push('passTypeIdentifier');
  if (json.teamIdentifier !== overrides.teamIdentifier) broken.push('teamIdentifier');
  if (json.webServiceURL !== overrides.webServiceURL) broken.push('webServiceURL');
  if (json.authenticationToken !== overrides.authenticationToken)
    broken.push('authenticationToken');
  for (const key of STRIPPED) if (key in json) broken.push(key);
  for (const key of Object.keys(json))
    if (LINK_KEY.test(key) && key !== 'webServiceURL') broken.push(key);
  if (wifiOf(json).some((wifi) => CAPTIVE_URL in wifi)) broken.push(CAPTIVE_URL);
  for (const entry of entriesOf(json)) {
    for (const key of ENTRY_STRIPPED)
      if (key in entry) broken.push(`upcomingPassInformation.${key}`);
    if (wifiOf(entry).some((wifi) => CAPTIVE_URL in wifi)) broken.push(CAPTIVE_URL);
    broken.push(...fieldViolations(entry));
  }
  const dicts = styleDicts(pass);
  if (dicts.length === 0) broken.push('style');
  for (const dict of dicts) {
    const back = Array.isArray(dict.backFields) ? dict.backFields : [];
    const first = back[0];
    if (
      !isObject(first) ||
      first.key !== DEVICE_PASS_NOTICE_KEY ||
      first.value !== DEVICE_PASS_NOTICE
    )
      broken.push('backFields');
    broken.push(...fieldViolations(dict));
  }
  return [...new Set(broken)];
}

function fieldViolations(dict: Record<string, unknown>): string[] {
  const broken: string[] = [];
  for (const field of fieldsOf(dict)) {
    const detectors = field.dataDetectorTypes;
    if (!Array.isArray(detectors) || detectors.length !== 0) broken.push('dataDetectorTypes');
    if ('attributedValue' in field) broken.push('attributedValue');
    if (wifiOf(field).some((wifi) => CAPTIVE_URL in wifi)) broken.push(CAPTIVE_URL);
    if (
      typeof field.changeMessage === 'string' &&
      !field.changeMessage.startsWith(DEVICE_PASS_PREFIX)
    )
      broken.push('changeMessage');
  }
  return broken;
}
