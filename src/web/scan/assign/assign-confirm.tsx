import { Info, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { formatShortDate } from '../../lib/format.ts';
import { RadioGroup } from '../../ui/radio-group.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import type { AssignState } from '../machine/assign-state.ts';
import { ApprovalSheet } from '../result/approval-sheet.tsx';
import { fill } from '../ui/copy.ts';
import { Identity } from './assign-steps.tsx';
import { TAG_EXTRA_COPY } from './copy.ts';
import { TagChip } from './tag-chip.tsx';

/** The one line under the choice, in the order UX 3.2 gives: moves, another person's, basic. */
export function infoLine(a: AssignState): { tone: 'info' | 'warn' | 'muted'; text: string } | null {
  const w = a.preview?.warnings ?? [];
  const name = a.preview?.card.holderName ?? a.preview?.card.title ?? '';
  const bound = a.inspected?.bound;
  if (w.includes('held_by_other'))
    return {
      tone: 'warn',
      text: bound?.holderName
        ? fill(SCAN_TAG_COPY.confirm.moveOther, {
            holder: bound.holderName,
            pass: bound.passTitle || 'pass',
            name,
          })
        : fill(SCAN_TAG_COPY.confirm.moveOtherPass, {
            pass: bound?.passTitle || 'another pass',
            name,
          }),
    };
  if (w.includes('lost'))
    return {
      tone: 'warn',
      text: a.preview?.lostAt
        ? fill(TAG_EXTRA_COPY.lostWarn, { date: formatShortDate(a.preview.lostAt) })
        : 'Reported lost.',
    };
  if (w.includes('replaces_user_tag'))
    return { tone: 'info', text: fill(SCAN_TAG_COPY.confirm.moveOwn[1], { name }) };
  if (w.includes('replaces_pass_tag'))
    return {
      tone: 'info',
      text: fill(SCAN_TAG_COPY.confirm.moveOwn[0], {
        pass: bound?.passTitle ?? a.preview?.card.title ?? '',
      }),
    };
  if (w.includes('basic_too_low')) return { tone: 'warn', text: TAG_EXTRA_COPY.basicLow };
  if (a.preview?.assurance === 'basic') return { tone: 'muted', text: SCAN_TAG_COPY.confirm.basic };
  return null;
}

/** What the Manager approves: a move says whose tag it takes, otherwise the assign. */
function pinLine(a: AssignState, name: string): string {
  if (!a.pin?.move) return fill(SCAN_TAG_COPY.confirm.pinAssign, { name });
  // Lost only when the preview or the earlier check says so: a blank holder is not a lost tag
  // (another template's pass is blanked, and a tag new at the read may be held at the bind).
  const lost = a.preview?.warnings.includes('lost') || a.inspected?.state === 'lost';
  if (lost) return fill(SCAN_TAG_COPY.confirm.pinMoveLost, { to: name });
  const from = a.inspected?.bound?.holderName || a.inspected?.bound?.passTitle || null;
  return from
    ? fill(SCAN_TAG_COPY.confirm.pinMove, { from, to: name })
    : fill(SCAN_TAG_COPY.confirm.pinMoveOther, { to: name });
}

export function ConfirmBody({
  a,
  manager,
  managers,
  code,
  on,
}: {
  a: AssignState;
  manager: boolean;
  managers: { id: string; name: string }[];
  code: boolean;
  on: {
    scope(scope: 'pass' | 'user'): void;
    label(label: string): void;
    approve(staffId: string | undefined, pin: string): void;
    closePin(): void;
  };
}) {
  const p = a.preview;
  const [form, setForm] = useState<string | null>(null);
  const fieldId = useId();
  if (!p) return null;
  const name = p.card.holderName ?? p.card.title;
  const info = infoLine(a);
  const choose = p.ownerAccount && !a.request;
  return (
    <>
      <Identity name={name} meta={p.card.templateName} photoUrl={p.card.photoUrl} heading />
      <div className="scan-assign-link">
        <TagChip hint={p.hint} assurance={p.assurance} />
      </div>
      {choose ? (
        <RadioGroup
          legend={SCAN_TAG_COPY.worksWith.label}
          value={a.scope}
          onValueChange={(v) => on.scope(v as 'pass' | 'user')}
          options={[
            {
              value: 'user',
              label: fill(SCAN_TAG_COPY.worksWith.person, { name }),
              hint: a.scope === 'user' ? fill(SCAN_TAG_COPY.worksWith.future, { name }) : undefined,
            },
            { value: 'pass', label: SCAN_TAG_COPY.worksWith.pass, hint: p.card.title },
          ]}
        />
      ) : (
        <p className="scan-assign-opens">
          <span className="scan-assign-opens-label">{SCAN_TAG_COPY.worksWith.label}</span>
          {p.ownerAccount ? SCAN_TAG_COPY.worksWith.pass : SCAN_TAG_COPY.worksWith.noAccount}
          {!p.ownerAccount ? (
            <span className="scan-identity-meta">
              {fill(SCAN_TAG_COPY.worksWith.noAccountSub, { name })}
            </span>
          ) : null}
        </p>
      )}
      <label className="scan-assign-field" htmlFor={fieldId}>
        <span>{SCAN_TAG_COPY.confirm.name}</span>
        <ScanTextField
          id={fieldId}
          value={a.label}
          maxLength={24}
          placeholder={SCAN_TAG_COPY.confirm.namePlaceholder}
          autoComplete="off"
          onValueRestore={on.label}
          onChange={(e) => {
            setForm(null);
            on.label(e.target.value);
          }}
        />
      </label>
      <fieldset className="scan-assign-forms">
        <legend className="sr-only">Kind</legend>
        {SCAN_TAG_COPY.confirm.forms.map((f) => (
          <button
            key={f}
            type="button"
            className="scan-assign-form"
            aria-pressed={form === f}
            onClick={() => {
              setForm(form === f ? null : f);
              on.label(form === f ? '' : f);
            }}
          >
            {f}
          </button>
        ))}
      </fieldset>
      {info ? (
        <p className="scan-assign-info" data-tone={info.tone} data-testid="scan-assign-info">
          {info.tone === 'warn' ? (
            <TriangleAlert aria-hidden size={16} />
          ) : (
            <Info aria-hidden size={16} />
          )}
          {info.text}
        </p>
      ) : null}
      {a.pin?.open && !manager ? (
        <ApprovalSheet
          managers={managers}
          code={code}
          action={pinLine(a, name)}
          note={a.pin.note}
          onApprove={on.approve}
          onCancel={on.closePin}
        />
      ) : null}
    </>
  );
}
