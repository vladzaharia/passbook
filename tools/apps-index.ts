// Builds the install page for the Pages site.
//   node tools/apps-index.ts --out _site/index.html --qr qr.svg
// Reads PAGES_URL, FDROID_REPO_FINGERPRINT, TESTFLIGHT_PUBLIC_URL and PLAY_INTERNAL_URL from the environment.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const GITHUB_URL = 'https://github.com/vladzaharia/passbook';

export type IndexOptions = {
  pagesUrl: string;
  fingerprint: string;
  qrSvg: string;
  iconSvg: string;
  testflightUrl?: string;
  playUrl?: string;
};

const esc = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function normalizeFingerprint(value: string): string {
  const hex = value.replaceAll(':', '').trim().toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex))
    throw new Error('FDROID_REPO_FINGERPRINT must be a SHA-256 fingerprint (64 hex digits)');
  return hex;
}

export function fdroidLinks(pagesUrl: string, fingerprint: string) {
  const repo = `${pagesUrl}/fdroid/repo`;
  const fp = normalizeFingerprint(fingerprint);
  return {
    repo,
    web: `${repo}?fingerprint=${fp}`,
    deep: `fdroidrepos://${repo.replace(/^https:\/\//, '')}?fingerprint=${fp}`,
    fingerprint: fp,
  };
}

const link = (href: string, label: string, primary = false) =>
  `<a class="btn${primary ? ' primary' : ''}" href="${esc(href)}">${esc(label)}</a>`;
/** Segno writes width and height but no viewBox, so CSS sizing would crop the code instead of scaling it. */
export function scalable(svg: string): string {
  const tag = svg.match(/^<svg\b[^>]*>/)?.[0];
  if (!tag || /\bviewBox=/.test(tag)) return svg;
  const w = tag.match(/\bwidth="(\d+)"/)?.[1];
  const h = tag.match(/\bheight="(\d+)"/)?.[1];
  if (!w || !h) return svg;
  return svg.replace(
    tag,
    tag.replace('<svg', `<svg viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges"`),
  );
}

const https = (url?: string) => (url && /^https:\/\/\S+$/.test(url) ? url : '');

export function buildIndex(o: IndexOptions): string {
  const source = `${o.pagesUrl}/altstore/source.json`;
  const fd = fdroidLinks(o.pagesUrl, o.fingerprint);
  const testflight = https(o.testflightUrl);
  const play = https(o.playUrl);
  if (!/^<svg[\s>]/.test(o.qrSvg.trim())) throw new Error('The QR code must be an SVG');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PassBook apps</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light dark;--bg:#f7f8fb;--fg:#10131c;--muted:#566074;--card:#fff;--line:#d9deea;--accent:#0f766e;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d111b;--fg:#eef1f8;--muted:#a3adc2;--card:#161b29;--line:#2a3247;--accent:#2dd4bf;--on:#07201c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1rem 3rem}
header{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem}
header svg{width:2.5rem;height:2.5rem;flex:none}
h1{font-size:1.5rem;margin:0}
h2{font-size:1.125rem;margin:2rem 0 .75rem}
section.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:0 0 .25rem}
p{margin:.25rem 0 .75rem;color:var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:.5rem}
.btn{display:inline-block;padding:.5rem .875rem;border:1px solid var(--accent);border-radius:.5rem;color:var(--accent);text-decoration:none;font-weight:600}
.btn.primary{background:var(--accent);color:var(--on)}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
code{display:block;overflow-x:auto;padding:.5rem .75rem;border:1px solid var(--line);border-radius:.5rem;font:.8125rem/1.4 ui-monospace,monospace;margin:.5rem 0 0;word-break:break-all;white-space:pre-wrap}
.qr{display:flex;flex-wrap:wrap;gap:1rem;align-items:center}
.qr svg{width:9rem;height:9rem;background:#fff;border-radius:.5rem;padding:.25rem;flex:none}
.qr>div{flex:1 1 14rem;min-width:0}
</style>
</head>
<body>
<main>
<header>${o.iconSvg.trim()}<h1>PassBook apps</h1></header>
<h2>iPhone and iPad</h2>
<section class="card" id="altstore">
<h3>AltStore</h3>
<div class="row">${link(`altstore://source?url=${source}`, 'Add source', true)}</div>
<code>${esc(source)}</code>
</section>
<section class="card" id="sidestore">
<h3>SideStore</h3>
<div class="row">${link(`sidestore://source?url=${source}`, 'Add source', true)}</div>
</section>${
    testflight
      ? `
<section class="card" id="testflight">
<h3>TestFlight</h3>
<div class="row">${link(testflight, 'Join the beta', true)}</div>
</section>`
      : ''
  }
<h2>Android</h2>
<section class="card" id="fdroid">
<h3>F-Droid and Droid-ify</h3>
<div class="qr">
${scalable(o.qrSvg.trim())}
<div>
<div class="row">${link(fd.deep, 'Add repo', true)}${link(fd.web, 'Repo link')}</div>
<p>SHA-256 fingerprint</p>
<code>${esc(fd.fingerprint.match(/.{2}/g)?.join(' ') ?? '')}</code>
</div>
</div>
</section>
<section class="card" id="obtainium">
<h3>Obtainium</h3>
<div class="row">${link(`obtainium://add/${GITHUB_URL}`, 'Add app', true)}</div>
</section>${
    play
      ? `
<section class="card" id="play">
<h3>Google Play internal testing</h3>
<div class="row">${link(play, 'Join the test', true)}</div>
</section>`
      : ''
  }
<h2>Source</h2>
<p><a href="${GITHUB_URL}">github.com/vladzaharia/passbook</a></p>
</main>
</body>
</html>
`;
}

function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const value = i < 0 ? undefined : process.argv[i + 1];
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const env = process.env;
  const html = buildIndex({
    pagesUrl: (env.PAGES_URL ?? '').replace(/\/$/, ''),
    fingerprint: env.FDROID_REPO_FINGERPRINT ?? '',
    qrSvg: readFileSync(arg('qr'), 'utf8'),
    iconSvg: readFileSync(join(root, 'public/favicon.svg'), 'utf8'),
    testflightUrl: env.TESTFLIGHT_PUBLIC_URL,
    playUrl: env.PLAY_INTERNAL_URL,
  });
  writeFileSync(arg('out'), html);
}

if (process.argv[1] === import.meta.filename) main();
