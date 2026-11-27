import { ConsolePage } from '../console/app/console-page.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import '../bench/bench.css';
import '../bench/pane.css';
import '../console/console.css';
import '../console/page.css';
import '../styles/legacy.css';

/** Console: any operation of the API, run on the org's Workbench token (design §3, T5). */
export function ConsoleToolPage() {
  return (
    <ToolPage tool="console">
      <div className="wb-legacy wb-tool-console">
        <ConsolePage />
      </div>
    </ToolPage>
  );
}
