import { EventsTool } from '../events/events-tool.tsx';
import '../../ui/art/scenes/common.css';
import '../../ui/art/scenes/plug.css';
import '../../developers/ui/sheet.css';
import '../bench/bench.css';
import '../bench/pane.css';
import '../styles/legacy.css';
import '../events/verify.css';
import '../events/webhooks.css';

/** Events and webhooks (the tool's body carries `wb-tool-events`, which marks the chunk for the bundle budget). */
export function EventsPage() {
  return <EventsTool className="wb-legacy wb-tool-events" />;
}
