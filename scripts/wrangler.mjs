import { runWrangler } from './cloudflare.mjs';
try { runWrangler(process.argv.slice(2)); }
catch { process.exitCode=1; }
