import type { Ev2Session } from '../ev2.ts';

/** The tag went out of the field: the command may or may not have been applied, and its answer is lost. */
export class TagLostError extends Error {
  constructor() {
    super('tag lost');
    this.name = 'TagLostError';
  }
}

export interface SdmState {
  options: number;
  metaKey: number;
  fileKey: number;
  ctrKey: number;
  piccOffset: number;
  macInputOffset: number;
  macOffset: number;
}

export interface NdefFile {
  data: Uint8Array;
  /** FileOption: 0x40 bit is SDM; low two bits are the comm mode. */
  option: number;
  /** Key numbers (0..4, 0xE free, 0xF never) for read/write, read, write, change. */
  rw: number;
  change: number;
  read: number;
  write: number;
  sdm: SdmState | null;
}

/** Where a multi-frame answer continues on the next `90 AF`. */
export type Chain = 'version1' | 'version2' | 'auth';

export interface SimTag {
  uid: Uint8Array;
  keys: Uint8Array[];
  versions: number[];
  ndef: NdefFile;
  /** File 01 (E103) and 03 (E105), written but never interpreted. */
  other: Map<number, Uint8Array>;
  readCounter: number;
  selectedApp: boolean;
  selectedFile: number | null;
  chain: Chain | null;
  pending: { keyNo: number; rndB: Uint8Array } | null;
  session: Ev2Session | null;
}

export const FILE_SIZE = 256;

export function blankTag(uid: Uint8Array): SimTag {
  return {
    uid,
    keys: Array.from({ length: 5 }, () => new Uint8Array(16)),
    versions: [0, 0, 0, 0, 0],
    ndef: {
      data: new Uint8Array(FILE_SIZE),
      option: 0x00,
      rw: 0xe,
      change: 0x0,
      read: 0xe,
      write: 0xe,
      sdm: null,
    },
    other: new Map([
      [1, new Uint8Array(32)],
      [3, new Uint8Array(128)],
    ]),
    readCounter: 0,
    selectedApp: false,
    selectedFile: null,
    chain: null,
    pending: null,
    session: null,
  };
}

export const status = (sw: number, data: Uint8Array = new Uint8Array(0)): Uint8Array => {
  const out = new Uint8Array(data.length + 2);
  out.set(data);
  out[data.length] = sw >> 8;
  out[data.length + 1] = sw & 0xff;
  return out;
};
