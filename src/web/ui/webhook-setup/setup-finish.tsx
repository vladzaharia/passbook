import { Buddy } from '../art/index.ts';
import { Button } from '../button.tsx';
import { Card, CardBody } from '../card.tsx';

/** The setup is proven: what was seen, then the thing it set up or another setup. */
export function SetupFinish({
  title,
  facts,
  onOpen,
  openLabel,
  onAnother,
  anotherLabel = 'Set up another',
}: {
  title: string;
  facts: readonly string[];
  onOpen: () => void;
  openLabel: string;
  onAnother: () => void;
  anotherLabel?: string;
}) {
  return (
    <Card data-art-host="" className="wl-buddy-room relative max-w-2xl">
      <Buddy size="sm" at="end" mood="happy" scene="cheer" />
      <CardBody className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-fg-strong">{title}</h2>
        <ul className="flex flex-col gap-1 text-sm text-fg-muted">
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onOpen}>{openLabel}</Button>
          <Button variant="outline" onClick={onAnother}>
            {anotherLabel}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
