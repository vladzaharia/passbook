/** Badge and credential: who the holder is, what they may do and until when. A photo leads both. */
import { type Kinded, type KindParts, when } from './paper-kinds-base.ts';

export function idParts(c: Kinded, parts: KindParts): void {
  const { info } = parts;
  const set = (key: keyof typeof info, v: string | undefined) => {
    if (v) info[key] = v;
  };
  if (c.kind === 'credential') {
    // The number prints only when the template declares its lookup public (the guard in `field`).
    const name = c.field('credential', 'certificate', 'licence', 'license');
    parts.title = name ?? parts.holder;
    set('credential', name);
    set('number', c.field('number', 'licenceNo', 'certificateNo'));
    set('issued', when(c, undefined, 'issued', 'issuedOn', 'issuedAt'));
    return;
  }
  parts.title = parts.holder;
  set('team', c.field('team', 'department', 'role', 'unit'));
  set('host', c.field('host', 'sponsor', 'guestOf'));
  set('company', c.field('company', 'organization', 'organisation'));
  set('goTo', c.field('where', 'goTo', 'floor'));
  set('zone', c.field('zone', 'zones', 'area'));
}
