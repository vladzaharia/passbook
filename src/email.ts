import { Buffer } from 'node:buffer';
import type { EmailPayload, Env, PassRow } from './types.ts';
import { getTemplate } from './templates/index.ts';
import { passLinks } from './passes.ts';
import { escapeHtml as e, mime, baseURL } from './util.ts';

export async function passEmail(env: Env, row: PassRow, recipient: string): Promise<EmailPayload> {
  if(!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not configured');
  const template=getTemplate(row.template_id), links=passLinks(env,row);
  const file=await env.BUCKET.get(row.object_key);
  if(!file) throw new Error('Pass attachment is missing');
  const name=String(template.pass.organizationName),origin=baseURL(env.PUBLIC_BASE_URL);
  return {
    from:{email:env.EMAIL_FROM,name},to:recipient,subject:`Your ${name} pass`,
    text:`Your ${name} pass is ready.\n\nAdd to Apple Wallet: ${links.downloadURL}\n\nManage Pass: ${links.walletURL}\n\nYou can also open the attached pass on your iPhone. Once added, leave automatic updates enabled to receive membership changes.\n\nThis personal link gives access to your pass. Keep it private.`,
    html:`<!doctype html><html><body style="margin:0;background:#f3eee7;color:#241e1b;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 20px"><table role="presentation" width="520" style="width:100%;max-width:520px" cellspacing="0" cellpadding="0"><tr><td style="background:#191416;padding:32px;border-radius:24px 24px 0 0"><img src="${e(origin+'/brand/'+encodeURIComponent(template.id)+'/logo@2x.png')}" width="108" alt="${e(name)}"><h1 style="color:#fff9f2;font-size:26px;line-height:1.2;font-weight:500;margin:24px 0 0">Your membership pass</h1></td></tr><tr><td style="background:white;padding:32px;border-radius:0 0 24px 24px"><p style="line-height:1.6">Your ${e(name)} pass is attached.</p><p style="padding:12px 0"><a href="${e(links.downloadURL)}" style="display:inline-block;padding:6px;text-decoration:none"><img src="${e(origin+'/apple/add-to-apple-wallet.png')}" alt="Add to Apple Wallet" width="180" style="display:block;width:180px;height:auto;border:0"></a></p><p><a href="${e(links.walletURL)}" style="display:inline-block;border:1px solid #cfc5ba;color:#241e1b;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:bold">Manage Pass</a></p><p style="color:#71645b;font-size:14px;line-height:1.6">On your iPhone, open the attachment or tap Add to Apple Wallet. Leave automatic updates enabled to receive changes.</p><hr style="border:0;border-top:1px solid #eee8e2;margin:28px 0"><p style="color:#8c7f76;font-size:12px">Keep this pass and its links private.</p><p style="color:#8c7f76;font-size:11px">Apple and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries.</p></td></tr></table></td></tr></table></body></html>`,
    attachments:[{filename:`${row.serial}.pkpass`,type:mime,disposition:'attachment',content:Buffer.from(await file.arrayBuffer()).toString('base64')}]
  };
}
