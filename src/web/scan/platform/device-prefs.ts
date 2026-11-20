/** The handheld's own settings, kept on the device: sunlight mode and the left-hand dock. */
const KEYS = { sunlight: 'passbook-scan-sunlight', leftHand: 'passbook-scan-left-hand' } as const;

export type DevicePref = keyof typeof KEYS;

export function loadDevicePrefs(
  store: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): Record<DevicePref, boolean> {
  const read = (key: DevicePref): boolean => {
    try {
      return store?.getItem(KEYS[key]) === '1';
    } catch {
      return false;
    }
  };
  return { sunlight: read('sunlight'), leftHand: read('leftHand') };
}

/** Remembers one choice; an unavailable store keeps it for this visit only. */
export function saveDevicePref(
  key: DevicePref,
  value: boolean,
  store: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  try {
    store?.setItem(KEYS[key], value ? '1' : '0');
  } catch {
    // Unsaved: the choice holds until the page closes.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
