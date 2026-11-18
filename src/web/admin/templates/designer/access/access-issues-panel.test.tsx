import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { TooltipProvider } from '../../../../ui/index.ts';
import { applyOp } from '../apply.ts';
import { DesignerProvider } from '../context.tsx';
import { sampleDoc } from '../fixtures.ts';
import { Issues } from '../issues.tsx';
import { initialState } from '../reducer.ts';

describe('Issues for the Access section', () => {
  it('names the section, not the internal plan id', () => {
    const doc = applyOp(sampleDoc(), { op: 'access-enable' });
    render(
      <DesignerProvider
        value={{
          state: initialState(doc),
          doc,
          edit: () => {},
          select: () => {},
          focusTarget: () => {},
          dispatch: () => {},
          assetBase: '/assets',
          readOnly: false,
          stamps: { count: 4, setCount: () => {} },
        }}
      >
        <TooltipProvider>
          <Issues
            checking={false}
            issues={[
              {
                severity: 'error',
                code: 'ACCESS_ZONES_EMPTY',
                message: 'Member has no zones.',
                path: 'scan.access.plans[0].zones',
              },
            ]}
          />
        </TooltipProvider>
      </DesignerProvider>,
    );
    expect(screen.getByText('Member has no zones.')).toBeInTheDocument();
    expect(screen.getByText('Access')).toBeInTheDocument();
    expect(screen.queryByText(/Access: /)).not.toBeInTheDocument();
  });
});
