import { LogIn } from 'lucide-react';
import { Buddy } from './art/index.ts';
import { Button } from './button.tsx';
import { HostedCard, type HostedSize } from './hosted-card.tsx';

/** The `Signed out` card: the sad buddy and one action. */
export function SignedOutCard({
  onSignIn,
  leaving,
  size = 'dialog',
}: {
  onSignIn: () => void;
  leaving?: boolean;
  size?: HostedSize;
}) {
  return (
    <HostedCard
      size={size}
      state="signed-out"
      scene={<Buddy mood="sad" size="lg" at="end" />}
      title="Signed out"
    >
      <Button
        loading={leaving ?? false}
        iconStart={<LogIn aria-hidden />}
        className="w-full"
        onClick={onSignIn}
      >
        Sign in again
      </Button>
    </HostedCard>
  );
}
