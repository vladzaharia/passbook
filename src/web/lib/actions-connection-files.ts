import { CircleCheck, type LucideIcon } from 'lucide-react';
import { ACTION_ICON } from './action-icons.ts';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Files behind a file-upload connection. */
export const CONNECTION_FILE_ACTIONS = {
  'connection.file_apply': a('File applied', CircleCheck, 'success'),
  'connection.file_discard': a('File discarded', ACTION_ICON.delete, 'warning'),
  'connection.file_upload': a('File uploaded', ENTITY.connection.icon, 'info'),
};
