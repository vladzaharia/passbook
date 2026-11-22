import { createRoot } from 'react-dom/client';
import { connect } from './client.ts';
import '../../ui/art/art.css';
import '../../ui/art/art-records.css';
import '../../ui/art/art-details.css';
import '../../ui/art/art-wallet.css';
import '../../ui/art/wallet-states.css';
import '../../ui/art/scenes/rest.css';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/plug.css';
import '../ui/sheet.css';
import './verify.css';
import './webhooks.css';
import { Tester } from './tester.tsx';

const start = () => connect();

/** The `webhook-tester` island: the page lists the event types in `data-types`, the signed-out card is its first paint. */
export function mount(el: HTMLElement): void {
  const types = (el.dataset.types ?? 'webhook.test').split(',').filter(Boolean);
  createRoot(el).render(<Tester connect={start} types={types} />);
}
