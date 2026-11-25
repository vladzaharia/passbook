const SVG = 'http://www.w3.org/2000/svg';

type Shape = [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>];

/** Lucide's outlines (ISC), drawn with DOM calls: the portal runs under Trusted Types, so no markup is parsed. */
const SHAPES = {
  search: [
    ['circle', { cx: '11', cy: '11', r: '8' }],
    ['path', { d: 'm21 21-4.3-4.3' }],
  ],
  chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  copy: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
  ],
  terminal: [
    ['path', { d: 'm4 17 6-6-6-6' }],
    ['path', { d: 'M12 19h8' }],
  ],
  monitor: [
    ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
    ['path', { d: 'M8 21h8' }],
    ['path', { d: 'M12 17v4' }],
  ],
  open: [
    ['path', { d: 'M7 7h10v10' }],
    ['path', { d: 'M7 17 17 7' }],
  ],
  book: [
    ['path', { d: 'M12 7v14' }],
    [
      'path',
      {
        d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
      },
    ],
  ],
} satisfies Record<string, Shape[]>;

type IconName = keyof typeof SHAPES;

/** A 16 px decorative icon. */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    class: 'lucide',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(k, v);
  for (const [tag, attrs] of SHAPES[name] as Shape[]) {
    const shape = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}
