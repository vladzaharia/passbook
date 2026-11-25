import { xor } from '../bytes.ts';
import { crc32Nk } from '../crc32.ts';
import type { Ev2Session } from '../ev2.ts';
import { openCommand, sealResponse, unpad } from './secure.ts';
import { encodeSettings, parseSettings } from './settings.ts';
import { FILE_SIZE, type SimTag, status } from './state.ts';

const AUTH_ERROR = 0x91ae;
const INTEGRITY = 0x911e;
const NO_PERMISSION = 0x919d;
const NO_FILE = 0x91f0;
const EMPTY = new Uint8Array(0);

const seal = async (s: Ev2Session, data: Uint8Array = EMPTY) => sealResponse(s, data);

/**
 * The native commands in secure messaging: GetFileSettings and GetKeyVersion (MAC), ChangeFileSettings,
 * WriteData and ChangeKey (Full). Each is applied whole or not at all.
 */
export async function secureCommand(
  tag: SimTag,
  ins: number,
  body: Uint8Array,
): Promise<Uint8Array> {
  const s = tag.session;
  if (!s) return status(AUTH_ERROR);
  const macOnly = ins === 0xf5 || ins === 0x64;
  const opened = await openCommand(s, ins, body, ins === 0x8d ? 7 : 1, !macOnly);
  if (!opened.ok) {
    if (opened.drop) tag.session = null;
    return status(opened.sw);
  }
  const { header, data } = opened;
  const no = header[0] as number;
  if (ins === 0xf5) return no === 2 ? seal(s, encodeSettings(tag.ndef)) : status(NO_FILE);
  if (ins === 0x64)
    return no > 4 ? status(0x9140) : seal(s, new Uint8Array([tag.versions[no] as number]));
  const plain = unpad(data);
  if (!plain) return status(INTEGRITY);
  if (ins === 0x5f) return changeFileSettings(tag, s, no, plain);
  if (ins === 0x8d) return writeData(tag, s, header, plain);
  return changeKey(tag, s, no, plain);
}

async function changeFileSettings(tag: SimTag, s: Ev2Session, file: number, data: Uint8Array) {
  if (file !== 2) return status(NO_FILE);
  if (tag.ndef.change !== s.keyNo) return status(NO_PERMISSION);
  const parsed = parseSettings(data);
  if (typeof parsed === 'number') return status(parsed);
  Object.assign(tag.ndef, parsed);
  return seal(s);
}

async function writeData(tag: SimTag, s: Ev2Session, header: Uint8Array, data: Uint8Array) {
  const file = header[0] as number;
  const offset =
    (header[1] as number) | ((header[2] as number) << 8) | ((header[3] as number) << 16);
  const length =
    (header[4] as number) | ((header[5] as number) << 8) | ((header[6] as number) << 16);
  if (data.length !== length) return status(0x917e);
  const target = file === 2 ? tag.ndef.data : tag.other.get(file);
  if (!target) return status(NO_FILE);
  const n = tag.ndef;
  const allowed =
    file === 2 ? [n.write, n.rw].includes(0xe) || [n.write, n.rw].includes(s.keyNo) : s.keyNo === 0;
  if (!allowed) return status(NO_PERMISSION);
  if (offset + length > (file === 2 ? FILE_SIZE : target.length)) return status(0x91be);
  target.set(data, offset);
  return seal(s);
}

async function changeKey(tag: SimTag, s: Ev2Session, keyNo: number, data: Uint8Array) {
  if (keyNo > 4) return status(0x9140);
  if (s.keyNo !== 0) return status(NO_PERMISSION);
  const own = keyNo === s.keyNo;
  if (data.length !== (own ? 17 : 21)) return status(0x917e);
  let next: Uint8Array = data.slice(0, 16);
  if (!own) {
    next = xor(next, tag.keys[keyNo] as Uint8Array);
    const crc = crc32Nk(next);
    if (!crc.every((v, i) => v === data[17 + i])) return status(INTEGRITY);
  }
  tag.keys[keyNo] = next;
  tag.versions[keyNo] = data[16] as number;
  if (!own) return seal(s);
  tag.session = null;
  return status(0x9100);
}
