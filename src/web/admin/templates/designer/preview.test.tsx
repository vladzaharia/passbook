import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignerPreview } from './preview.tsx';

vi.mock('../../../pass-card/index.tsx', () => ({
  PassCardStage: ({ view }: { view: { fields: string[] } }) => (
    <div>
      {view.fields.map((k) => (
        <span key={k} data-fk={k} />
      ))}
    </div>
  ),
}));
vi.mock('@/shared/pass-view/index.ts', () => ({
  normalize: (p: { generic: { primaryFields: { key: string }[] } }) => ({
    fields: p.generic.primaryFields.map((f) => f.key),
    layouts: { ios27: {} },
  }),
}));

const pass = (...keys: string[]) => ({
  generic: { primaryFields: keys.map((key) => ({ key, value: 'v' })) },
});

describe('part drop', () => {
  it('animates only a field that first appears after the first check', () => {
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const props = { assets: [], assetBase: '', checking: false };
    const { rerender } = render(<DesignerPreview {...props} passJson={pass('a')} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<DesignerPreview {...props} passJson={pass('a', 'b')} />);
    expect(animate).toHaveBeenCalledTimes(1);
  });
});
