import {
  Ban,
  Copy,
  Download,
  ExternalLink,
  LogOut,
  type LucideIcon,
  Mail,
  Monitor,
  Moon,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  Stethoscope,
  Sun,
  Trash2,
  Undo2,
  Upload,
  Zap,
} from 'lucide-react';

/** One glyph per action (docs/design/ui-consistency.md "Entity identity"). */
export const ACTION_ICON = {
  /** Pull from source, Sync now, Refresh (portal), Reload list. */
  refresh: RefreshCw,
  updateDevices: Send,
  sendEmail: Mail,
  test: Zap,
  recheck: Stethoscope,
  rotate: RotateCw,
  void: Ban,
  unvoid: Undo2,
  delete: Trash2,
  /** Revoke a session, sign out. */
  signOut: LogOut,
  download: Download,
  upload: Upload,
  openPublic: ExternalLink,
  create: Plus,
  /** Share passes as a bundle behind one link. */
  bundle: Package,
  duplicate: Copy,
  edit: Pencil,
} as const satisfies Record<string, LucideIcon>;

export const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
