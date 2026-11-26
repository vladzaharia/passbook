import { WEBHOOK_EVENT_TYPES } from '@/shared/contracts/webhooks.ts';
import { connect } from '../webhooks/client.ts';
import { Tester } from '../webhooks/tester.tsx';
import { LegacyTool } from './legacy.tsx';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/plug.css';
import '../../developers/ui/sheet.css';
import '../webhooks/verify.css';
import '../webhooks/webhooks.css';

const TYPES = ['webhook.test', ...WEBHOOK_EVENT_TYPES.filter((t) => t !== 'webhook.test')];

/** Events (T3 rebuilds it): the moved webhook tester. */
export function EventsPage() {
  return (
    <LegacyTool tool="events" className="wb-tool-events">
      {() => <Tester connect={connect} types={TYPES} />}
    </LegacyTool>
  );
}
