import type { FakePocket } from '../polaris-binding/fake-pocket.ts';
import type { MockOidcUser } from './index.ts';

export interface SignupInput {
  /** The token value, as the signup link carries it: `/st/<token>`. */
  token: string;
  email: string;
  name?: string;
}

let made = 0;

/**
 * A person follows a Polaris ID signup link: the token is used up, the account is made in the token's groups with a
 * confirmed address (unless `verified` is false), and the audit row the binding's proof reads is written. The account can
 * then sign in through the mock OIDC provider.
 */
export function signUp(
  pocket: FakePocket,
  register: (sub: string) => MockOidcUser,
  input: SignupInput & { verified?: boolean },
): { sub: string } {
  const token = pocket.s.tokens.find((t) => t.value === input.token);
  if (!token) throw new Error('No such signup link.');
  const sub = `polaris-${Date.now().toString(36)}-${++made}`;
  pocket.signUp(token.id, sub);
  const account = pocket.s.users.get(sub);
  if (account) {
    account.email = input.email;
    account.displayName = input.name ?? input.email;
    account.emailVerified = input.verified !== false;
  }
  register(sub);
  return { sub };
}
