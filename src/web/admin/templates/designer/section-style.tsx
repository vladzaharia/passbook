import { PASS_STYLES, type PassStyle } from '@/passkit/types.ts';
import { SwitchRow } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { Group, PickEdit, TextEdit } from './controls.tsx';
import { dictOf, STYLE_LABEL, styleOf } from './model.ts';
import { hasPoster } from './ops-pass.ts';

const TRANSIT = [
  ['PKTransitTypeGeneric', 'Generic'],
  ['PKTransitTypeAir', 'Air'],
  ['PKTransitTypeTrain', 'Train'],
  ['PKTransitTypeBus', 'Bus'],
  ['PKTransitTypeBoat', 'Boat'],
] as const;

const POSTER_LABEL: Partial<Record<PassStyle, string>> = {
  eventTicket: 'Poster layout',
  boardingPass: 'Semantic layout',
};

export function StyleSection() {
  const { doc, edit } = useDesigner();
  const style = styleOf(doc.passJson);
  const poster = POSTER_LABEL[style];
  const text = (key: string) =>
    typeof doc.passJson[key] === 'string' ? (doc.passJson[key] as string) : '';
  return (
    <div className="grid gap-4">
      <PickEdit
        label="Style"
        value={style}
        options={PASS_STYLES.map((s) => ({ value: s, label: STYLE_LABEL[s] }))}
        onPick={(v) => edit({ op: 'style', style: v as PassStyle })}
        help="Switching keeps your fields. Fields the style cannot show move to the back."
      />
      {poster ? (
        <SwitchRow
          label={poster}
          help={
            style === 'eventTicket'
              ? 'Poster event ticket on iOS 18 and later.'
              : 'Semantic boarding pass on iOS 26 and later.'
          }
          checked={hasPoster(doc.passJson)}
          onCheckedChange={(on) => edit({ op: 'poster', on })}
        />
      ) : null}
      {style === 'boardingPass' ? (
        <PickEdit
          label="Transit type"
          value={String(dictOf(doc.passJson).transitType ?? 'PKTransitTypeGeneric')}
          options={TRANSIT.map(([value, label]) => ({ value, label }))}
          onPick={(v) => edit({ op: 'dict-prop', key: 'transitType', value: v })}
        />
      ) : null}
      <Group>
        <TextEdit
          label="Logo text"
          value={text('logoText')}
          merge="logoText"
          op={(v) => ({ op: 'pass-prop', key: 'logoText', value: v })}
          help="Shown beside the logo. Leave empty for none."
        />
        {style === 'eventTicket' && hasPoster(doc.passJson) ? (
          <TextEdit
            label="Poster logo text"
            value={text('eventLogoText')}
            merge="eventLogoText"
            op={(v) => ({ op: 'pass-prop', key: 'eventLogoText', value: v })}
          />
        ) : null}
        <TextEdit
          label="Description"
          value={text('description')}
          merge="description"
          op={(v) => ({ op: 'pass-prop', key: 'description', value: v })}
          help="Read aloud by VoiceOver."
        />
      </Group>
    </div>
  );
}
