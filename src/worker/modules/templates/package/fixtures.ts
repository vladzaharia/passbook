import { zipSync, zlibSync } from 'fflate';
import { crc32 } from './hash.ts';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** A valid RGBA PNG of the given pixel size. Test fixture only. */
export function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) rows[y * (1 + width * 4)] = 0;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(rows)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const encoder = new TextEncoder();

export function passJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    passTypeIdentifier: 'pass.example.template',
    teamIdentifier: 'TEAM000000',
    serialNumber: 'template',
    organizationName: 'Template',
    description: 'Template pass',
    generic: { primaryFields: [{ key: 'name', label: 'Name', value: 'Alex Morgan' }] },
    ...overrides,
  };
}

/** Smallest valid package: pass.json plus icon at @1x and @2x. */
export function basicPackage(
  extra: Record<string, Uint8Array | string | null> = {},
  pass: Record<string, unknown> = passJson(),
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ['pass.json', encoder.encode(JSON.stringify(pass))],
    ['icon.png', makePng(38, 38)],
    ['icon@2x.png', makePng(76, 76)],
  ]);
  for (const [name, value] of Object.entries(extra)) {
    if (value === null) files.delete(name);
    else files.set(name, typeof value === 'string' ? encoder.encode(value) : value);
  }
  return files;
}

export function zipOf(
  files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): Uint8Array {
  const entries = files instanceof Map ? [...files] : Object.entries(files);
  return zipSync(Object.fromEntries(entries.map(([k, v]) => [k, [v, { level: 6 }]])));
}
