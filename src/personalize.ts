import type { Json, PassTemplate, Personalization } from './types.ts';
import { assert, object } from './util.ts';

export function validateInputs(template: PassTemplate, input: unknown): Personalization {
  const raw = object(input), result: Personalization = {};
  for(const key of Object.keys(raw)) assert(Object.hasOwn(template.inputs,key), `Unknown personalization field: ${key}`);
  for(const [key,spec] of Object.entries(template.inputs)) {
    const value = Object.hasOwn(raw,key) ? raw[key] : spec.default;
    if(value === undefined) { assert(!spec.required, `Missing personalization field: ${key}`); continue; }
    assert(typeof value===spec.type, `${key} must be a ${spec.type}`);
    if(typeof value==='string') {
      assert(value.length <= (spec.maxLength ?? 256) && !/[\x00-\x1f]/.test(value), `Invalid ${key}`);
      assert(!spec.required || value.trim().length>0, `${key} is required`);
      if(spec.pattern) assert(new RegExp(spec.pattern).test(value), `Invalid ${key} format`);
      if(spec.format==='https-url') { let url: URL; try { url=new URL(value); } catch { assert(false, `${key} must be an HTTPS URL`); } assert(url.protocol==='https:' && !url.username && !url.password, `${key} must be an HTTPS URL`); }
      if(spec.format==='date-time') assert(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), `${key} must be an ISO timestamp`);
    }
    if(typeof value==='number') assert(Number.isFinite(value), `Invalid ${key}`);
    if(spec.enum) assert(spec.enum.includes(value as string), `Unsupported ${key}`);
    result[key]=value as string|number|boolean;
  }
  return result;
}

function setPath(root: Record<string, Json>, path: string, value: Json) {
  const parts=path.split('/').slice(1).map(p=>p.replaceAll('~1','/').replaceAll('~0','~'));
  const protectedKeys=['serialNumber','passTypeIdentifier','teamIdentifier','authenticationToken','webServiceURL','formatVersion'];
  assert(path.startsWith('/') && parts.length>0 && !protectedKeys.includes(parts[0]) && !parts.some(p=>['__proto__','prototype','constructor'].includes(p)), 'Unsafe template mapping');
  let target: any=root;
  for(const part of parts.slice(0,-1)) { assert(target!==null && typeof target==='object' && Object.hasOwn(target,part), `Missing template path: ${path}`); target=target[part]; }
  target[parts.at(-1)!]=value;
}

export function personalize(template: PassTemplate, input: Personalization): Record<string, Json> {
  const pass=structuredClone(template.pass);
  for(const [key,value] of Object.entries(input)) {
    const spec=template.inputs[key];
    for(const path of spec.paths ?? []) setPath(pass,path,value);
    if(spec.fieldKeys?.length) {
      const walk=(item: Json): void=>{
        if(Array.isArray(item)) { for(const child of item) walk(child); }
        else if(item && typeof item==='object') {
          if(typeof item.key==='string' && spec.fieldKeys!.includes(item.key)) item.value=value;
          for(const child of Object.values(item)) walk(child);
        }
      };
      walk(pass);
    }
  }
  template.customize?.(pass,input);
  return pass;
}
