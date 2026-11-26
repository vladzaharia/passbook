import type { ReactNode } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { Button, Callout } from '../../../ui/index.ts';
import type { Op } from './apply.ts';
import type { ReadOnlyDesign } from './designer.tsx';
import type { DesignerMode } from './designer-modes.tsx';
import { useDesignerHost } from './host.tsx';
import { DesignerLayout } from './layout.tsx';
import { type DesignDoc, previewTargetOf } from './model.ts';
import { Outline } from './outline.tsx';
import { ScanModeSafe } from './scan/scan-mode-safe.tsx';
import { DesignerStage } from './stage.tsx';
import type { WalletName } from './wallets/roles-model.ts';
import type { WalletChannels } from './wallets/use-wallet-channels.ts';
import { WalletsMode } from './wallets/wallets-mode.tsx';

/** "Restored your unsaved draft", with the way to drop it. */
export function RestoredNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <Callout
      className="mb-4"
      tone="info"
      actions={
        <Button variant="outline" size="sm" onClick={onDiscard}>
          Discard draft
        </Button>
      }
    >
      Restored your unsaved draft.
    </Callout>
  );
}

/** The open mode: Wallets, Scan screen, or the pass with its structure, card and issues. */
export function DesignerModeView({
  mode,
  onPass,
  templateId,
  creating,
  orgId,
  readOnly,
  phone,
  doc,
  passJson,
  checking,
  issues,
  issuesList,
  wallets,
  wallet,
  onWallet,
  edit,
  assetBase,
  stripUrl,
}: {
  mode: DesignerMode;
  onPass: () => void;
  templateId: string;
  creating: boolean;
  orgId: string | undefined;
  readOnly: ReadOnlyDesign | undefined;
  phone: boolean;
  doc: DesignDoc;
  passJson: Record<string, unknown> | null;
  checking: boolean;
  issues: readonly ValidationIssue[];
  issuesList: ReactNode;
  wallets: WalletChannels;
  wallet: WalletName | undefined;
  onWallet: (wallet: WalletName) => void;
  edit: (op: Op, merge?: string) => void;
  assetBase: string;
  stripUrl: string | null;
}) {
  const extras = useDesignerHost().extras;
  const shown = readOnly ? readOnly.passJson : passJson;
  const busy = readOnly ? false : checking;
  if (mode === 'wallets')
    return (
      <WalletsMode
        templateId={templateId}
        passJson={shown}
        checking={busy}
        issues={issues}
        channels={wallets}
        wallet={wallet}
        onWallet={onWallet}
        onPass={onPass}
      />
    );
  if (mode === 'scan')
    return (
      <ScanModeSafe
        onBack={onPass}
        templateId={templateId}
        orgId={orgId ?? null}
        issues={issuesList}
      />
    );
  return (
    <DesignerLayout
      templateId={templateId}
      readOnly={Boolean(readOnly)}
      structure={extras ? <extras.Panel structure={<Outline />} /> : <Outline />}
      below={extras ? <extras.Code /> : undefined}
      preview={
        <DesignerStage
          manifest={doc.manifest}
          templateId={creating ? undefined : templateId}
          orgId={orgId}
          onPaper={readOnly || phone ? undefined : (patch) => edit({ op: 'paper', patch }, 'paper')}
          passJson={shown}
          target={previewTargetOf(doc.passJson, doc.target)}
          assets={doc.assets}
          assetBase={assetBase}
          checking={busy}
          stripUrl={stripUrl}
        />
      }
      issues={issuesList}
    />
  );
}
