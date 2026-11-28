import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { SegmentedControl, Select } from '../../../ui/index.ts';
import type { Selection } from './model.ts';
import type { Action } from './reducer.ts';
import type { WalletName } from './wallets/roles-model.ts';

export type DesignerMode = 'pass' | 'scan' | 'wallets';

const PASS_MODE = { value: 'pass', label: 'Pass' } as const;
const SCAN_MODE = { value: 'scan', label: 'Scan screen' } as const;
const WALLETS_MODE = { value: 'wallets', label: 'Wallets' } as const;

/** The mode a selection belongs to: the scan screen, the Wallets tab, or the pass itself. */
export const modeOfSection = (section: Selection['section']): DesignerMode =>
  section === 'scan-display' ? 'scan' : section.startsWith('wallets-') ? 'wallets' : 'pass';

const DEFAULT_SELECT: Record<DesignerMode, Selection> = {
  pass: { section: 'style' },
  scan: { section: 'scan-display' },
  wallets: { section: 'none' },
};

/**
 * The designer's modes and where each one left its selection. Wallets is listed only for wallets
 * the organization can use (`wallets`: null while that is unknown, empty when none).
 */
export function useDesignerModes({
  select,
  dispatch,
  root,
  wallets,
  initial,
  onView,
}: {
  select: Selection;
  dispatch: (action: Action) => void;
  root: RefObject<HTMLElement | null>;
  wallets: readonly WalletName[] | null;
  initial: { mode?: DesignerMode | undefined; wallet?: WalletName | undefined };
  /** Called when the mode or the focused wallet changes, so the page can keep its address. */
  onView?: ((mode: DesignerMode, wallet: WalletName | undefined) => void) | undefined;
}) {
  const [asked, setAsked] = useState<DesignerMode>(initial.mode ?? 'pass');
  const [picked, setPicked] = useState<WalletName | undefined>(initial.wallet);
  const selections = useRef<Record<DesignerMode, Selection>>({ ...DEFAULT_SELECT, pass: select });
  const usable = wallets === null || wallets.length > 0;
  const mode = asked === 'wallets' && !usable ? 'pass' : asked;
  selections.current[mode] = select;
  const wallet = picked && wallets?.includes(picked) ? picked : wallets?.[0];

  const changeMode = useCallback(
    (next: DesignerMode) => {
      if (next === mode) return;
      dispatch({ type: 'select', select: selections.current[next] });
      setAsked(next);
    },
    [mode, dispatch],
  );
  const focusTarget = useCallback(
    (s: Selection) => {
      const target = modeOfSection(s.section);
      if (target !== mode) setAsked(target);
      const named = /^(google|samsung):/.exec(s.key ?? '')?.[1] as WalletName | undefined;
      if (named) setPicked(named);
      dispatch({ type: 'select', select: s });
      const id = s.key ? `${s.section}:${s.key}` : s.section;
      // The section opens on the next render; focus what the issue names once it exists.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          root.current?.querySelector<HTMLElement>(`[data-target="${CSS.escape(id)}"]`)?.focus(),
        ),
      );
    },
    [mode, dispatch, root],
  );
  const report = useRef(onView);
  report.current = onView;
  useEffect(() => report.current?.(mode, wallet), [mode, wallet]);

  const openWallets = useCallback((target: WalletName) => {
    setPicked(target);
    setAsked('wallets');
  }, []);
  const options = useMemo(
    () => [PASS_MODE, SCAN_MODE, ...(usable ? [WALLETS_MODE] : [])],
    [usable],
  );
  return {
    mode,
    setMode: setAsked,
    changeMode,
    focusTarget,
    wallet,
    setWallet: setPicked,
    openWallets,
    options,
  };
}

export function ModeSwitch({
  mode,
  options,
  onChange,
  compact = false,
}: {
  compact?: boolean;
  mode: DesignerMode;
  options: readonly { value: DesignerMode; label: string }[];
  onChange: (mode: DesignerMode) => void;
}) {
  const phone = useMediaQuery(PHONE);
  if (phone)
    return (
      <div className={compact ? 'min-w-0 flex-1' : 'mb-4'}>
        <Select
          aria-label="Designer mode"
          className="w-full"
          options={options}
          value={mode}
          onValueChange={(v) => onChange(v as DesignerMode)}
        />
      </div>
    );
  return (
    <div className={compact ? 'mb-2' : 'mb-4'}>
      <SegmentedControl
        label="Designer mode"
        options={options}
        value={mode}
        onValueChange={onChange}
      />
    </div>
  );
}
