export const AMR_LABEL: Record<string, string> = {
  oidc: 'Polaris ID',
  magic_link: 'Email link',
  breakglass: 'Break-glass',
};

export const ROLE_LABEL: Record<string, string> = { admin: 'Admin', user: 'User' };

export const amrLabel = (amr: string) => AMR_LABEL[amr] ?? amr;
export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

export const VERIFIED_VIA_LABEL: Record<string, string> = {
  magic_link: 'email link',
  oidc: 'Polaris ID',
  admin: 'an admin',
};
