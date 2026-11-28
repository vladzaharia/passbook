import { SCAN_TRAY_COPY as COPY } from '../../../shared/copy/scan-tray.ts';

export interface Approver {
  id: string;
  name: string;
  role?: string | undefined;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('');

/** "Maya Ruiz" -> "Maya R." */
export const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.at(-1);
  return last ? `${first} ${last[0]?.toUpperCase()}.` : (first ?? name);
};

export const roleLabel = (role: string | undefined) =>
  role === 'desk' ? COPY.pin.desk : COPY.pin.manager;

/** Slots for the digits keyed so far. The count is all the screen ever knows of a PIN. */
export function PinDots({
  count,
  length,
  shake,
  invalid,
  off = false,
}: {
  count: number;
  length: number;
  shake: number;
  invalid: boolean;
  /** Not taking digits (a lockout): drawn dimmed. */
  off?: boolean;
}) {
  return (
    <div
      // A new key restarts the shake each time a PIN is refused.
      key={shake}
      className="scan-pin-dots"
      data-shake={shake ? '' : undefined}
      data-invalid={invalid ? '' : undefined}
      data-off={off ? '' : undefined}
      role="img"
      aria-label={COPY.pin.dots.replace('{n}', String(count)).replace('{len}', String(length))}
    >
      {Array.from({ length }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a slot is its position
        <span key={i} data-filled={i < count ? '' : undefined} />
      ))}
    </div>
  );
}

export function Avatar({ name }: { name: string }) {
  return (
    <span className="scan-pin-avatar" aria-hidden>
      {initials(name)}
    </span>
  );
}

/** Who approves, with Change when more than one may. */
export function ManagerRow({
  manager,
  onChange,
  disabled,
}: {
  manager: Approver;
  onChange?: (() => void) | undefined;
  disabled: boolean;
}) {
  return (
    <div className="scan-pin-manager">
      <Avatar name={manager.name} />
      <div>
        <p className="scan-pin-name">{manager.name}</p>
        <p className="scan-pin-role">{roleLabel(manager.role)}</p>
      </div>
      {onChange ? (
        <button type="button" className="scan-pin-change" disabled={disabled} onClick={onChange}>
          {COPY.pin.change}
        </button>
      ) : null}
    </div>
  );
}

export function ManagerList({
  managers,
  value,
  onPick,
}: {
  managers: Approver[];
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <fieldset className="scan-pin-list" aria-label={COPY.pin.choose}>
      {managers.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={m.id === value}
          className="scan-pin-pick"
          onClick={() => onPick(m.id)}
        >
          <Avatar name={m.name} />
          <span>
            <span className="scan-pin-name">{m.name}</span>
            <span className="scan-pin-role">{roleLabel(m.role)}</span>
          </span>
        </button>
      ))}
    </fieldset>
  );
}
