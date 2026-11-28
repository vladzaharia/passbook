import {
  Archive,
  BookOpen,
  Building2,
  DoorOpen,
  FileSpreadsheet,
  FlaskConical,
  Layers,
  type LucideIcon,
  Nfc,
  PackageCheck,
  PenLine,
  Plug,
  Puzzle,
  Rocket,
  ScanLine,
  ShoppingCart,
  Wand2,
  Webhook,
} from 'lucide-react';

/** One icon per guide, chosen for what the guide does. */
export const GUIDE_ICONS: Record<string, LucideIcon> = {
  'org-setup': Building2,
  'release-a-template': PackageCheck,
  'test-mode': FlaskConical,
  'issue-on-purchase': ShoppingCart,
  'bulk-import': FileSpreadsheet,
  'import-auto-map': Wand2,
  'update-a-pass': PenLine,
  'change-many-passes': Layers,
  'pass-lifecycle': Archive,
  'scan-setup': ScanLine,
  'check-in-at-the-door': DoorOpen,
  nfc: Nfc,
  'react-to-events': Webhook,
  'set-up-a-webhook-source': Plug,
  'partner-apps': Puzzle,
  'go-live': Rocket,
};

export const guideIcon = (id: string): LucideIcon => GUIDE_ICONS[id] ?? BookOpen;
