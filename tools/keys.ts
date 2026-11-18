// Key ring tools (owner only).
//   <KEK in base64 on stdin> | node tools/keys.ts mac-root | wrangler secret put MAC_ROOT_V1
// Prints the MAC root of a KEK (HKDF-Extract, src/worker/platform/mac-roots.ts). It derives every MAC key
// the KEK does and unwraps no envelope. It never reads .secrets/: pipe the KEK from your vault.
import { extractMacRoot } from '../src/worker/platform/mac-roots.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const command = process.argv[2];
if (command === 'mac-root') {
  const kek = await readStdin();
  if (!kek) {
    console.error('Pipe the KEK (base64) on stdin.');
    process.exit(1);
  }
  process.stdout.write(`${await extractMacRoot(kek)}\n`);
} else {
  console.error('Usage: <KEK base64> | node tools/keys.ts mac-root');
  process.exit(1);
}
