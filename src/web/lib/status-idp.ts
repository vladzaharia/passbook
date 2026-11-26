import { CircleCheck, CirclePause, FlaskConical, Lock, Shield, Star, WifiOff } from 'lucide-react';

/** Polaris ID: how the binding changes access, and the kinds of group. */
export const IDP_STATUS = {
  idp_live: { label: 'Live', tone: 'success', icon: CircleCheck },
  idp_dry_run: {
    label: 'Dry run',
    tone: 'info',
    icon: FlaskConical,
    hint: 'Differences are recorded; nothing is sent.',
  },
  idp_paused: {
    label: 'Paused',
    tone: 'warning',
    icon: CirclePause,
    hint: 'No changes go to Polaris ID.',
  },
  idp_off: { label: 'Not connected', tone: 'neutral', icon: WifiOff },
  group_role: { label: 'Role', tone: 'neutral', icon: Shield },
  group_custom: { label: 'Custom', tone: 'accent', icon: Star },
  group_adopted: { label: 'Adopted', tone: 'neutral', icon: Lock },
} as const;
