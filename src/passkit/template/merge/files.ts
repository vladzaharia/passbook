import type { Json } from '../../types.ts';
import { STAMP_STRIP } from '../package.ts';
import { decide, isObj, leaf, mapOf, part, type Rule, type V } from './map.ts';
import { sha1Hex } from './sha1.ts';
import { readStrings, writeStrings } from './strings.ts';
import type { Cx, PackageDoc, PartId } from './types.ts';

type Files = PackageDoc['files'];
type Entry = Files[string];

const IMAGE = /^((?:[\w-]+\.lproj\/)?)([A-Za-z]+)(?:@([23])x)?\.png$/;
const STRINGS = /^[\w-]+\.lproj\/pass\.strings$/;
const NEVER = new Set(['pass.json', 'wallet.template.json', 'tooling.json']);

/** Files the engine ignores: generated strips and package tooling. Applied to every side. */
export const isGenerated = (name: string) => NEVER.has(name) || STAMP_STRIP.test(name);

type Kind = 'image' | 'stampArt' | 'walletArt' | 'other';
function kindOf(name: string): Kind {
  if (name.startsWith('wallets/')) return 'walletArt';
  if (name.startsWith('stamps/')) return 'stampArt';
  return IMAGE.test(name) ? 'image' : 'other';
}

/** `slot[.locale]` units cover @1x/@2x/@3x, so scales are never mixed across sides. */
function imageUnits(files: Files | undefined): Record<string, Json> | undefined {
  if (!files) return undefined;
  const out: Record<string, Record<string, Json>> = {};
  for (const [name, e] of Object.entries(files)) {
    const m = kindOf(name) === 'image' ? IMAGE.exec(name) : null;
    if (!m) continue;
    const unit = `${m[1]}${m[2]}`;
    out[unit] = { ...out[unit], [m[3] ?? '1']: e.sha1 };
  }
  return out;
}

const refs = (files: Files | undefined, kind: Kind, skip?: (n: string) => boolean) =>
  files &&
  Object.fromEntries(
    Object.entries(files)
      .filter(([n]) => kindOf(n) === kind && !skip?.(n))
      .map(([name, e]) => [name, { name, sha1: e.sha1 }]),
  );

const bytesJson = (bytes: Uint8Array): Record<string, Json> => {
  const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isObj(v as Json)) throw new Error('not an object');
  return v as Record<string, Json>;
};

/**
 * A file whose bytes can merge by key (`*.strings`, `personalization.json`). One side changed:
 * keep its bytes verbatim. Both changed: merge by key and write the result.
 */
function mergeBytes(
  cx: Cx,
  name: string,
  id: PartId,
  [b, o, t]: [Entry?, Entry?, Entry?],
  read: (bytes: Uint8Array) => Record<string, Json>,
  write: (v: Record<string, Json>) => Uint8Array,
): Entry | undefined {
  const ref = (e?: Entry): V => e && { name, sha1: e.sha1 };
  const atomic = (rule: Rule) => {
    const v = part(id, rule)(cx, [name], ref(b), ref(o), ref(t)) as { sha1: string } | undefined;
    return v && (v.sha1 === o?.sha1 ? o : v.sha1 === t?.sha1 ? t : { sha1: v.sha1 });
  };
  const decided =
    o?.sha1 === t?.sha1 || (!cx.twoWay && (b?.sha1 === o?.sha1 || b?.sha1 === t?.sha1));
  if (decided || !o?.bytes || !t?.bytes || (!cx.twoWay && !b?.bytes)) return atomic(leaf);
  let sides: [Record<string, Json> | undefined, Record<string, Json>, Record<string, Json>];
  try {
    sides = [b?.bytes && !cx.twoWay ? read(b.bytes) : undefined, read(o.bytes), read(t.bytes)];
  } catch {
    // Only parsing is in the try: a file that does not parse is invalid until a side is picked.
    return atomic((c, p, ...v) => decide(c, p, 'invalid', ...v));
  }
  const merged = part(id, mapOf())(cx, [name], ...sides);
  const bytes = write(merged as Record<string, Json>);
  return { sha1: sha1Hex(bytes), bytes };
}

const writeJson = (v: Record<string, Json>) =>
  new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);

export function mergeFiles(cx: Cx, b: Files | undefined, o: Files, t: Files): Files {
  const out: Files = {};
  const from = (name: string, sha1: string): Entry => {
    for (const f of [o, t, b]) if (f?.[name]?.sha1 === sha1) return f[name] as Entry;
    return { sha1 };
  };
  const units = part('files.image', mapOf({}, leaf))(
    cx,
    [],
    imageUnits(b),
    imageUnits(o),
    imageUnits(t),
  );
  for (const [unit, scales] of Object.entries(
    (units as Record<string, Record<string, string>>) ?? {},
  )) {
    for (const [scale, sha1] of Object.entries(scales)) {
      const name = `${unit}${scale === '1' ? '' : `@${scale}x`}.png`;
      out[name] = from(name, sha1);
    }
  }
  const plain = (kind: Kind, id: PartId, skip?: (n: string) => boolean) => {
    const merged = part(id, mapOf({}, leaf))(
      cx,
      [],
      refs(b, kind, skip),
      refs(o, kind, skip),
      refs(t, kind, skip),
    );
    for (const [name, r] of Object.entries((merged ?? {}) as Record<string, { sha1: string }>))
      out[name] = from(name, r.sha1);
  };
  plain('stampArt', 'files.stampArt');
  plain('walletArt', 'files.walletArt');
  const special = (n: string) => STRINGS.test(n) || n === 'personalization.json';
  plain('other', 'files.other', special);
  const names = new Set(
    [...Object.keys(o), ...Object.keys(t), ...Object.keys(b ?? {})].filter(special),
  );
  for (const name of names) {
    const strings = STRINGS.test(name);
    const e = mergeBytes(
      cx,
      name,
      strings ? 'strings' : 'files.other',
      [b?.[name], o[name], t[name]],
      strings ? readStrings : bytesJson,
      strings ? writeStrings : writeJson,
    );
    if (e) out[name] = e;
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}
