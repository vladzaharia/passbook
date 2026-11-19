// Pass parity: the same pass on every surface, for every built-in template, side by side.
// node tools/dev/pass-parity.ts --url http://localhost:5273 [--only coupon] [--no-sim] [--no-ql]
// Output: .wrangler/pass-parity/<slug>/index.html and .wrangler/pass-parity/index.html.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertLocal } from '../lib/demo-client.ts';
import { contextFor } from './lib/auth.ts';
import { downloadPass, QuickLook, Simulator } from './lib/parity/apple.ts';
import { compareRows, expectedRows, type Surface } from './lib/parity/compare.ts';
import { Api, bakedSlugs, ensurePass, issueKey, subjectFor } from './lib/parity/issue.ts';
import {
  type Column,
  rootSheet,
  type Summary,
  templateSheet,
  type WalletDetail,
} from './lib/parity/sheet.ts';
import {
  captureEmail,
  captureScan,
  captureWeb,
  ensureDir,
  myPassIdOf,
  textOf,
} from './lib/parity/surfaces.ts';
import { compileWallets, type WalletOut } from './lib/parity/wallets.ts';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const HOLDER = 'maya.chen@example.com';

const detail = (title: string, w: WalletOut): WalletDetail => ({
  title,
  type: w.type,
  status:
    w.report.status.kind === 'blocked'
      ? `blocked: ${w.report.status.reason}`
      : w.report.status.kind,
  items: w.report.items.map(({ capability, path, severity, message }) => ({
    capability,
    path,
    severity,
    message,
  })),
  images: [...new Set(w.text.match(/parity\.example\/w\/i\/[A-Za-z0-9-]+/g) ?? [])].map(
    (u) => u.split('/').pop() as string,
  ),
});

