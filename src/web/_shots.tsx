import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CoreProviders } from './lib/core-providers.tsx';
import { requestStepUp } from './lib/step-up.ts';
import './styles/app.css';
import {
  Button,
  CodeField,
  HostedCard,
  SignedOutCard,
  StateView,
  StepUpDialog,
} from './ui/index.ts';

const q = new URLSearchParams(location.search);
const view = q.get('v') ?? 'code';
const theme = q.get('t') ?? 'light';
document.documentElement.dataset.theme = theme;
const NOW = Date.now();

function Code({ lock, err }: { lock?: boolean; err?: string }) {
  const [v, setV] = useState('123');
  return (
    <HostedCard
      state="code"
      title="Enter the code"
      lede="Sent to a***@example.com."
      lock={lock ? { until: NOW + 272_000, now: NOW } : undefined}
      lineError={err}
    >
      <CodeField id="c" value={v} onChange={setV} />
      <Button className="w-full">Continue</Button>
    </HostedCard>
  );
}
function Step() {
  requestStepUp('/x');
  return <StepUpDialog />;
}
const kinds = [
  ['empty', 'Nothing here'],
  ['failed', 'Could not load'],
  ['no-access', 'No access'],
] as const;
function States({ size }: { size: 'inline' | 'panel' | 'stage' | 'hosted' }) {
  return (
    <div className="grid gap-6" style={{ padding: 16 }}>
      {kinds.map(([k, t]) => (
        <StateView
          key={k}
          size={size}
          state={k}
          art={k === 'no-access' ? 'lock' : 'passes'}
          title={t}
          line="One line."
          action={<Button variant="outline">Try again</Button>}
        />
      ))}
    </div>
  );
}
const views: Record<string, React.ReactNode> = {
  code: <Code />,
  lock: <Code lock />,
  err: <Code err="Wrong code. Try again." />,
  out: (
    <div style={{ maxWidth: 384, margin: '40px auto' }}>
      <SignedOutCard onSignIn={() => {}} size="hosted" />
    </div>
  ),
  outdlg: (
    <div style={{ maxWidth: 384, margin: '40px auto' }}>
      <SignedOutCard onSignIn={() => {}} />
    </div>
  ),
  step: <Step />,
  inline: <States size="inline" />,
  panel: <States size="panel" />,
  stage: <States size="stage" />,
  hosted: <States size="hosted" />,
};
const client = new QueryClient();
createRoot(document.getElementById('root') as HTMLElement).render(
  <CoreProviders queryClient={client}>{views[view]}</CoreProviders>,
);
