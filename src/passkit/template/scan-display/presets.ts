import type { ScanPresetId } from '../../types.ts';
import { access, offer, ticket } from './presets-event.ts';
import type { Preset } from './presets-kit.ts';
import { balance, loyalty, membership } from './presets-people.ts';
import { details, note } from './presets-text.ts';

export {
  autoMap,
  type Preset,
  type PresetEnv,
  type PresetMapping,
  type PresetSlot,
  slotsFound,
} from './presets-kit.ts';

/** The eight cards (DM 1.7). Each `build` writes ordinary rows; none writes a control or a refusal. */
export const PRESETS: Record<ScanPresetId, Preset> = {
  membership,
  loyalty,
  balance,
  ticket,
  offer,
  access,
  details,
  note,
};

export const PRESET_ORDER: ScanPresetId[] = [
  'membership',
  'loyalty',
  'balance',
  'ticket',
  'offer',
  'access',
  'details',
  'note',
];
