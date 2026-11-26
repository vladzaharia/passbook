import { ConsolePage } from '../console/app/console-page.tsx';
import { LegacyTool } from './legacy.tsx';
import '../console/console.css';
import '../console/page.css';

/** Console (T5 rebuilds it on the token client): the moved bench tool on the sandbox's session. */
export function ConsoleToolPage() {
  return (
    <LegacyTool tool="console" className="wb-tool-console">
      {({ sandbox, csrf }) => <ConsolePage sandbox={sandbox} csrf={csrf} />}
    </LegacyTool>
  );
}
