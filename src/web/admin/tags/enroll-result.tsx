import { Shield, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Tag } from '@/shared/contracts/nfc-tags.ts';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { Badge, FormField, Input } from '@/web/ui/index.ts';
import { DoneTile, EnrollArt } from './enroll-art.tsx';
import { TagCode } from './tag-code.tsx';
import { tagName, worksWithLabel } from './words.ts';

const K = TAG_COPY.kind;

export function KindPill({ assurance }: { assurance: Tag['assurance'] }) {
  return assurance === 'secure' ? (
    <Badge tone="success">
      <ShieldCheck aria-hidden />
      {K.secure}
    </Badge>
  ) : (
    <Badge title={TAG_COPY.basicTip} aria-description={TAG_COPY.basicTip}>
      <Shield aria-hidden />
      {K.basic}
    </Badge>
  );
}

/** Tag assigned: the card with its kind and what it works with, and an optional name. */
export function ResultFace({
  tag,
  name,
  onName,
}: {
  tag: Tag;
  name: string;
  onName: (value: string) => void;
}) {
  const [touched, setTouched] = useState(false);
  const value = touched ? name : (tag.label ?? '');
  return (
    <div className="wl-enroll-face flex flex-col gap-4">
      <EnrollArt stage="done" />
      <div className="flex flex-col items-center gap-2 text-center">
        <DoneTile />
        <p role="status" className="text-base font-medium text-fg-strong">
          {TAG_COPY.dialog.done}
        </p>
        <p className="flex flex-wrap items-center justify-center gap-2 text-sm text-fg">
          <span>{tagName(tag)}</span>
          <TagCode hint={tag.hint} className="text-fg-muted" />
          <KindPill assurance={tag.assurance} />
        </p>
        {tag.binding ? (
          <p className="text-sm text-fg-muted">{worksWithLabel(tag.binding)}</p>
        ) : null}
      </div>
      <FormField label="Name">
        {(p) => (
          <Input
            {...p}
            data-autofocus
            value={value}
            maxLength={40}
            onChange={(e) => {
              setTouched(true);
              onName(e.target.value);
            }}
          />
        )}
      </FormField>
    </div>
  );
}
