import { Building2, LayoutTemplate, Lock, Sparkles } from 'lucide-react';
import type { ChainLevel } from '@/shared/contracts/channels.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { Badge } from '@/web/ui/index.ts';

type Kind = 'placeholder' | 'default' | 'passbook';
const WORDS = PASS_SETUP_COPY.sourceTags;

/**
 * Who set a value: neutral, never accent (ui-consistency: accent is selection, not origin). Where
 * PassBook's value shows through, `kind` says whether it is a placeholder, a default or PassBook's own.
 */
export function SourceTag({
  source,
  kind = 'default',
  templatesOwn = 0,
  label,
}: {
  source: ChainLevel;
  kind?: Kind;
  templatesOwn?: number;
  /** Replaces the words: "From logo". */
  label?: string;
}) {
  const s = PASS_SETUP_COPY.sources;
  const Icon =
    source === 'passbook'
      ? Sparkles
      : source === 'plan'
        ? Lock
        : source === 'org'
          ? Building2
          : LayoutTemplate;
  const text =
    label ??
    (templatesOwn > 0
      ? templatesOwn === 1
        ? s.templateOwn
        : scanLine(s.templatesOwn, { n: templatesOwn })
      : source === 'org'
        ? s.org
        : source === 'template'
          ? s.template
          : source === 'plan'
            ? WORDS.plan
            : kind === 'placeholder'
              ? WORDS.placeholder
              : kind === 'passbook'
                ? WORDS.passbook
                : s.passbook);
  return (
    <Badge data-source={source}>
      <Icon aria-hidden />
      {text}
    </Badge>
  );
}
