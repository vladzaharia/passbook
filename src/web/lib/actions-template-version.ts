import { CircleCheck, type LucideIcon } from 'lucide-react';
import { ENTITY } from './entities.ts';
import type { Tone } from './status.ts';

const a = (label: string, icon: LucideIcon, tone: Tone) => ({ label, icon, tone });

/** A saved version and its review. */
export const TEMPLATE_VERSION_ACTIONS = {
  'template.version': a('Template version added', ENTITY.version.icon, 'info'),
  'template.review_requested': a('Template review requested', ENTITY.version.icon, 'info'),
  'template.review': a('Template version reviewed', CircleCheck, 'success'),
};
