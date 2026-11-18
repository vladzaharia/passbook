import { Check, Nfc, Ticket, User } from 'lucide-react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import type { AssignState } from '../machine/assign-state.ts';
import { fill } from '../ui/copy.ts';

const STEPS = [
  { key: 'tag', label: SCAN_TAG_COPY.step.tag },
  { key: 'pass', label: SCAN_TAG_COPY.step.pass },
] as const;

/** `① Tag ── ② Pass`: a done step shows a check, the current one is accent, the next muted. */
export function StepHeader({ a }: { a: AssignState }) {
  // A known pass skips step 2: the header is just the tag step.
  const known = a.source === 'card' || a.source === 'request';
  const order = a.step === 'tag' || a.step === 'error' ? 0 : a.step === 'pass' ? 1 : 2;
  const steps = known ? STEPS.slice(0, 1) : STEPS;
  return (
    <ol className="scan-assign-steps" aria-label="Steps">
      {steps.map((step, i) => {
        const state = i < order ? 'done' : i === order ? 'on' : 'next';
        return (
          <li
            key={step.key}
            className="scan-assign-step"
            data-state={state}
            aria-current={state === 'on' ? 'step' : undefined}
          >
            <span className="scan-assign-step-n" aria-hidden>
              {state === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}
            </span>
            {step.label}
            {i < steps.length - 1 ? <span aria-hidden className="scan-assign-step-line" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Initials in a tile for a person with no photo. */
export function Initials({ name, label }: { name: string; label?: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <span className="scan-assign-initials" aria-hidden={label ? undefined : true}>
      {letters || <User size={22} aria-hidden />}
      {label ? <span className="scan-assign-initials-note">{label}</span> : null}
    </span>
  );
}

export function Identity({
  name,
  meta,
  tile,
}: {
  name: string;
  meta?: string | null;
  tile?: 'person' | 'pass';
}) {
  return (
    <div className="scan-identity scan-assign-identity">
      {tile === 'pass' ? (
        <span className="scan-pass-tile" aria-hidden>
          <Ticket size={22} />
        </span>
      ) : (
        <Initials name={name} />
      )}
      <div className="scan-identity-text">
        <p className="scan-result-holder" dir="auto">
          {name}
        </p>
        {meta ? <p className="scan-identity-meta">{meta}</p> : null}
      </div>
    </div>
  );
}

/** Which of the person's passes the tag will open. Read-only on an admin's request. */
export function OpensLine({ scope, name }: { scope: 'pass' | 'user'; name: string }) {
  const Icon = scope === 'user' ? User : Ticket;
  return (
    <p className="scan-assign-opens" data-testid="scan-assign-opens">
      <Icon aria-hidden size={16} />
      {scope === 'user'
        ? fill(SCAN_TAG_COPY.worksWith.resultPerson, { name })
        : SCAN_TAG_COPY.worksWith.resultPass}
    </p>
  );
}

export const TagGlyph = Nfc;
