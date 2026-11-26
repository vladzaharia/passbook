import { Buddy } from '../../ui/art/index.ts';
import { Button, Card, CardBody } from '../../ui/index.ts';
import { type SetupTopic, topicProgress } from '../../ui/webhook-setup/index.ts';

/** The setup is proven: what was seen, then the connection or another setup. */
export function SetupFinish({
  provider,
  topics,
  seen,
  onOpen,
  onAnother,
}: {
  provider: string;
  topics: readonly SetupTopic[];
  seen: readonly string[];
  onOpen: () => void;
  onAnother: () => void;
}) {
  const progress = topicProgress(topics, seen);
  const missing = topics.filter((t) => t.required && !seen.includes(t.id)).map((t) => t.id);
  const facts = [
    'Signature OK',
    ...(progress.of > 0
      ? [
          progress.seen >= progress.of
            ? `${progress.seen} of ${progress.of} required topics seen`
            : `${progress.seen} of ${progress.of} seen · ${missing.join(', ')} not seen yet`,
        ]
      : []),
  ];
  return (
    <Card data-art-host="" className="wl-buddy-room relative max-w-2xl">
      <Buddy size="sm" at="end" mood="happy" scene="cheer" />
      <CardBody className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg-strong">{provider} is connected</h2>
        <ul className="flex flex-col gap-1 text-sm text-fg-muted">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onOpen}>Open connection</Button>
          <Button variant="outline" onClick={onAnother}>
            Set up another
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