async function main() {
  const base = assertLocal(arg('--url') ?? 'http://localhost:5273');
  const out = resolve(root, arg('--out') ?? '.wrangler/pass-parity');
  if (!out.startsWith(`${resolve(root, '.wrangler')}/`))
    throw new Error('--out must be inside .wrangler/.');
  const stateDir = resolve(root, '.wrangler/visual-sweep/state');
  const only = arg('--only');
  const slugs = bakedSlugs().filter((s) => !only || s.includes(only));

  const plat = await contextFor(base, stateDir, 'platform');
  const orgs = (
    (await (await plat.get('/api/v1/orgs')).json()) as {
      items: { id: string; slug: string; name: string }[];
    }
  ).items;
  const api = await Api.open(await contextFor(base, stateDir, 'org'));
  const holder = await contextFor(base, stateDir, 'holder');
  const keys = new Map<string, { id: string; authorization: string }>();
  const sim = new Simulator();
  const ql = new QuickLook();
  const simError = flag('--no-sim') ? 'skipped (--no-sim)' : await sim.boot();
  if (simError) console.warn(`Simulator: ${simError}`);
  mkdirSync(out, { recursive: true });

  const summaries: Summary[] = [];
  try {
    for (const slug of slugs) {
      const notes: string[] = [];
      try {
        const subject = await subjectFor(api, slug, orgs);
        if (!keys.has(subject.orgId)) keys.set(subject.orgId, await issueKey(api, subject.orgId));
        const pass = await ensurePass(
          api,
          base,
          subject,
          keys.get(subject.orgId)?.authorization as string,
          HOLDER,
        );
        const dir = ensureDir(resolve(out, slug));
        const passId = String(pass.id);
        const token = String(pass.publicUrl).split('/').filter(Boolean).pop() as string;
        const passJson = pass.passJson as Record<string, unknown>;
        writeFileSync(resolve(dir, 'pass.json'), `${JSON.stringify(passJson, null, 2)}\n`);

        // Apple
        const pkpass = resolve(dir, 'pass.pkpass');
        await downloadPass(String(pass.downloadUrl), pkpass);
        const quick = flag('--no-ql')
          ? { file: null, note: 'skipped (--no-ql)' }
          : await ql.thumbnail(pkpass, dir);
        const phone = simError
          ? { file: null, note: `simulator: ${simError}` }
          : await sim.addPass(String(pass.downloadUrl), resolve(dir, 'simulator-add-pass.png'));
        notes.push(...[quick, phone].filter((s) => !s.file).map((s) => `Apple: ${s.note}`));

        // Our renders
        const ids = {
          orgId: subject.orgId,
          passId,
          templateId: subject.templateId,
          passToken: token,
          ...(await myPassIdOf(holder, passId).then((id) => (id ? { myPassId: id } : {}))),
        };
        const shots = await captureWeb(base, stateDir, dir, ids);
        shots.push(...(await captureScan(base, stateDir, dir, ids)));
        const mail = await captureEmail(
          api,
          dir,
          passId,
          token,
          `parity.${slug.replace(/^[a-z]+-/, '')}@example.com`,
        );
        shots.push(...mail.shots);
        notes.push(
          ...shots
            .filter((s) => !s.file)
            .map((s) => `${s.name} ${s.viewport}/${s.theme}: ${s.note ?? 'not captured'}`)
            .slice(0, 6),
        );
        if (!mail.shots.length) notes.push(`email: ${mail.note}`);
        writeFileSync(
          resolve(dir, 'shots.json'),
          `${JSON.stringify(
            shots.map((s) => ({
              ...s,
              route: s.route.replace(/\/p\/[A-Za-z0-9_-]{20,}/, '/p/:token'),
            })),
            null,
            2,
          )}\n`,
        );

        // Google and Samsung
        const wallets = await compileWallets(slug, passJson, subject.sample);
        writeFileSync(
          resolve(dir, 'payload-google.json'),
          `${JSON.stringify({ class: wallets.google.compiled.classBody, object: wallets.google.compiled.objectBody }, null, 2)}\n`,
        );
        writeFileSync(
          resolve(dir, 'payload-samsung.json'),
          `${JSON.stringify(wallets.samsung.compiled.cardData, null, 2)}\n`,
        );
        writeFileSync(
          resolve(dir, 'report-google.json'),
          `${JSON.stringify(wallets.google.report, null, 2)}\n`,
        );
        writeFileSync(
          resolve(dir, 'report-samsung.json'),
          `${JSON.stringify(wallets.samsung.report, null, 2)}\n`,
        );

        // Comparison
        const web = (name: string, informational = false): Surface => {
          const text = textOf(dir, name);
          return text === null
            ? { kind: 'none' }
            : { kind: 'text', text, reads: ['field', 'meta'], informational };
        };
        const surfaces: Record<string, Surface> = {
          Apple: { kind: 'source' },
          Admin: web('admin'),
          Portal: web('portal'),
          Hosted: web('hosted'),
          Designer: web('designer', true),
          Email: web('email', true),
          Scanner: web('scanner', true),
          Google: {
            kind: 'wallet',
            text: wallets.google.text,
            items: wallets.google.compiled.items,
          },
          Samsung: {
            kind: 'wallet',
            text: wallets.samsung.text,
            items: wallets.samsung.compiled.items,
          },
        };
        const rows = compareRows(expectedRows(passJson), surfaces);
        const status = (w: WalletOut) => `${w.type}: ${w.report.status.kind}`;
        const columns: Column[] = [
          {
            id: 'apple',
            title: 'Apple',
            fixed: [quick, phone],
            lines: ['pass.pkpass is the source of truth.'],
            link: [
              { href: 'pass.pkpass', text: 'pass.pkpass' },
              { href: 'pass.json', text: 'pass.json' },
            ],
          },
          { id: 'admin', title: 'Admin pass detail', stem: 'admin', lines: [] },
          { id: 'designer', title: 'Template designer', stem: 'designer', lines: [] },
          { id: 'portal', title: 'Portal (holder)', stem: 'portal', lines: [] },
          { id: 'hosted', title: 'Hosted page', stem: 'hosted', lines: [] },
          {
            id: 'email',
            title: 'Delivery email',
            stem: 'email',
            lines: [],
            link: [{ href: 'email.html', text: 'email.html' }],
          },
          {
            id: 'scanner',
            title: 'Scan screen (designer)',
            stem: 'scanner',
            lines: ['1440 only.'],
          },
          {
            id: 'google',
            title: 'Google Wallet',
            lines: [status(wallets.google), 'No preview renderer yet (CW8): see tables below.'],
            link: [
              { href: 'payload-google.json', text: 'payload' },
              { href: 'report-google.json', text: 'report' },
            ],
          },
          {
            id: 'samsung',
            title: 'Samsung Wallet',
            lines: [status(wallets.samsung), 'No preview renderer yet (CW8): see tables below.'],
            link: [
              { href: 'payload-samsung.json', text: 'payload' },
              { href: 'report-samsung.json', text: 'report' },
            ],
          },
        ];
        writeFileSync(resolve(dir, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
        const org = orgs.find((o) => o.id === subject.orgId)?.slug ?? subject.orgId;
        writeFileSync(
          resolve(dir, 'index.html'),
          templateSheet({
            name: subject.templateName,
            slug,
            org,
            columns,
            rows,
            surfaces: Object.keys(surfaces),
            wallets: [
              detail('Google Wallet', wallets.google),
              detail('Samsung Wallet', wallets.samsung),
            ],
            notes,
          }),
        );
        summaries.push({
          slug,
          name: subject.templateName,
          org,
          differing: rows.filter((r) => r.differs).length,
          total: rows.length,
          google: status(wallets.google),
          samsung: status(wallets.samsung),
          notes,
        });
        console.log(
          `${slug}: ${rows.filter((r) => r.differs).length}/${rows.length} rows differ, ${notes.length} notes`,
        );
      } catch (e) {
        const message = (e as Error).message.split('\n')[0] as string;
        console.error(`${slug}: FAILED ${message}`);
        summaries.push({
          slug,
          name: slug,
          org: '',
          differing: 0,
          total: 0,
          google: '-',
          samsung: '-',
          notes: [`failed: ${message}`],
        });
      }
    }
  } finally {
    await sim.shutdown();
    for (const [org, key] of keys)
      await api.del(`/api/v1/api-keys/${key.id}?orgId=${org}`).catch(() => undefined);
  }
  writeFileSync(
    resolve(out, 'index.html'),
    rootSheet(summaries, new Date().toISOString().slice(0, 16)),
  );
  writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summaries, null, 2)}\n`);
  console.log(`${summaries.length} templates -> ${out}/index.html`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
