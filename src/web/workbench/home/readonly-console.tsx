import { ConsolePage } from '../console/app/console-page.tsx';
import '../bench/bench.css';
import '../bench/pane.css';
import '../console/console.css';
import '../console/page.css';
import '../styles/legacy.css';

/** With no sandbox the Console only reads: the operation index and each operation's reference. */
export default function ReadOnlyConsole() {
  return (
    <div className="wb-legacy">
      <ConsolePage />
    </div>
  );
}
