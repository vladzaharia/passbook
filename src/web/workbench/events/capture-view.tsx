import { RotateCw, X } from 'lucide-react';
import { useState } from 'react';
import type { WebhookCaptureDto } from '@/shared/contracts/webhook-captures.ts';
import { BENCH_WEBHOOKS_COPY } from '@/shared/copy/developers-bench-webhooks.ts';
import { Button } from '../../ui/button.tsx';
import { IconButton } from '../../ui/icon-button.tsx';
import { StatusPill } from '../../ui/status-pill.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs.tsx';
import { BenchCode } from '../bench/code-block.tsx';
import { BenchTime } from '../bench/time.tsx';
import { curlOf } from './format.ts';
import { VERIFY_SAMPLES } from './samples.ts';
import { Samples } from './samples-tabs.tsx';
import { VerifyPanel } from './verify.tsx';

const I = BENCH_WEBHOOKS_COPY.inspector;
const T = BENCH_WEBHOOKS_COPY.tabs;

/**
 * A captured request in place: exactly what was signed and would have been sent. The Verify tab
 * checks the signature in the browser; the body and headers are the bytes a receiver would read.
 */
export function CaptureView({
  capture,
  loadSecret,
  next,
  onReplay,
  replaying,
  onClose,
}: {
  capture: WebhookCaptureDto;
  loadSecret: () => Promise<string>;
  next: string;
  onReplay: () => void;
  replaying: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('verify');
  const good = capture.status >= 200 && capture.status < 300;
  return (
    <section
      aria-label="Captured request"
      className="mt-2 flex min-w-0 max-w-full flex-col gap-3 overflow-x-auto border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">Captured request</h3>
        <StatusPill status={good ? 'success' : 'danger'}>{capture.status}</StatusPill>
        <BenchTime at={capture.createdAt} mode="full" className="text-xs text-fg-muted" />
        <span className="text-xs text-fg-muted">{capture.durationMs} ms</span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            loading={replaying}
            iconStart={<RotateCw aria-hidden />}
            onClick={onReplay}
          >
            {I.replay}
          </Button>
          <IconButton label="Close capture" size="sm" icon={<X aria-hidden />} onClick={onClose} />
        </span>
      </div>
      <p className="text-xs text-fg-muted">{I.stored}</p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Captured request">
          <TabsTrigger value="verify">{T.verify}</TabsTrigger>
          <TabsTrigger value="headers">{T.headers}</TabsTrigger>
          <TabsTrigger value="body">{T.body}</TabsTrigger>
        </TabsList>
        <TabsContent value="verify" className="flex flex-col gap-3 pt-3">
          <VerifyPanel key={capture.id} capture={capture} loadSecret={loadSecret} next={next} />
          <div className="wh-pane">
            <h4 className="wh-h">{BENCH_WEBHOOKS_COPY.verify.in}</h4>
            <Samples samples={VERIFY_SAMPLES} />
          </div>
        </TabsContent>
        <TabsContent value="headers" className="pt-3">
          <BenchCode
            label={I.headers}
            lang="cli"
            body={Object.entries(capture.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')}
            empty={I.noHeaders}
          />
        </TabsContent>
        <TabsContent value="body" className="pt-3">
          <BenchCode
            label={I.body}
            body={capture.body}
            items={[{ key: 'curl', label: 'curl', text: () => curlOf(capture) }]}
            empty={I.noBody}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
