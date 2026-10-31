import pass from '../../templates/henrys.pkpasstemplate/pass.json';
import assets from '../generated/henrys-assets.ts';
import type { PassTemplate, Json } from '../types.ts';
import { clubs, homeClub } from './henrys-clubs.ts';
export const henrys: PassTemplate = {
  id: 'henrys', version: 1, name: 'Henry’s · Copper Gym', signingIdentity: 'henrys', apnsBinding: 'APNS', pass: pass as unknown as Record<string,Json>, assets,
  inputs: {
    memberName: { type: 'string', required: true, maxLength: 80, fieldKeys: ['memberName'] },
    memberId: { type: 'string', required: true, maxLength: 64, pattern: '^[A-Z0-9 .$/+%\\-]+$', fieldKeys: ['memberId'], paths: ['/barcodes/0/altText','/barcodes/0/message','/barcodes/1/altText','/barcodes/1/message'] },
    membership: { type: 'string', required: true, maxLength: 80, fieldKeys: ['membership'] },
    homeClub: { type: 'string', default: 'Capitol Hill', enum: ['Capitol Hill','Queen Anne'], fieldKeys: ['homeClub'] },
    access: { type: 'string', default: 'Home club', enum: ['Home club','All clubs'] },
    status: { type: 'string', default: 'Active', enum: ['Active','Suspended','Expired','Cancelled'], fieldKeys: ['status'] },
    message: { type: 'string', default: 'Welcome to Henry’s.', maxLength: 256, fieldKeys: ['message'] },
    voided: { type: 'boolean', default: false, paths: ['/voided'] },
    expirationDate: { type: 'string', format: 'date-time', paths: ['/expirationDate'] },
    memberPortalURL: { type: 'string', format: 'https-url', fieldKeys: ['portal'], paths: ['/featuredActions/0/url'] }
  },
  customize(pass,input) {
    const home=homeClub(input.homeClub);
    // Native place actions use Apple's placeIdentifier, not a Maps URL.
    const actions=pass.featuredActions as Record<string,Json>[];
    actions.find(action=>action.identifier==='home-gym-directions')!.placeIdentifier=home.placeIdentifier;
    const eligible=input.access==='All clubs'?Object.values(clubs):[home];
    pass.locations=eligible.map(club=>({latitude:club.latitude,longitude:club.longitude,relevantText:`Your Henry’s Gymnasium membership — ${club.name}`}));
    for(const style of ['generic','posterGeneric']) {
      const fields=pass[style] as Record<string,Json>;
      fields.backFields=(fields.backFields as Record<string,Json>[]).filter(f=>!String(f.key).startsWith('directions-') || input.access==='All clubs' || f.key===`directions-${home.id}`);
      (fields.backFields as Record<string,Json>[]).find(f=>f.key==='phone')!.value=home.phone;
    }
  }
};
