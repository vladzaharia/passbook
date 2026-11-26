import { lazy, Suspense, useState } from 'react';
import { type ContextSwitcherProps, SWITCHER_TRIGGER, SwitcherFace } from './switcher-face.tsx';

// The menu's Radix chunks load after the shell paints (WB_SHELL_BUDGET); a click before they
// arrive opens the menu on load.
const Menu = lazy(() => import('./context-menu.tsx').then((m) => ({ default: m.ContextMenu })));

/**
 * The context switcher at the top of the sidebar and the sheet (design §2.1): the sandbox pinned
 * first, then orgs (the menu's own type-ahead finds one), then the ways out. Switching keeps the
 * area when the new context has it, else Home, drops the selection, and says where you are now.
 */
export function ContextSwitcher(props: ContextSwitcherProps) {
  const [asked, setAsked] = useState(false);
  return (
    <Suspense
      fallback={
        <button
          type="button"
          aria-haspopup="menu"
          className={SWITCHER_TRIGGER}
          onClick={() => setAsked(true)}
        >
          <SwitcherFace context={props.context} />
        </button>
      }
    >
      <Menu {...props} defaultOpen={asked} />
    </Suspense>
  );
}
