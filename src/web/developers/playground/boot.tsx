import { createRoot } from 'react-dom/client';
import '../../pass-card/barcode-loader.ts';
import '../../../generated/playground-kit.css';
import './playground-inputs.css';
import './playground-notes.css';
import './playground.css';
import type { BlueprintPreviews } from './model.ts';
import { Playground } from './playground.tsx';

export function render(el: HTMLElement, data: BlueprintPreviews): void {
  createRoot(el).render(<Playground data={data} />);
}

export function renderFailure(el: HTMLElement): void {
  createRoot(el).render(
    <p role="alert" className="pg-bad pg-fail">
      The blueprint previews did not load. Reload to try again.
    </p>,
  );
}
