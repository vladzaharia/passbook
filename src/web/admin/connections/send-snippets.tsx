import { useState } from 'react';
import {
  SNIPPET_LABEL,
  SNIPPET_LANGS,
  type SnippetLang,
  sendSnippet,
} from '../../../shared/webhook-setup/snippets.ts';
import { CodeBlock, Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/index.ts';

/**
 * A signed request to the connection, in four languages, with its URL, header names and body filled
 * in. The secret is never inlined: the code reads PASSBOOK_SECRET.
 */
export function SendSnippets({
  url,
  signatureHeader,
  timestampHeader,
  body,
}: {
  url: string;
  signatureHeader?: string | null | undefined;
  timestampHeader?: string | null | undefined;
  body: string;
}) {
  const [lang, setLang] = useState<SnippetLang>('curl');
  const options = {
    url,
    body,
    ...(signatureHeader ? { signatureHeader } : {}),
    ...(timestampHeader ? { timestampHeader } : {}),
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium text-fg-strong">Send a test</h3>
      <p className="max-w-[40rem] text-sm text-fg">
        Set <code className="font-mono text-xs">PASSBOOK_SECRET</code> to the secret, then run it.
      </p>
      <Tabs value={lang} onValueChange={(v) => setLang(v as SnippetLang)}>
        <TabsList aria-label="Language">
          {SNIPPET_LANGS.map((l) => (
            <TabsTrigger key={l} value={l}>
              {SNIPPET_LABEL[l]}
            </TabsTrigger>
          ))}
        </TabsList>
        {SNIPPET_LANGS.map((l) => (
          <TabsContent key={l} value={l}>
            <CodeBlock
              code={sendSnippet(l, options)}
              label={`${SNIPPET_LABEL[l]} send snippet`}
              maxHeight="max-h-72"
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
