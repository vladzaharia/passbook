import {
  ArchiveRestore,
  Ban,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  type LucideIcon,
  Mail,
  Monitor,
  Moon,
  Package,
  Pencil,
  PenTool,
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
  pushKey: KeyRound,
  void: Ban,
  unvoid: Undo2,
  /** Remove from Wallet, and its undo. */
  removeFromWallet: EyeOff,
  restoreToWallet: Eye,
  /** Bring back something archived or deleted (a template). */
  restore: ArchiveRestore,
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
  /** Open the visual designer: its own verb, not a field edit. */
  design: PenTool,
} as const satisfies Record<string, LucideIcon>;

export const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
