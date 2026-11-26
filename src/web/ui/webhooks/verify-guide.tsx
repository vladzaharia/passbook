import { CodeBlock } from '../code-block.tsx';
import { VERIFY_SNIPPET } from './snippet.ts';

/** How a receiver checks a request: the scheme in four lines, then the code. */
export function VerifyGuide({ className }: { className?: string }) {
  return (
    <div className={className}>
      <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          Sign <code className="font-mono text-xs">{'{timestamp}.{raw body}'}</code> with
          HMAC-SHA256 and the secret. Compare it to a <code className="font-mono text-xs">v1=</code>{' '}
          value in <code className="font-mono text-xs">x-passbook-signature</code>.
        </li>
        <li>
          During a rotation the header holds one <code className="font-mono text-xs">v1=</code> per
          live secret. Accept any match.
        </li>
        <li>Reject a timestamp more than 5 minutes old. Each retry is signed again.</li>
        <li>Use the raw bytes, before parsing. Compare in constant time.</li>
      </ul>
      <CodeBlock code={VERIFY_SNIPPET} label="Verify snippet" maxHeight="max-h-56" />
    </div>
  );
}
