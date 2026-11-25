import { FILE_SIZE, type NdefFile, type SdmState } from './state.ts';

const at24 = (d: Uint8Array, i: number) =>
  (d[i] as number) | ((d[i + 1] as number) << 8) | ((d[i + 2] as number) << 16);

const u24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

type Parsed = Pick<NdefFile, 'option' | 'rw' | 'change' | 'read' | 'write' | 'sdm'>;

/** The ChangeFileSettings payload for file 02, or the status word the tag answers with. */
export function parseSettings(d: Uint8Array): Parsed | number {
  if (d.length < 3) return 0x917e;
  const base = {
    option: d[0] as number,
    rw: (d[1] as number) >> 4,
    change: (d[1] as number) & 0xf,
    read: (d[2] as number) >> 4,
    write: (d[2] as number) & 0xf,
  };
  const valid = (k: number) => k <= 4 || k === 0xe || k === 0xf;
  if (![base.rw, base.change, base.read, base.write].every(valid)) return 0x919e;
  if (!(base.option & 0x40)) return d.length === 3 ? { ...base, sdm: null } : 0x917e;
  if (d.length < 6) return 0x917e;
  const options = d[3] as number;
  const ctrKey = (d[4] as number) & 0xf;
  const metaKey = (d[5] as number) >> 4;
  const fileKey = (d[5] as number) & 0xf;
  if (![ctrKey, metaKey, fileKey].every(valid)) return 0x919e;
  // Datasheet Table 71 parameter rules.
  const uid = (options & 0x80) !== 0;
  const ctr = (options & 0x40) !== 0;
  if (!uid && !ctr && metaKey !== 0xf) return 0x919e;
  if (metaKey === 0xf && uid) return 0x919e;
  if (ctrKey !== 0xf && !ctr) return 0x919e;
  // Beyond that, only the shape this platform writes: encrypted PICCData, a MAC, no file data mirror, no limit.
  if (metaKey > 4 || fileKey > 4 || options & 0x30) return 0x911c;
  if (d.length !== 15) return 0x917e;
  const sdm: SdmState = {
    options,
    metaKey,
    fileKey,
    ctrKey,
    piccOffset: at24(d, 6),
    macInputOffset: at24(d, 9),
    macOffset: at24(d, 12),
  };
  if (sdm.piccOffset + 32 > FILE_SIZE || sdm.macOffset + 16 > FILE_SIZE) return 0x919e;
  if (sdm.macInputOffset > sdm.macOffset) return 0x919e;
  // SDMMAC and PICCData must not overlap.
  if (!(sdm.macOffset >= sdm.piccOffset + 32 || sdm.piccOffset >= sdm.macOffset + 16))
    return 0x919e;
  return { ...base, sdm };
}

export function encodeSettings(f: NdefFile): Uint8Array {
  const head = [0x00, f.option, (f.rw << 4) | f.change, (f.read << 4) | f.write, 0x00, 0x01, 0x00];
  const s = f.sdm;
  if (!s) return new Uint8Array(head);
  return new Uint8Array([
    ...head,
    s.options,
    0xf0 | s.ctrKey,
    (s.metaKey << 4) | s.fileKey,
    ...u24(s.piccOffset),
    ...u24(s.macInputOffset),
    ...u24(s.macOffset),
  ]);
}
