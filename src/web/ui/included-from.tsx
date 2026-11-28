import { Link } from '@tanstack/react-router';
import { ArrowUpRight, Zap } from 'lucide-react';
import { StateArt } from './art/state-art.tsx';
import { Button } from './button.tsx';
import { StateView } from './state-view.tsx';

export interface IncludedFromProps {
  /** The first plan that includes the feature: its preset id (plan-icons) and name. */
  plan: { id: string; name: string };
  /** One line on what the feature does. */
  line: string;
  /** `billing:manage`. Without it the only action is Compare plans. */
  canManage: boolean;
  /** The Plan page, where Compare plans and (until the preset wizard) Upgrade lead. */
  planHref: string;
  /** The preset wizard; absent, Upgrade links to the Plan page. */
  onUpgrade?: () => void;
  autoUpEligible?: boolean;
  onAutoUp?: () => void;
  /** Where the plan sells an add-on for the feature: `Add Kiosk for $19 a month`. */
  addOn?: { label: string; onAdd: () => void };
}

/**
 * The one page for a plan-gated feature (billing 5b): the plan's ticket rises, `Included from
 * {Plan}`, one line, then the actions. No locks on controls. Add-on first where one exists, else
 * Upgrade; `Turn on AutoUp` when offered; Compare plans only, without billing rights.
 */
export function IncludedFromView({
  plan,
  line,
  canManage,
  planHref,
  onUpgrade,
  autoUpEligible = false,
  onAutoUp,
  addOn,
}: IncludedFromProps) {
  const upgradeLabel = `Upgrade to ${plan.name}`;
  const upgradeVariant = addOn ? 'outline' : 'primary';
  const upgrade = onUpgrade ? (
    <Button variant={upgradeVariant} onClick={onUpgrade}>
      <ArrowUpRight aria-hidden />
      {upgradeLabel}
    </Button>
  ) : (
    <Button variant={upgradeVariant} asChild>
      <Link to={planHref}>
        <ArrowUpRight aria-hidden />
        {upgradeLabel}
      </Link>
    </Button>
  );
  const compare = (
    <Button variant={canManage ? 'ghost' : 'outline'} asChild>
      <Link to={planHref}>Compare plans</Link>
    </Button>
  );
  return (
    <StateView
      size="stage"
      state="empty"
      heading
      mood="curious"
      picture={<StateArt name="plan-ticket" plan={plan.id} size="sm" />}
      title={`Included from ${plan.name}`}
      line={line}
      action={
        canManage ? addOn ? <Button onClick={addOn.onAdd}>{addOn.label}</Button> : upgrade : compare
      }
      secondary={
        canManage ? (
          <>
            {addOn ? upgrade : null}
            {autoUpEligible ? (
              <Button variant="ghost" onClick={onAutoUp}>
                <Zap aria-hidden />
                Turn on AutoUp
              </Button>
            ) : null}
            {compare}
          </>
        ) : null
      }
    />
  );
}
