import { useState } from 'react';
import {
  SNIPPET_LABEL,
  selfTestSnippet,
  VERIFY_LANGS,
  type VerifyLang,
  verifySnippet,
} from '../../../shared/webhook-setup/snippets.ts';
import { CodeBlock } from '../code-block.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs.tsx';

const code = 'font-mono text-xs';

type Tab = VerifyLang | 'curl';

/**
 * How a receiver checks a request: the scheme in four lines, then the code in Node, Python and Go,
 * and a curl to test your receiver with a made-up signature (a 401 means the check works).
 */
export function VerifyGuide({
  url = 'https://your.server/webhooks',
  className,
}: {
  /** The receiver's URL, for the curl test. */
  url?: string;
  className?: string;
}) {
  const [tab, setTab] = useState<Tab>('node');
  return (
    <div className={className}>
      <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          Sign <code className={code}>{'{timestamp}.{raw body}'}</code> with HMAC-SHA256 and the
          secret. Compare it to a <code className={code}>v1=</code> value in{' '}
          <code className={code}>x-passbook-signature</code>.
        </li>
        <li>
          During a rotation the header holds one <code className={code}>v1=</code> per live secret.
          Accept any match.
        </li>
        <li>Reject a timestamp more than 5 minutes old. Each retry is signed again.</li>
        <li>Use the raw bytes, before parsing. Compare in constant time.</li>
      </ul>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-label="Language">
          {VERIFY_LANGS.map((l) => (
            <TabsTrigger key={l} value={l}>
              {SNIPPET_LABEL[l]}
            </TabsTrigger>
          ))}
          <TabsTrigger value="curl">Test with curl</TabsTrigger>
        </TabsList>
        {VERIFY_LANGS.map((l) => (
          <TabsContent key={l} value={l}>
            <CodeBlock
              code={verifySnippet(l)}
              label={`${SNIPPET_LABEL[l]} verify snippet`}
              maxHeight="max-h-72"
            />
          </TabsContent>
        ))}
        <TabsContent value="curl">
          <p className="mb-2 text-sm text-fg-muted">
            Sends a made-up signature. Your receiver should answer 401 or 400, never 2xx.
          </p>
          <CodeBlock code={selfTestSnippet(url)} label="curl test" maxHeight="max-h-72" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
