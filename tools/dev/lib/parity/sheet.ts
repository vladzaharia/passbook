// The contact sheet (index.html) per template, and the index over all templates.
import type { Cell, Compared } from './compare.ts';

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

export type Column = {
  id: string;
  title: string;
  /** Image file stem for the viewport and theme switch (`<stem>-<viewport>-<theme>.png`). */
  stem?: string;
  /** Fixed images (Quick Look, simulator) that ignore the switch. */
  fixed?: { file: string | null; note: string }[];
  /** Text shown under the title: provider type, status, why nothing was captured. */
  lines: string[];
  link?: { href: string; text: string }[];
};

export type WalletDetail = {
  title: string;
  type: string;
  status: string;
  items: { capability: string; path: string; severity: string; message: string }[];
  images: string[];
};

export type SheetInput = {
  name: string;
  slug: string;
  org: string;
  columns: Column[];
  rows: Compared[];
  surfaces: string[];
  wallets: WalletDetail[];
  notes: string[];
};

const MARK: Record<Cell, string> = {
  shown: 'yes',
  partial: 'part',
  missing: 'no',
  omitted: 'omit',
  na: '-',
  unknown: '?',
};

const css = `
:root{color-scheme:light dark;--bg:#fff;--fg:#17181c;--mut:#666b75;--line:#d9dbe0;--bad:#fde8e6;--ok:#e7f5ea;--mid:#fff4d6}
@media (prefers-color-scheme:dark){:root{--bg:#14151a;--fg:#ececf0;--mut:#9aa0ab;--line:#33363f;--bad:#4a2420;--ok:#1f3a27;--mid:#4a3d17}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}
h1{margin:0 0 4px;font-size:20px}h2{margin:28px 0 8px;font-size:16px}
.mut{color:var(--mut)}.bar{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0}
.grid{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(230px,1fr);gap:12px;overflow-x:auto;padding-bottom:8px}
.col{border:1px solid var(--line);border-radius:8px;padding:8px;min-width:0}
.col h3{margin:0 0 6px;font-size:13px}.col img{width:100%;max-height:640px;object-fit:contain;object-position:top;border:1px solid var(--line);border-radius:4px;margin-bottom:6px}
.col p{margin:2px 0;font-size:12px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top;font-size:12px}
td.c{text-align:center;white-space:nowrap}.shown{background:var(--ok)}.partial,.omitted{background:var(--mid)}.missing{background:var(--bad)}
tr.diff td:first-child{border-left:4px solid #d9534f}code{font-size:11px;word-break:break-all}
`;

const js = `
const $=(s)=>document.querySelector(s);
function sync(){const vp=$('input[name=vp]:checked').value,th=$('input[name=th]:checked').value;
document.querySelectorAll('img[data-stem]').forEach(i=>{const a=i.parentElement,note=a.nextElementSibling;a.hidden=false;note.hidden=true;i.src=i.dataset.stem+'-'+vp+'-'+th+'.png';a.href=i.src});}
document.querySelectorAll('img[data-stem]').forEach(i=>i.addEventListener('error',()=>{const a=i.parentElement;a.hidden=true;a.nextElementSibling.hidden=false}));
document.querySelectorAll('input[name=vp],input[name=th]').forEach(i=>i.addEventListener('change',sync));sync();
`;

function column(c: Column): string {
  const img = c.stem
    ? `<a class="shot" target="_blank"><img data-stem="${esc(c.stem)}" alt="${esc(c.title)}"></a><p class="mut" hidden>not captured</p>`
    : '';
  const fixed = (c.fixed ?? [])
    .map((f) =>
      f.file
        ? `<img src="${esc(f.file)}" alt="${esc(c.title)}"><p class="mut">${esc(f.note)}</p>`
        : `<p class="mut">${esc(f.note)}</p>`,
    )
    .join('');
  const link = (c.link ?? [])
    .map((l) => `<p><a href="${esc(l.href)}">${esc(l.text)}</a></p>`)
    .join('');
  return `<div class="col"><h3>${esc(c.title)}</h3>${img}${fixed}${c.lines.map((l) => `<p>${esc(l)}</p>`).join('')}${link}</div>`;
}

export function templateSheet(i: SheetInput): string {
  const head = i.surfaces.map((s) => `<th>${esc(s)}</th>`).join('');
  const body = i.rows
    .map((r) => {
      const cells = i.surfaces
        .map((s) => `<td class="c ${r.cells[s]}">${MARK[r.cells[s] as Cell]}</td>`)
        .join('');
      return `<tr class="${r.differs ? 'diff' : ''}"><td><code>${esc(r.path)}</code></td><td>${esc(r.label)}</td><td>${esc(r.value.slice(0, 80))}</td>${cells}</tr>`;
    })
    .join('');
  const wallets = i.wallets
    .map(
      (w) => `<h2>${esc(w.title)}: ${esc(w.type)} (${esc(w.status)})</h2>
<p class="mut">Images the provider would carry: ${w.images.length ? w.images.map(esc).join(', ') : 'none'}</p>
<div class="scroll"><table><tr><th>Capability</th><th>Path</th><th>Level</th><th>What differs</th></tr>${
        w.items
          .map(
            (x) =>
              `<tr><td>${esc(x.capability)}</td><td><code>${esc(x.path)}</code></td><td>${esc(x.severity)}</td><td>${esc(x.message)}</td></tr>`,
          )
          .join('') || '<tr><td colspan="4">Nothing reported.</td></tr>'
      }</table></div>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parity: ${esc(i.name)}</title><style>${css}</style>
<p><a href="../index.html">All templates</a></p>
<h1>${esc(i.name)}</h1><p class="mut">${esc(i.slug)} in ${esc(i.org)}</p>
<div class="bar"><span>Viewport
<label><input type="radio" name="vp" value="mobile" checked> 390</label>
<label><input type="radio" name="vp" value="desktop"> 1440</label></span>
<span>Theme <label><input type="radio" name="th" value="light" checked> light</label>
<label><input type="radio" name="th" value="dark"> dark</label></span></div>
<div class="grid">${i.columns.map(column).join('')}</div>
${i.notes.length ? `<h2>Notes</h2><ul>${i.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
<h2>Fields on each surface</h2>
<p class="mut">yes: value shown. part: label only, or the provider changed it. no: absent. omit: provider drops it. -: surface cannot show this kind. ?: not captured. Email, scanner and designer are shown for reference and do not mark a row as a difference. Barcode and color rows are checked in the wallet payloads only.</p>
<div class="scroll"><table><tr><th>Path</th><th>Label</th><th>Value</th>${head}</tr>${body}</table></div>
${wallets}<script>${js}</script>`;
}

export type Summary = {
  slug: string;
  name: string;
  org: string;
  differing: number;
  total: number;
  google: string;
  samsung: string;
  notes: string[];
};

export function rootSheet(all: Summary[], stamp: string): string {
  const rows = all
    .map(
      (s) =>
        `<tr><td><a href="${esc(s.slug)}/index.html">${esc(s.name)}</a><br><span class="mut">${esc(s.slug)}</span></td><td>${esc(s.org)}</td><td>${s.differing} of ${s.total}</td><td>${esc(s.google)}</td><td>${esc(s.samsung)}</td><td>${s.notes.map(esc).join('<br>')}</td></tr>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pass parity</title><style>${css}</style><h1>Pass parity</h1><p class="mut">${esc(stamp)}. One pass per template on every surface.</p>
<div class="scroll"><table><tr><th>Template</th><th>Org</th><th>Rows that differ</th><th>Google</th><th>Samsung</th><th>Not captured</th></tr>${rows}</table></div>`;
}
