import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { ROLE_BLURBS } from '@/shared/copy/org-roles.ts';
import { toggleRole } from './org-roles.ts';
import { RolePicker } from './role-picker.tsx';

function Harness({ start = [] as OrgRole[] }) {
  const [roles, setRoles] = useState<OrgRole[]>(start);
  return <RolePicker roles={roles} onChange={setRoles} />;
}

describe('toggleRole', () => {
  it('lets Organization admin replace the rest and Read only stand alone', () => {
    expect(toggleRole(['template_author'], 'org_admin', true)).toEqual(['org_admin']);
    expect(toggleRole(['pass_operator'], 'read_only', true)).toEqual(['read_only']);
    expect(toggleRole(['pass_operator'], 'template_author', true)).toEqual([
      'pass_operator',
      'template_author',
    ]);
    expect(toggleRole(['org_admin'], 'org_admin', false)).toEqual([]);
  });
});

describe('RolePicker', () => {
  it('shows each role with its line from the role definitions', () => {
    render(<Harness />);
    for (const blurb of Object.values(ROLE_BLURBS)) {
      expect(screen.getByText(blurb)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(7);
  });

  it.each([
    ['Organization admin', 'Organization admin covers every role.'],
    ['Read only', 'Read only cannot combine with other roles.'],
  ])('greys out the other roles when %s is picked', async (name, note) => {
    render(<Harness />);
    await userEvent.setup().click(screen.getByRole('checkbox', { name }));
    expect(screen.getByRole('checkbox', { name })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Pass operator' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(note);
    await userEvent.setup().click(screen.getByRole('checkbox', { name }));
    expect(screen.getByRole('checkbox', { name: 'Pass operator' })).toBeEnabled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('picking Organization admin clears the roles already chosen', async () => {
    render(<Harness start={['pass_operator', 'template_author']} />);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Organization admin' }));
    expect(screen.getByRole('checkbox', { name: 'Pass operator' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Organization admin' })).toBeChecked();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness start={['org_admin']} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
