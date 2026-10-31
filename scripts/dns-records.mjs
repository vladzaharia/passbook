import dns from 'node:dns/promises';

export const normalizeDNS = value => String(value).replace(/^"|"$/g,'').replace(/\.$/,'');
export function recordMatches(record, actual) {
  const expected=normalizeDNS(record.content);
  if(record.type==='MX') return actual.some(r=>normalizeDNS(r.exchange).toLowerCase()===expected.toLowerCase() && r.priority===record.priority);
  if(record.type==='CNAME') return actual.some(r=>normalizeDNS(r).toLowerCase()===expected.toLowerCase());
  if(record.type==='TXT') {
    const values=actual.map(chunks=>Array.isArray(chunks)?chunks.join(''):String(chunks));
    // Existing DMARC reporting settings are compatible with the required policy.
    if(record.name.startsWith('_dmarc.')) {
      const tags=value=>Object.fromEntries(value.split(';').map(t=>t.trim()).filter(Boolean).map(t=>{const at=t.indexOf('=');return [t.slice(0,at).trim(),t.slice(at+1).trim()];}));
      const needed=tags(expected);
      return values.some(value=>{const found=tags(value);return Object.entries(needed).every(([key,value])=>found[key]===value);});
    }
    return values.includes(expected);
  }
  return false;
}
export async function missingDNS(records) {
  const missing=[];
  for(const record of records) {
    let actual;
    try { actual=await dns.resolve(record.name,record.type); }
    catch(error) { if(!['ENODATA','ENOTFOUND'].includes(error.code)) throw error; actual=[]; }
    if(!recordMatches(record,actual)) missing.push(record);
  }
  return missing;
}
