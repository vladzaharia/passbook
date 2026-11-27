import { CircleCheck, type LucideIcon, Pause, RotateCcw, Trash2, Unlock } from 'lucide-react';
import { CLI_ACTIONS } from './actions-cli.ts';
import { DEV_ACCESS_ACTIONS } from './actions-dev-access.ts';
import { DEVICE_PASS_ACTIONS } from './actions-device-pass.ts';
import { OPERATION_ACTIONS } from './actions-operations.ts';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** Developer sandbox events and the public status incident notes (platform admin writes). */
export const DEVELOPER_ACTIONS = {
  'status.incident.open': a('Incident note opened', Pause, 'warning'),
  'status.incident.resolve': a('Incident note resolved', CircleCheck, 'success'),
  'developer_sandbox.close': a('Developer sandbox closed', Pause, 'warning'),
  'developer_sandbox.delete': a('Developer sandbox deleted', Trash2, 'danger'),
  'developer_sandbox.create': a('Developer sandbox made', ENTITY.org.icon, 'success'),
  'developer_sandbox.reopen': a('Developer sandbox reopened', Unlock, 'success'),
  'developer_sandbox.reset': a('Developer sandbox reset', RotateCcw, 'warning'),
  'developer_sandbox.try_revoke': a('Try it sessions ended', ENTITY.apiKey.icon, 'warning'),
  ...CLI_ACTIONS,
  ...DEV_ACCESS_ACTIONS,
  ...DEVICE_PASS_ACTIONS,
  ...OPERATION_ACTIONS,
};
