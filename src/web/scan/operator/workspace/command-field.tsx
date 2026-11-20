import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { ScanTextField } from '../../input/wedge-field.tsx';
import { RESULT_LIST_ID } from '../lists/search-results.tsx';

const C = OPERATOR_COPY;

export type Readiness = 'ready' | 'paused' | 'offline';

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="op-kbd">{children}</kbd>;
}

/** The one input: names, emails and codes. A scan lands here from anywhere; it never types in. */
export function CommandField({
  value,
  onChange,
  readiness,
  allowPeople,
  searching,
  activeId,
}: {
  value: string;
  onChange: (value: string) => void;
  readiness: Readiness;
  allowPeople: boolean;
  searching: boolean;
  activeId: string | undefined;
}) {
  const offline = readiness === 'offline';
  const line = offline
    ? C.ready.offline
    : readiness === 'paused'
      ? C.ready.paused
      : C.ready.anywhere;
  return (
    <search className="op-command" aria-label={C.landmark.search}>
      <div className="op-field" data-filled={value ? '' : undefined}>
        <Search aria-hidden />
        <ScanTextField
          data-scan-code
          data-operator-search
          role="combobox"
          aria-label={C.field.label}
          aria-expanded={searching}
          aria-controls={searching ? RESULT_LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-keyshortcuts="/ Meta+K Control+K"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={1024}
          placeholder={offline ? C.field.offline : allowPeople ? C.field.placeholder : 'Code'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onValueRestore={onChange}
        />
        <span className="op-field-key" aria-hidden>
          <Kbd>{value ? 'Esc' : '/'}</Kbd>
        </span>
      </div>
      <p className="op-ready" data-state={readiness}>
        <span className="op-ready-live">
          <span className="op-pulse" aria-hidden />
          {offline ? C.status.offline : C.ready.line}
        </span>
        <span>
          {value && !offline ? C.ready.move.replace('{keys}', '↑↓').replace('{open}', '↵') : line}
        </span>
      </p>
    </search>
  );
}
