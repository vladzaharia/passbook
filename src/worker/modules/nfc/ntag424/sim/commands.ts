import { xor } from '../bytes.ts';
import { crc32Nk } from '../crc32.ts';
import type { Ev2Session } from '../ev2.ts';
import { openCommand, sealResponse, unpad } from './secure.ts';
import { encodeSettings, parseSettings } from './settings.ts';
import { type NdefFile, type SimTag, status } from './state.ts';

const AUTH_ERROR = 0x91ae;
const INTEGRITY = 0x911e;
const LENGTH = 0x917e;
const NO_PERMISSION = 0x919d;
const NO_FILE = 0x91f0;
const FREE = 0xe;
const EMPTY = new Uint8Array(0);

type Mode = 'plain' | 'mac' | 'full';
const MODES: Mode[] = ['plain', 'mac', 'plain', 'full'];

/** A file's CommMode: FileOption bits 1..0 (X0 plain, 01 MAC, 11 full). */
const modeOf = (f: NdefFile): Mode => MODES[f.option & 3] as Mode;

const holds = (s: Ev2Session | null, ...rights: number[]) => s !== null && rights.includes(s.keyNo);

/**
 * What the datasheet says of a command, decided by the tag and not by the sender: the communication mode comes
 * from the command (Table 22) or the file, and drops to Plain where the only access that applies is free.
 * Whatever does not parse in that mode fails, and any failure ends the authenticated state (done by the caller).
 */
export async function secureCommand(
  tag: SimTag,
  ins: number,
  body: Uint8Array,
): Promise<Uint8Array> {
  const s = tag.session;
  const headerLength = ins === 0x8d ? 7 : 1;
  if (body.length < headerLength) return status(LENGTH);
  const no = body[0] as number;
  const file = tag.files.get(no);
  let mode: Mode;
  if (ins === 0xf5) {
    if (!file) return status(NO_FILE);
    mode = s ? 'mac' : 'plain';
  } else if (ins === 0x64) {
    if (!s) return status(AUTH_ERROR);
    mode = 'mac';
  } else if (ins === 0x5f) {
    if (!file) return status(NO_FILE);
    if (file.change !== FREE && !holds(s, file.change))
      return status(s ? NO_PERMISSION : AUTH_ERROR);
    mode = file.change === FREE ? 'plain' : 'full';
  } else if (ins === 0x8d) {
    if (!file) return status(NO_FILE);
    const free = file.write === FREE || file.rw === FREE;
    if (!free && !holds(s, file.write, file.rw)) return status(s ? NO_PERMISSION : AUTH_ERROR);
    mode = free ? 'plain' : modeOf(file);
  } else {
    if (!s) return status(AUTH_ERROR);
    mode = 'full';
  }

  // Plain commands are not protected, but an authenticated tag still counts them.
  let header: Uint8Array;
  let data: Uint8Array;
  if (mode === 'plain' || !s) {
    header = body.slice(0, headerLength);
    data = body.slice(headerLength);
    if (s) s.ctr += 1;
  } else {
    const opened = await openCommand(s, ins, body, headerLength, mode === 'full');
    if (!opened.ok) return status(opened.sw);
    ({ header, data } = opened);
    if (mode === 'full') {
      const plain = unpad(data);
      if (!plain) return status(INTEGRITY);
      data = plain;
    }
  }
  const reply = (out: Uint8Array = EMPTY) =>
    s && mode !== 'plain' ? sealResponse(s, out) : status(0x9100, out);

  if (ins === 0xf5) return reply(encodeSettings(file as NdefFile));
  if (ins === 0x64)
    return no > 4 ? status(0x9140) : reply(new Uint8Array([tag.versions[no] as number]));
  if (ins === 0x5f) {
    const parsed = parseSettings(data);
    if (typeof parsed === 'number') return status(parsed);
    Object.assign(file as NdefFile, parsed);
    return reply();
  }
  if (ins === 0x8d) return writeData(file as NdefFile, header, data, reply);
  return changeKey(tag, s as Ev2Session, no, data, reply);
}

function writeData(
  file: NdefFile,
  header: Uint8Array,
  data: Uint8Array,
  reply: () => Promise<Uint8Array> | Uint8Array,
) {
  const offset =
    (header[1] as number) | ((header[2] as number) << 8) | ((header[3] as number) << 16);
  const length =
    (header[4] as number) | ((header[5] as number) << 8) | ((header[6] as number) << 16);
  if (data.length !== length) return status(LENGTH);
  if (offset + length > file.data.length) return status(0x91be);
  file.data.set(data, offset);
  return reply();
}

async function changeKey(
  tag: SimTag,
  s: Ev2Session,
  keyNo: number,
  data: Uint8Array,
  reply: () => Promise<Uint8Array> | Uint8Array,
) {
  if (keyNo > 4) return status(0x9140);
  if (s.keyNo !== 0) return status(NO_PERMISSION);
  const own = keyNo === s.keyNo;
  if (data.length !== (own ? 17 : 21)) return status(LENGTH);
  let next: Uint8Array = data.slice(0, 16);
  if (!own) {
    next = xor(next, tag.keys[keyNo] as Uint8Array);
    const crc = crc32Nk(next);
    if (!crc.every((v, i) => v === data[17 + i])) return status(INTEGRITY);
  }
  tag.keys[keyNo] = next;
  tag.versions[keyNo] = data[16] as number;
  if (!own) return reply();
  tag.session = null;
  return status(0x9100);
}
