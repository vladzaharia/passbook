import { mirroredRead } from './sdm.ts';
import { type NdefFile, type SimTag, status } from './state.ts';

const AID = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01];
const FILE_OF: Record<number, number> = { 57603: 1, 57604: 2, 57605: 3 };

/** ISO 7816 commands: SELECT by DF name or file id, ReadBinary and UpdateBinary on the selected file. */
export async function isoCommand(
  tag: SimTag,
  ins: number,
  p1: number,
  p2: number,
  apdu: Uint8Array,
  random: (n: number) => Uint8Array,
): Promise<Uint8Array> {
  if (ins === 0xa4) {
    const data = apdu.slice(5, 5 + (apdu[4] as number));
    if (p1 === 0x04) {
      if (data.length !== AID.length || !AID.every((v, i) => v === data[i])) return status(0x6a82);
      tag.selectedApp = true;
      tag.selectedFile = null;
      return status(0x9000);
    }
    const file = FILE_OF[((data[0] as number) << 8) | (data[1] as number)];
    if (!tag.selectedApp || !file) return status(0x6a82);
    tag.selectedFile = file;
    return status(0x9000);
  }
  const file = tag.selectedFile;
  if (!tag.selectedApp || file === null) return status(0x6985);
  const offset = ((p1 & 0x7f) << 8) | p2;
  const ndef = tag.files.get(file) as NdefFile;
  if (ins === 0xb0) {
    const free = ndef.read === 0xe || ndef.rw === 0xe;
    if (!free && !([ndef.read, ndef.rw] as number[]).includes(tag.session?.keyNo ?? -1))
      return status(0x6982);
    const content = await mirroredRead(tag, ndef, random);
    const le = (apdu[apdu.length - 1] as number) || 256;
    return status(0x9000, content.slice(offset, Math.min(offset + le, ndef.data.length)));
  }
  if (ins === 0xd6) {
    if (![ndef.write, ndef.rw].includes(0xe) || ndef.option & 3) return status(0x6982);
    const data = apdu.slice(5, 5 + (apdu[4] as number));
    if (offset + data.length > ndef.data.length) return status(0x6700);
    ndef.data.set(data, offset);
    return status(0x9000);
  }
  return status(0x6d00);
}
