import { BUNDLE_MAX_PASSES } from '@/shared/contracts/bundles.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { DropdownMenuItem } from '../../ui/index.ts';

interface Action {
  disabled: boolean;
  onSelect: () => void;
}

const SHARE_HINT = `Up to ${BUNDLE_MAX_PASSES} passes of one organization.`;

/** Send email and Share as bundle, in More on a phone so the bar stays one row. */
export function PhoneActions({ email, share }: { email: Action; share: Action }) {
  return (
    <>
      <DropdownMenuItem disabled={email.disabled} onSelect={email.onSelect}>
        <ACTION_ICON.sendEmail aria-hidden />
        Send email
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={share.disabled}
        title={share.disabled ? SHARE_HINT : undefined}
        onSelect={share.onSelect}
      >
        <ACTION_ICON.bundle aria-hidden />
        Share as bundle
      </DropdownMenuItem>
    </>
  );
}
