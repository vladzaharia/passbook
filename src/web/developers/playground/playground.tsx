import { CheckCircle2, ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { useWalletPreviews } from '../../channel-previews/use-wallet-previews.ts';
import { TestBand } from '../../pass-card/test-band.tsx';
import { CodePanel } from './code-panel.tsx';
import { InputsPanel } from './inputs-panel.tsx';
import type { BlueprintPreviews } from './model.ts';
import { WalletNotes } from './notes.tsx';
import { Stage } from './stage.tsx';
import { sourceOf } from './templates.ts';
import { usePlayground } from './use-playground.ts';

/** The pass playground: inputs on the left, every channel on the right, the request below. */
export function Playground({ data }: { data: BlueprintPreviews }) {
  const p = usePlayground(data);
  const { template, state, link, created } = p;
  const source = useMemo(
    () => (p.built ? sourceOf(template, p.built, p.values) : null),
    [template, p.built, p.values],
  );
  const wallets = useWalletPreviews(source, true);
  const edited = Object.keys(state.edits).length > 0;
  const live = link.kind === 'live';
  return (
    <>
      <InputsPanel
        template={template}
        templates={p.templates}
        values={p.values}
        edited={edited}
        mode={state.mode}
        link={link}
        created={created}
        problem={p.problem}
        onMode={(mode) => p.patch({ mode })}
        onPick={p.pick}
        onValues={p.setValues}
        onReset={() => p.patch({ edits: {} })}
        onAttach={() => void p.attach(true)}
        onCreate={() => void p.create()}
      />
      <div className="view">
        {created ? (
          <div className="card created" role="status">
            <TestBand />
            <div className="row g3 created-row">
              <CheckCircle2 aria-hidden="true" className="ok-t" />
              <span className="sm">
                <span className="strong">Test pass created.</span> It is a preview and cannot be
                added to a wallet.
              </span>
              <span className="mono xs muted">{created.id}</span>
              <a className="btn outline sm push" href={created.downloadUrl}>
                <ExternalLink aria-hidden="true" />
                Open preview page
              </a>
            </div>
          </div>
        ) : null}
        <Stage
          source={source}
          wallets={wallets}
          channel={state.channel}
          face={state.face}
          freshness={p.freshness}
          updatedAt={p.updatedAt}
          stale={!live && edited}
          paperImage={live ? undefined : template.fixed?.paper}
          onChannel={(channel) => p.patch({ channel })}
          onFace={(face) => p.patch({ face })}
        />
        <WalletNotes previews={wallets} />
        <CodePanel
          templateId={template.id}
          values={p.values}
          lang={state.lang}
          onLang={(lang) => p.patch({ lang })}
          apiBase={`${location.origin}/api/v1`}
        />
      </div>
    </>
  );
}
