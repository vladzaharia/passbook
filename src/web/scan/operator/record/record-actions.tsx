import {
  Camera,
  Check,
  Eye,
  Lock,
  LogOut,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { Button } from '../../../ui/button.tsx';
import { Kbd } from '../workspace/command-field.tsx';
import type { Act, Actions } from './record-model.ts';

const ICON: Record<Act['icon'], ReactNode> = {
  check: <Check aria-hidden />,
  family: <Users aria-hidden />,
  out: <LogOut aria-hidden />,
  shield: <ShieldCheck aria-hidden />,
  photo: <Camera aria-hidden />,
  value: <Sparkles aria-hidden />,
  again: <RotateCcw aria-hidden />,
  tap: <Zap aria-hidden />,
};
const KEY = { Enter: '↵', O: 'O', P: 'P' } as const;

function ActButton({
  act,
  primary,
  busy,
  onRun,
}: {
  act: Act;
  primary: boolean;
  busy: boolean;
  onRun: (act: Act) => void;
}) {
  const locked = act.lock === 'role' || act.lock === 'max';
  return (
    <Button
      variant={primary ? 'primary' : 'outline'}
      data-testid={`scan-action-${act.id}`}
      data-primary={primary || undefined}
      iconStart={locked ? <Lock aria-hidden /> : ICON[act.icon]}
      aria-disabled={locked || busy || undefined}
      aria-keyshortcuts={act.key === 'Enter' ? 'Enter' : act.key}
      onClick={() => {
        if (!locked && !busy) onRun(act);
      }}
    >
      {act.label}
      {act.key ? (
        <span className="op-keycap" aria-hidden>
          <Kbd>{KEY[act.key]}</Kbd>
        </span>
      ) : null}
    </Button>
  );
}

/** The primary first and filled, then up to three more. Locked ones keep their place. */
export function RecordActions({
  actions,
  busy,
  onRun,
}: {
  actions: Actions;
  busy: boolean;
  onRun: (act: Act) => void;
}) {
  if (actions.viewOnly)
    return (
      <div className="op-actions" data-testid="scan-view-only">
        <p className="op-actions-note">
          <Eye aria-hidden /> {OPERATOR_COPY.record.viewOnly}
        </p>
      </div>
    );
  if (!actions.primary && actions.others.length === 0) return null;
  return (
    <div className="op-actions">
      {actions.primary ? (
        <ActButton act={actions.primary} primary busy={busy} onRun={onRun} />
      ) : null}
      {actions.others.map((act) => (
        <ActButton key={act.id} act={act} primary={false} busy={busy} onRun={onRun} />
      ))}
      {actions.reason ? <p className="op-actions-reason">{actions.reason}</p> : null}
    </div>
  );
}
