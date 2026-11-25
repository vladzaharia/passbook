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
  /** Files 01 (E103), 02 (E104, the NDEF file) and 03 (E105), by number. */
  files: Map<number, NdefFile>;
  readCounter: number;
  selectedApp: boolean;
  selectedFile: number | null;
  chain: Chain | null;
  pending: { keyNo: number; rndB: Uint8Array; nonFirst: boolean } | null;
  session: Ev2Session | null;
}

export const FILE_SIZE = 256;

/** A file as it leaves the factory (datasheet Tables 8 and 13): rights RW, Change, Read, Write. */
const file = (
  size: number,
  option: number,
  rw: number,
  change: number,
  read: number,
  write: number,
): NdefFile => ({
  data: new Uint8Array(size),
  option,
  rw,
  change,
  read,
  write,
  sdm: null,
});

export function blankTag(uid: Uint8Array): SimTag {
  return {
    uid,
    keys: Array.from({ length: 5 }, () => new Uint8Array(16)),
    versions: [0, 0, 0, 0, 0],
    files: new Map([
      [1, file(32, 0x00, 0x0, 0x0, 0xe, 0x0)],
      [2, file(FILE_SIZE, 0x00, 0xe, 0x0, 0xe, 0xe)],
      [3, file(128, 0x03, 0x3, 0x0, 0x2, 0x3)],
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
