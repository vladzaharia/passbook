import { useState } from 'react';
import { PRINT_COPY } from '@/shared/copy/print.ts';
import { SegmentedControl } from '../../../ui/index.ts';
import type { DraftAsset } from './model.ts';
import type { PaperPatch } from './ops-paper.ts';
import { PaperPreview } from './paper-preview.tsx';
import { DesignerPreview } from './preview.tsx';

type Tab = 'wallet' | 'paper';
const TABS = [
  { value: 'wallet', label: 'Wallet' },
  { value: 'paper', label: PRINT_COPY.tab },
] as const;

/** The designer's preview stage: the wallet card, or the printed ticket on the Paper tab. */
export function DesignerStage({
  manifest,
  templateId,
  orgId,
  onPaper,
  ...card
}: {
  manifest: Record<string, unknown>;
  templateId?: string | undefined;
  orgId?: string | undefined;
  onPaper?: ((patch: PaperPatch) => void) | undefined;
  passJson: Record<string, unknown> | null | undefined;
  assets: readonly DraftAsset[];
  assetBase: string;
  checking: boolean;
  stripUrl?: string | null;
}) {
  const [tab, setTab] = useState<Tab>('wallet');
  return (
    <div className="flex w-full flex-col items-center gap-4">
      <SegmentedControl
        label="Preview"
        options={TABS}
        value={tab}
        onValueChange={setTab}
        className="self-center"
      />
      {tab === 'wallet' ? (
        <DesignerPreview {...card} />
      ) : (
        <PaperPreview
          passJson={card.passJson}
          manifest={manifest}
          templateId={templateId}
          orgId={orgId}
          onEdit={onPaper}
        />
      )}
    </div>
  );
}
