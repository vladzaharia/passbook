import { type Any, edit, sha, stringsFile } from './merge-test-fixtures.ts';
import type { PackageDoc } from './types.ts';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUPS = ['primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
const STYLES = ['generic', 'storeCard', 'coupon'];

/**
 * A random edit without renames, so the symmetry law applies. It adds, changes and deletes in
 * every part, moves fields between groups, switches the style, changes the barcode count, leaves
 * references dangling, and makes some adds that both sides can make equally.
 */
export function mutate(doc: PackageDoc, r: () => number, n: number): PackageDoc {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
  const tok = () => `v${Math.floor(r() * 1e6)}`;
  const drop = (xs: Any[] | undefined) => {
    if (xs?.length) xs.splice(Math.floor(r() * xs.length), 1);
  };
  return edit(doc, (d) => {
    const pass = d.passJson;
    const man = d.manifest;
    const style = () => pass[STYLES.find((s) => pass[s]) as string] as Any;
    const fields = () => GROUPS.flatMap((g) => style()[g] ?? []);
    const groupOf = (f: Any) => GROUPS.find((g) => style()[g]?.includes(f)) as string;
    const scan = man.scan;
    const panel = () => scan.display.panels[0] as Any | undefined;
    const ops: (() => void)[] = [
      () => (pass.description = tok()),
      () => (pass.foregroundColor = pick(['red', 'blue', tok()])),
      () => (pass[`extra${Math.floor(r() * 3)}`] = tok()),
      () => (pass.sameExtra = 'same'),
      () => (pass.semantics[`s${Math.floor(r() * 3)}`] = tok()),
      () => {
        if (fields().length) (pick(fields()) as Any).label = tok();
      },
      () => {
        const g = pick(GROUPS);
        style()[g] = style()[g] ?? [];
        style()[g].splice(Math.floor(r() * 3), 0, { key: tok(), label: tok(), value: '' });
      },
      () => {
        if (!fields().length) return;
        const f = pick(fields()) as Any;
        const g = groupOf(f);
        style()[g] = style()[g].filter((x: Any) => x !== f);
        if (r() < 0.5) man.bindings = man.bindings.filter((b: Any) => b.to.field !== f.key);
      },
      () => {
        if (!fields().length) return;
        const f = pick(fields()) as Any;
        const [from, to] = [groupOf(f), pick(GROUPS)];
        if (from === to) return;
        style()[from] = style()[from].filter((x: Any) => x !== f);
        style()[to] = [...(style()[to] ?? []), f];
      },
      () => style().secondaryFields?.reverse(),
      () => {
        const from = STYLES.find((s) => pass[s]) as string;
        const to = pick(STYLES);
        if (from === to) return;
        pass[to] = pass[from];
        delete pass[from];
      },
      () => {
        if (pass.barcodes[0]) pass.barcodes[0].message = tok();
      },
      () =>
        pass.barcodes.push({
          format: 'PKBarcodeFormatPDF417',
          message: tok(),
          messageEncoding: 'x',
        }),
      () => pass.barcodes.length > 1 && pass.barcodes.pop(),
      () => pass.barcodes.length > 1 && pass.barcodes.shift(),
      () => man.bindings.push({ to: { barcode: 0, prop: 'altText' }, value: tok() }),
      () => pass.locations.push({ latitude: r(), longitude: r() }),
      () => pass.featuredActions.pop(),
      () => (man.description = tok()),
      () => (man.display.title = tok()),
      () => {
        const key = pick(['tier', 'pts', 'name']);
        if (!man.display.search.includes(key)) man.display.search.push(key);
      },
      () => man.bindings.splice(Math.floor(r() * 3), 0, { to: { field: 'name' }, value: tok() }),
      () => drop(man.bindings),
      () =>
        (man.inputs.properties[tok()] = { type: 'string', maxLength: Math.floor(r() * 50) + 1 }),
      () => (man.inputs.properties.same = { type: 'string' }),
      () => {
        if (man.inputs.properties.name) man.inputs.properties.name.maxLength = Math.floor(r() * 90);
      },
      () => delete man.inputs.properties[pick(Object.keys(man.inputs.properties))],
      () => (man.inputs.required = man.inputs.required.length ? [] : ['name']),
      () => (man.sample[`k${Math.floor(r() * 3)}`] = tok()),
      () => delete man.sample.name,
      () => (man.lookups.tiers.a.label = tok()),
      () => (man.lookups.tiers[`t${Math.floor(r() * 3)}`] = { label: tok() }),
      () => {
        if (scan.actions[0]) scan.actions[0].label = tok();
      },
      () => scan.actions.push({ id: tok(), label: tok(), kind: 'add', input: 'pts', amount: 1 }),
      () => drop(scan.actions),
      () => {
        const row = panel()?.rows[0];
        if (row) row.text = tok();
      },
      () => panel()?.rows.push({ id: tok(), type: 'note', text: `{{${pick(['tier', 'pts'])}}}` }),
      () => drop(panel()?.rows),
      () => drop(scan.display.panels),
      () => {
        if (scan.display.header.chips[0]) scan.display.header.chips[0].text = tok();
      },
      () => drop(scan.display.header.chips),
      () => drop(scan.display.variants),
      () => (scan.display.customer.greet = r() < 0.5),
      () => {
        if (scan.access.plans[0]) scan.access.plans[0].label = tok();
      },
      () => drop(scan.access.plans),
      () => (scan.access.rules.visitGapMinutes = Math.floor(r() * 30)),
      () => (man.stamps.goal = Math.floor(r() * 10) + 3),
      () => (man.nfc[`n${Math.floor(r() * 2)}`] = tok()),
      () => man.wallets.google.omit.push(tok()),
      () => (man.wallets.roles = { ...man.wallets.roles, title: { field: 'name' } }),
      () => (d.files[pick(['icon@2x.png', 'logo@2x.png', 'icon@3x.png'])] = { sha1: sha(tok()) }),
      () => delete d.files[pick(Object.keys(d.files))],
      () => (d.files['stamps/extra.png'] = { sha1: sha('same') }),
      () =>
        (d.files['en.lproj/pass.strings'] = stringsFile({
          Name: tok(),
          Tier: 'Tier',
          [tok()]: tok(),
        })),
      () => (d.files['en.lproj/pass.strings'] = stringsFile({ Name: 'Name' })),
    ];
    for (let i = 0; i < n; i++) pick(ops)();
  });
}
