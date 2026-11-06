import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { SCAN_ICONS } from '../../../passkit/template/scan-display/icons.ts';
import { type ScanDisplayRow, ScanDisplaySchema } from '../../../shared/contracts/scan-display.ts';
import { display, maxPanels, maxRows, panel } from './display.test-support.ts';
import { DisplayPanels } from './display-panels.tsx';
import { SCAN_ICON_COMPONENTS, scanIcon } from './icons.ts';
import { DisplayRowView } from './panel.tsx';

const WIDTHS = [390, 820, 1180] as const;
const THEMES = ['light', 'dark'] as const;

describe('display fixtures', () => {
  it('parse with the contract', () => {
    const [a, b, c] = maxPanels();
    expect(ScanDisplaySchema.safeParse(display([a, b] as never)).error).toBeUndefined();
    expect(ScanDisplaySchema.safeParse(display([c] as never)).error).toBeUndefined();
  });
});

describe('every row type and the panel frame', () => {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      it(`has no axe violations at ${width} px, ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        const { container } = render(
          <main style={{ width }}>
            <DisplayPanels display={display(maxPanels())} />
          </main>,
        );
        expect(container.querySelectorAll('.sd-panel')).toHaveLength(3);
        expect((await axe(container)).violations).toEqual([]);
        delete document.documentElement.dataset.theme;
      });
    }
  }

  it('paints text as text nodes with dir=auto, never markup', () => {
    const rows: ScanDisplayRow[] = [
      {
        type: 'field',
        id: 'f',
        label: '<b>x</b>',
        value: '<img src=x onerror=alert(1)>',
        icon: null,
        strong: false,
      },
    ];
    const { container } = render(<DisplayPanels display={display([panel(rows)])} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelectorAll('[dir="auto"]').length).toBeGreaterThan(1);
  });

  it('never renders a button', () => {
    const { container } = render(<DisplayPanels display={display([panel(maxRows)])} />);
    expect(container.querySelector('button, [role="button"], a')).toBeNull();
  });

  it('skips an unknown row type', () => {
    const unknown = { type: 'hologram', id: 'x' } as unknown as ScanDisplayRow;
    const { container } = render(<div>{DisplayRowView({ row: unknown })}</div>);
    expect(container.textContent).toBe('');
    const d = display([panel([unknown, maxRows[1] as ScanDisplayRow])]);
    const painted = render(<DisplayPanels display={d} />);
    expect(painted.container.querySelectorAll('.sd-field')).toHaveLength(1);
  });

  it('paints no panels on a refused screen, even when the payload has some', () => {
    const { container } = render(
      <DisplayPanels display={display([panel(maxRows)], { screen: 'refused' })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('honours oneLine for columns and lists, and a long field value moves under its label', () => {
    const { container } = render(<DisplayPanels display={display([panel(maxRows)])} />);
    const cols = container.querySelectorAll('.sd-cols');
    expect(cols[0]).toHaveAttribute('data-one-line', 'false');
    expect(cols[1]).toHaveAttribute('data-one-line', 'true');
    expect(
      container.querySelector('.sd-cols[data-size="big"] .sd-col-value')?.textContent,
    ).toHaveLength(8);
    expect(container.querySelector('.sd-field')).toHaveAttribute('data-long');
    expect(container.querySelector('.sd-list')).toHaveAttribute('data-pair');
    expect(cols[1]?.textContent).toContain('—');
  });

  it('shows the progress change, the new stamps, the bar and the gift', () => {
    const { container } = render(<DisplayPanels display={display([panel(maxRows)])} />);
    expect(container.querySelectorAll('.sd-stamp')).toHaveLength(10);
    expect(container.querySelectorAll('.sd-stamp.is-filled')).toHaveLength(9);
    expect(container.querySelectorAll('.sd-stamp.is-new')).toHaveLength(2);
    expect(container.querySelector('.sd-readout')?.textContent).toContain('7');
    expect(container.querySelectorAll('.sd-caption-gift')).toHaveLength(1);
    expect(container.querySelector('.sd-caption b')?.textContent).toBe('1');
  });

  it('paints money: old struck, new, the change chip and Low balance', () => {
    const { container } = render(<DisplayPanels display={display([panel(maxRows)])} />);
    expect(container.querySelector('s')?.textContent).toBe('$42.50');
    expect(container.querySelector('.sd-money-new')?.textContent).toBe('$30.50');
    expect(container.querySelector('.sd-money-change')?.textContent).toBe('−$12.00');
    expect(container.querySelector('.sd-low')?.textContent).toBe('Low balance');
  });

  it('paints history rows and Changed elsewhere; an empty ledger paints its line', () => {
    const { container } = render(<DisplayPanels display={display([panel(maxRows)])} />);
    expect(container.querySelectorAll('.sd-history-item')).toHaveLength(2);
    expect(container.textContent).toContain('Changed elsewhere');
    const empty = render(
      <DisplayPanels
        display={display([
          panel([{ type: 'history', id: 'h', items: [], empty: 'No visits yet.' }]),
        ])}
      />,
    );
    expect(empty.container.textContent).toContain('No visits yet.');
  });

  it('falls back to a bar for stamps over ten', () => {
    const row: ScanDisplayRow = {
      type: 'progress',
      id: 'p',
      value: 3,
      goal: 12,
      before: null,
      style: 'stamps',
      icon: null,
      rewards: 0,
      caption: '',
    };
    const { container } = render(<DisplayPanels display={display([panel([row])])} />);
    expect(container.querySelector('.sd-stamps')).toBeNull();
    expect(container.querySelector('.sd-bar')).not.toBeNull();
  });
});

describe('icons', () => {
  it('maps every SCAN_ICONS id to a component', () => {
    for (const id of SCAN_ICONS) expect(SCAN_ICON_COMPONENTS[id], id).toBeTruthy();
    expect(Object.keys(SCAN_ICON_COMPONENTS).sort()).toEqual([...SCAN_ICONS].sort());
  });
  it('paints info for an unknown id and nothing for none', () => {
    expect(scanIcon('from-the-future')).toBe(SCAN_ICON_COMPONENTS.info);
    expect(scanIcon(null)).toBeNull();
  });
});
