import type { DesignerExtras } from '../../admin/templates/designer/host.tsx';
import { CodeTab } from './code-tab.tsx';
import { DataPanel } from './data-panel.tsx';
import { WalletPeek } from './peek.tsx';
import { DesignBar, DesignHead, DesignPhone } from './phone.tsx';

/** What the Workbench adds around the one designer core (design §1.8). Built once: hosts re-render on a new object. */
export const DESIGN_EXTRAS: DesignerExtras = {
  Panel: DataPanel,
  Code: CodeTab,
  Head: DesignHead,
  Phone: DesignPhone,
  PhoneBar: DesignBar,
  Peek: WalletPeek,
};
