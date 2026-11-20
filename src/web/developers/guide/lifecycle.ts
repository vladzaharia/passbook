/**
 * The pass lifecycle (D11): what a pass is, and which call moves it. One table of edges drives the
 * SVG (drawn at build, themed by the portal's tokens) and the mermaid text the markdown twin carries.
 */
type State = 'voided' | 'active' | 'removed' | 'deleted';

interface Edge {
  from: State;
  to: State;
  call: string;
}

export const EDGES: Edge[] = [
  { from: 'active', to: 'voided', call: 'void' },
  { from: 'voided', to: 'active', call: 'unvoid' },
  { from: 'active', to: 'removed', call: 'remove' },
  { from: 'removed', to: 'active', call: 'restore' },
  { from: 'active', to: 'deleted', call: 'DELETE' },
  { from: 'voided', to: 'deleted', call: 'DELETE' },
  { from: 'removed', to: 'deleted', call: 'DELETE' },
];

const NAMES: Record<State, string> = {
  voided: 'Voided',
  active: 'Active',
  removed: 'Removed',
  deleted: 'Deleted',
};

export const LIFECYCLE_TITLE = 'Pass lifecycle';
export const LIFECYCLE_DESC =
  'A pass is Active, Voided, Removed or Deleted. void and unvoid move it between Active and Voided. remove and restore move it between Active and Removed. DELETE ends it from any state. update, refresh, renew, new-code and rotate-link leave it Active.';

export const lifecycleMermaid = (): string =>
  ['stateDiagram-v2', ...EDGES.map((e) => `  ${NAMES[e.from]} --> ${NAMES[e.to]}: ${e.call}`)].join(
    '\n',
  );

const W = 130;
const H = 64;
const X = { voided: 10, active: 215, removed: 420 } as const;
const TOP = 30;
const NOTE: Record<State, string> = {
  voided: 'scans refused',
  active: 'update, refresh, renew',
  removed: 'in Expired passes',
  deleted: 'record gone, Wallet keeps the pass and sends it no updates',
};

function box(state: State): string {
  const x = state === 'deleted' ? 10 : X[state];
  const y = state === 'deleted' ? 220 : TOP;
  const w = state === 'deleted' ? 540 : W;
  const h = state === 'deleted' ? 56 : H;
  return (
    `<rect class="lc-box lc-${state}" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` +
    `<text class="lc-name" x="${x + w / 2}" y="${y + 26}" text-anchor="middle">${NAMES[state]}</text>` +
    `<text class="lc-note" x="${x + w / 2}" y="${y + 44}" text-anchor="middle">${NOTE[state]}</text>`
  );
}

/** A horizontal arrow between two neighbouring boxes, its label above or below the line. */
function side(from: State, to: State, call: string, lane: 'upper' | 'lower'): string {
  const right = X[to as 'active'] > X[from as 'active'];
  const gapStart = right ? X[from as 'active'] + W : X[from as 'active'];
  const gapEnd = right ? X[to as 'active'] : X[to as 'active'] + W;
  const y = TOP + (lane === 'upper' ? 20 : 46);
  const label = (gapStart + gapEnd) / 2;
  return (
    `<line class="lc-arrow" x1="${gapStart + (right ? 4 : -4)}" y1="${y}" x2="${gapEnd + (right ? -4 : 4)}" y2="${y}" marker-end="url(#lc-head)"/>` +
    `<text class="lc-call" x="${label}" y="${lane === 'upper' ? y - 6 : y + 17}" text-anchor="middle">${call}</text>`
  );
}

export function lifecycleSvg(): string {
  const down = (state: 'voided' | 'active' | 'removed') => {
    const x = X[state] + W / 2;
    return `<line class="lc-arrow lc-end" x1="${x}" y1="${TOP + H + 4}" x2="${x}" y2="216" marker-end="url(#lc-head)"/>`;
  };
  return (
    `<svg class="lifecycle" viewBox="0 0 560 290" role="img" aria-labelledby="lc-title lc-desc" xmlns="http://www.w3.org/2000/svg">` +
    `<title id="lc-title">${LIFECYCLE_TITLE}</title><desc id="lc-desc">${LIFECYCLE_DESC}</desc>` +
    '<defs><marker id="lc-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="lc-tip"/></marker></defs>' +
    (['voided', 'active', 'removed', 'deleted'] as const).map(box).join('') +
    side('active', 'voided', 'void', 'upper') +
    side('voided', 'active', 'unvoid', 'lower') +
    side('active', 'removed', 'remove', 'upper') +
    side('removed', 'active', 'restore', 'lower') +
    (['voided', 'active', 'removed'] as const).map(down).join('') +
    `<text class="lc-call" x="${X.active + W / 2 + 10}" y="165" text-anchor="start">DELETE, from any state</text>` +
    '</svg>'
  );
}
