import type { AccessRequest } from '../../shared/contracts/access-request.ts';
import { EMAIL_LIGHT as c, emailShell, escapeHtml, titleHtml, type } from './shell.ts';

/** To PassBook's own inbox; reply-to is the person who asked. Every submitted value is escaped. */
export function accessRequestEmail(request: AccessRequest) {
  const subject = `Access request: ${request.org}`;
  const rows: [string, string][] = [
    ['Name', request.name],
    ['Email', request.email],
    ['Organization', request.org],
    ['For', request.purpose],
  ];
  const cell = `style="padding:4px 12px 4px 0;vertical-align:top;${type('sm')};color:${c.muted}" class="e-muted"`;
  const value = `style="padding:4px 0;${type('sm')};color:${c.text}" class="e-text"`;
  const table = rows
    .map(([k, v]) => `<tr><td ${cell}>${k}</td><td ${value}>${escapeHtml(v)}</td></tr>`)
    .join('');
  const message = request.message
    ? `<p style="margin:16px 0 0;white-space:pre-wrap;${type('sm')};color:${c.text}" class="e-text">${escapeHtml(request.message)}</p>`
    : '';
  const body = `${titleHtml('Access request', '0 0 16px')}
<table role="presentation" cellpadding="0" cellspacing="0" border="0">${table}</table>${message}`;
  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(request.message ? ['', request.message] : []),
  ];
  return {
    subject,
    text: text.join('\n'),
    html: emailShell({ lang: 'en', title: subject, header: 'PassBook', body }),
  };
}
