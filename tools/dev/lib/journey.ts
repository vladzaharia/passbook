// Journeys: scripted multi-step flows. Each step does its side effects once, then names the one
// screen to screenshot at every viewport and theme. Pure helpers here; the runner is journey-run.ts.
import type { Page } from '@playwright/test';
import type { JourneyEnv } from './journey-env.ts';
import type { Role } from './routes.ts';

export type PageView = {
  kind: 'page';
  role: Role;
  path: string;
  /** Saved Playwright storage state to use instead of the role's (a holder made during the journey). */
  storage?: string;
  waitFor?: string;
  /** Org the console is pointed at when it is not the journey's (an org made during the run). */
  orgId?: string;
  /** Console mode for the page ("Test" keeps its own data and inbox). */
  mode?: 'test';
  /** Non-destructive UI work before the shot: open a dialog, type into a field. Runs per viewport. */
  prepare?: (page: Page) => Promise<void>;
};
export type HtmlView = { kind: 'html'; html: string };
export type View = PageView | HtmlView;
/** A step that cannot run records why and captures nothing. */
export type Skip = { skip: string };

export type Step = { title: string; run: (env: JourneyEnv) => Promise<View | Skip> };
export type Journey = {
  name: string;
  title: string;
  /** Org slug the admin console is pointed at. */
  org: string;
  steps: Step[];
};

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'step';

/** `<NN>-<title>`: NN is the 1-based step number, so a folder sorts in the order a user saw it. */
export const stepStem = (index: number, title: string): string =>
  `${String(index + 1).padStart(2, '0')}-${slug(title)}`;

export const stepFile = (index: number, title: string, viewport: string, theme: string): string =>
  `${stepStem(index, title)}-${viewport}-${theme}.png`;

/** Throws on a journey that cannot be run: no steps or an untitled step. */
export function checkJourney(journey: Journey): void {
  if (!journey.name || journey.steps.length === 0)
    throw new Error(`Journey "${journey.name}" needs a name and at least one step.`);
  journey.steps.forEach((step, i) => {
    if (!step.title.trim()) throw new Error(`${journey.name}: step ${i + 1} has no title.`);
  });
}

/** `--journeys a,b` (or `all`) to journeys, in the order asked; an unknown name is an error. */
export function pickJourneys(all: Journey[], names: string): Journey[] {
  if (names === 'all') return all;
  return names
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => {
      const found = all.find((j) => j.name === n);
      if (!found)
        throw new Error(`Unknown journey "${n}"; use ${all.map((j) => j.name).join(', ')}.`);
      return found;
    });
}

export type StepResult = {
  index: number;
  title: string;
  stem: string;
  /** Page path or `mail`; capability tokens are redacted. */
  where: string;
  files: Record<string, string>;
  note?: string;
  consoleErrors: string[];
  failedRequests: string[];
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** A static page: one row per step in order, one cell per viewport, light and dark side by side. */
export function renderIndex(
  journey: Pick<Journey, 'name' | 'title'>,
  steps: StepResult[],
  viewports: string[],
  themes: string[],
): string {
  const rows = steps
    .map((s) => {
      const cells = viewports
        .map((vp) => {
          const imgs = themes
            .map((t) => {
              const file = s.files[`${vp}-${t}`];
              return file
                ? `<a href="${esc(file)}"><img loading="lazy" src="${esc(file)}" alt="${esc(`${s.title} ${vp} ${t}`)}"></a>`
                : `<span class="none">${t}: none</span>`;
            })
            .join('');
          return `<div class="vp"><h3>${vp}</h3><div class="themes">${imgs}</div></div>`;
        })
        .join('');
      const problems = [...s.consoleErrors, ...s.failedRequests].map((e) => `<li>${esc(e)}</li>`);
      return `<section id="${esc(s.stem)}"><h2><span>${s.index + 1}</span> ${esc(s.title)} <code>${esc(s.where)}</code></h2>${
        s.note ? `<p class="note">${esc(s.note)}</p>` : ''
      }${problems.length ? `<ul class="errs">${problems.join('')}</ul>` : ''}<div class="row">${cells}</div></section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(journey.title)}</title>
<style>
body{font:14px system-ui;margin:0;padding:16px;background:#f4f4f5;color:#18181b}
h1{margin:0 0 16px}section{background:#fff;border:1px solid #d4d4d8;border-radius:8px;padding:12px;margin:0 0 16px}
h2{font-size:16px;margin:0 0 8px}h2 span{display:inline-block;min-width:1.6em;text-align:center;background:#18181b;color:#fff;border-radius:99px}
code{font-weight:400;color:#52525b;font-size:12px}.row{display:flex;gap:16px;align-items:flex-start;overflow-x:auto}
.vp h3{margin:0 0 4px;font-size:12px;color:#52525b}.themes{display:flex;gap:6px}
img{display:block;border:1px solid #d4d4d8;max-height:560px;width:auto;max-width:640px}
.note{color:#b45309;margin:0 0 8px}.errs{color:#b91c1c;font-size:12px;margin:0 0 8px}.none{color:#a1a1aa}
</style><h1>${esc(journey.title)}</h1>
${rows}
</html>
`;
}
