import { KeyRound } from 'lucide-react';
import { POLARIS_ID_COPY } from '@/shared/copy/sign-in.ts';
import { Button } from '../button.tsx';
import { StateView } from '../state-view.tsx';

/** What an email-link session sees at Admin: the way in through Polaris ID, not the console. */
export function PolarisIdRequired({ space, next }: { space: string; next: string }) {
  return (
    <StateView
      size="stage"
      state="no-access"
      art="lock"
      heading
      title={POLARIS_ID_COPY.needs(space)}
      action={
        <Button asChild variant="outline" iconStart={<KeyRound aria-hidden />}>
          <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>{POLARIS_ID_COPY.signIn}</a>
        </Button>
      }
    />
  );
}
