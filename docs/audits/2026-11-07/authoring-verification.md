# Pass/template authoring walkthrough — local

**Boundary:** Browser inspection of the local mock-OIDC/D1/fixture-signer application at 390px and 1440px. A synthetic org-owned copy of `starter-generic` was created locally to inspect the template designer. No pass was submitted, no email sent, and no production service, real holder data or provider account was used. Provider/mobile behavior beyond source/UI observation is not verified.

## Observed routes and states

### New pass (`/admin/passes/new`)

- The wizard begins with a required organization choice and an adjacent stepper for Organization → Template → Details → Holder → Review. Selecting an organization and continuing presented platform templates plus an org-owned clone as radio-style cards with small pass previews.
- Selecting Generic generated 14 schema-defined input fields. At desktop width, the form occupied a scrollable left column with a sticky preview on the right and a bottom step bar.
- After entering synthetic `Name` and `ID` values, the preview reflected them and showed the expected “Approximate preview, not for scanning” label. This is a Wallet card preview, not a provider chooser or scanner result preview.
- Holder step exposed `Holder email` and `Email the pass`; the email checkbox was disabled until an email was supplied. No provider-specific issuance target, multi-wallet artifact status or customer/scanner display editing appeared in this flow.
- No final Review submission or actual pass issuance was performed.

Screenshot: [populated pass-creation Details step](screenshots/pass-authoring-populated.png).

### Template designer (`/admin/templates/{templateId}/design`)

- The local uploaded clone opened a three-column editor: structured section outline, central pass preview, and issue list. The outline exposed Template, Apple Style, Colors, Images, Header/Primary/Secondary/Auxiliary/Back fields, Inputs, Barcode and Relevance.
- The preview offered `Front` and `Details` (back) radio controls. It displayed the Apple-shaped Generic pass from sample inputs and an “Approximate preview, not for scanning” warning. The issues panel reported `webServiceURL` and support-contact items for the synthetic local template.
- No scan-display editing section, provider-target tabs/readiness, native provider previews, provider artifact diff, or per-provider install/update state was present in the observed designer.
- The route was loaded before activation. No changes were saved or activated. Tablet/phone editing was not visually exercised; repository documentation identifies phone preview-only, see the authoring reports.

Screenshots: [Wallet Front](screenshots/template-designer-front.png), [Wallet Details/back](screenshots/template-designer-details.png).

## Interpretation boundaries

The browser evidence confirms a schema-driven pass-data workflow and an Apple-specific reusable-template editor with front/back preview. It does not demonstrate Google/Samsung issuance, provider availability, Wallet rendering, scanner display editing, provider eligibility, or a multiple-device installation lifecycle. Current scan-display authoring is a distinct manifest model with no corresponding WYSIWYG section; source findings and safe design acceptance criteria are in [scanner display audit](reviews/authoring-scan-display.md).
