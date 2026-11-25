import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../lib/test-utils.tsx';
import { WizardReview } from './wizard-review.tsx';

describe('WizardReview', () => {
  it('offers Edit only on sections the scope does not fix', () => {
    render(
      <WizardReview
        onEdit={() => undefined}
        sections={[
          {
            id: 'org',
            title: 'Organization',
            edit: false,
            items: [{ label: 'Org', value: 'Acme' }],
          },
          { id: 'name', title: 'Name', items: [{ label: 'Name', value: 'CI' }] },
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit organization' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit name' })).toBeInTheDocument();
  });
});
