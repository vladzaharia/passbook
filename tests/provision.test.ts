import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Small Node-only provisioning helper has no Worker type dependency.
import {recordMatches} from '../scripts/dns-records.mjs';

test('existing sender DNS accepts chunked DKIM and preserves compatible DMARC reports',()=>{
 assert.equal(recordMatches({type:'TXT',name:'cf-bounce._domainkey.plrs.im',content:'"v=DKIM1; p=abcdef"'},[['v=DKIM1; p=abc','def']]),true);
 assert.equal(recordMatches({type:'TXT',name:'_dmarc.plrs.im',content:'"v=DMARC1; p=reject;"'},[['v=DMARC1; p=reject; rua=mailto:reports@example.com;']]),true);
 assert.equal(recordMatches({type:'TXT',name:'_dmarc.plrs.im',content:'"v=DMARC1; p=reject;"'},[['v=DMARC1; p=none;']]),false);
 assert.equal(recordMatches({type:'MX',name:'cf-bounce.plrs.im',content:'route1.mx.cloudflare.net.',priority:10},[{exchange:'route1.mx.cloudflare.net',priority:10}]),true);
 assert.equal(recordMatches({type:'MX',name:'cf-bounce.plrs.im',content:'route1.mx.cloudflare.net.',priority:10},[{exchange:'unrelated.example.com',priority:10}]),false);
});
