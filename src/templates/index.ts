import { henrys } from './henrys.ts';
import bluePass from '../../templates/henrys-blue.pkpasstemplate/pass.json';
import blueAssets from '../generated/henrys-blue-assets.ts';
import type { Json } from '../types.ts';
import type { PassTemplate } from '../types.ts';
import { HTTPException } from 'hono/http-exception';
const blue: PassTemplate={...henrys,id:'henrys-blue',name:'Henry’s · Blue Entrance',pass:bluePass as unknown as Record<string,Json>,assets:blueAssets};
export const templates: Readonly<Record<string,PassTemplate>>=Object.freeze({henrys,'henrys-blue':blue});
export function getTemplate(id: string): PassTemplate {
  const template=Object.hasOwn(templates,id) ? templates[id] : undefined;
  if(!template) throw new HTTPException(404,{message:'Template not found'});
  return template;
}
