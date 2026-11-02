import { createElement, type ReactNode } from 'react';
import { ActivityArt } from './activity.tsx';
import type { ArtProps } from './base.tsx';
import { BuildingArt } from './building.tsx';
import { CertificateArt } from './certificate.tsx';
import { EnvelopeArt } from './envelope.tsx';
import { FramesArt } from './frames.tsx';
import type { ArtName, EntityArtProps } from './index.ts';
import { KeyArt } from './key.tsx';
import { LayersArt } from './layers.tsx';
import { LensArt } from './lens.tsx';
import { LockArt } from './lock.tsx';
import { LogArt } from './log.tsx';
import { MappingArt } from './mapping.tsx';
import { PassesArt } from './passes.tsx';
import { PeopleArt } from './people.tsx';
import { PhoneArt } from './phone.tsx';
import { PlugsArt } from './plugs.tsx';
import { PulseArt } from './pulse.tsx';
import { RunsArt } from './runs.tsx';
import { TemplateArt } from './template.tsx';
import { TornArt } from './torn.tsx';
import { UnpluggedArt } from './unplugged.tsx';
import { WalletArt } from './wallet.tsx';

/** Every entity art by name; loaded beside the app (index.ts), not in its first chunk. */
export const ART = {
  passes: PassesArt,
  template: TemplateArt,
  plugs: PlugsArt,
  people: PeopleArt,
  building: BuildingArt,
  certificate: CertificateArt,
  key: KeyArt,
  log: LogArt,
  activity: ActivityArt,
  pulse: PulseArt,
  runs: RunsArt,
  phone: PhoneArt,
  envelope: EnvelopeArt,
  frames: FramesArt,
  layers: LayersArt,
  mapping: MappingArt,
  lens: LensArt,
  torn: TornArt,
  lock: LockArt,
  unplugged: UnpluggedArt,
  wallet: WalletArt,
} as const satisfies Record<ArtName, (props: ArtProps) => unknown>;

export function RegisteredArt({ name, ...props }: EntityArtProps): ReactNode {
  return createElement(ART[name] as (p: Omit<EntityArtProps, 'name'>) => ReactNode, props);
}
