import { SandboxPanel } from '../sandbox/sandbox-page.tsx';
import { LegacyTool } from './legacy.tsx';

/** Sandbox: name, limits, reset, start over and delete, through the operations kit (design §1.12). */
export function SandboxPage() {
  return (
    <LegacyTool tool="sandbox" className="wb-tool-sandbox">
      {({ sandbox, csrf }) => <SandboxPanel sandbox={sandbox} csrf={csrf} />}
    </LegacyTool>
  );
}
