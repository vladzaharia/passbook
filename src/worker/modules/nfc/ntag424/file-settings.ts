import { INS } from './apdu.ts';
import { concat, u24 } from './bytes.ts';
import type { Ev2Session } from './ev2.ts';
import { fullCommand, plainCommand } from './secure-messaging.ts';

export const PLAIN_WRITE_MAX = 248;

/**
 * SDM on file 02, as the verifier reads it (`sun.ts`): FileOption 40 (SDM, CommMode plain, so the read is free),
 * access rights 00 E0 (RW 0, Change 0, Read E, Write 0: byte 0 is RW then Change, byte 1 is Read then Write),
 * SDMOptions C1 (UID, counter, ASCII), SDMAccessRights FF 12 (byte 0 is RFU F then SDMCtrRet F, byte 1 is
 * SDMMetaRead then SDMFileRead), then PICCDataOffset, SDMMACInputOffset and SDMMACOffset (the MAC is over empty
 * input, so the last two are equal).
 */
export function sdmFileSettings(
  offsets: { piccOffset: number; macOffset: number },
  keys: { meta: number; file: number; ctr?: number } = { meta: 1, file: 2 },
): Uint8Array {
  return concat(
    new Uint8Array([
      0x40,
      0x00,
      0xe0,
      0xc1,
      0xf0 | (keys.ctr ?? 0xf),
      (keys.meta << 4) | keys.file,
    ]),
    u24(offsets.piccOffset),
    u24(offsets.macOffset),
    u24(offsets.macOffset),
  );
}

/** File 02 as it leaves the factory, with SDM off and free read and write: FileOption 00, rights E0 EE. */
export const FACTORY_NDEF_SETTINGS = new Uint8Array([0x00, 0xe0, 0xee]);

export const changeFileSettings = (s: Ev2Session, fileNo: number, data: Uint8Array) =>
  fullCommand(s, INS.changeFileSettings, new Uint8Array([fileNo]), data);

/**
 * One-frame WriteData, header `file || offset || length` (3-byte little endian each). The mode is the file's:
 * file 02 is CommMode.Plain (248 data bytes a frame; the answer is a bare 9100), file 03 is Full (239).
 */
export async function writeData(
  s: Ev2Session,
  fileNo: number,
  offset: number,
  data: Uint8Array,
  mode: 'plain' | 'full' = 'plain',
) {
  if (data.length > (mode === 'plain' ? PLAIN_WRITE_MAX : 239))
    throw new RangeError('one WriteData frame is too long');
  const header = concat(new Uint8Array([fileNo]), u24(offset), u24(data.length));
  return mode === 'plain'
    ? plainCommand(s, INS.writeData, header, data)
    : fullCommand(s, INS.writeData, header, data);
}
