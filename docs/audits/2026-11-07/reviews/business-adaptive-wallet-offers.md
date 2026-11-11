# Adaptive wallet offers and provider branding

## Decision for the requested customer experience

Present one primary **recommended** wallet action chosen from the current platform signal and the pass’s actual provider eligibility. Put other eligible wallets under an accessible “Other wallets” disclosure. On Apple platforms recommend Apple Wallet; on Samsung devices recommend Samsung Wallet only when the provider integration confirms the device/pass flow is available; on other Android devices recommend Google Wallet only when eligible. Keep the alternatives available regardless of recommendation. If the platform or eligibility is uncertain, do not guess: show eligible choices without a false recommendation.

A browser/UA match is a recommendation hint, not proof that a wallet is installed, that a pass is supported, or that adding succeeded. Keep installation state provider- and instance-specific, and show it only when observed. Current `inWallet` means at least one Apple registration exists, not that this browser/device has the pass. Do not reuse it to hide other provider actions.

Emails have no reliable recipient-device signal. Include the branded add action for every provider that is eligible for that pass and ready for the tenant, together with each provider’s relevant device/account instructions. Do not select one provider from a guessed recipient platform or promise bulk-add across providers without a real bulk flow.

## Confirmed current behavior

- Portal, public pass/bundle SSR pages, pass email and bundle email offer Apple `.pkpass`/`.pkpasses` only. The portal offers an Apple badge across device classes in the list; its detail page uses an Apple/QR split. Public SSR has a coarser user-agent-only device classifier; the portal also uses touch-point data. Static public pages do not hydrate, so any alternate-wallet disclosure must work without JavaScript.
- `src/shared/device.ts` recognizes iPhone, Mac, or other, not Samsung versus generic Android. These heuristics cannot confirm app installation or provider eligibility.
- The existing UI uses `/apple/badge/en/black.svg`; email uses its PNG counterpart. `public/apple/README.md` identifies these as interim Wikimedia-derived copies pending Apple-supplied artwork and license. Apple’s current rules require its supplied badge, only beside a compatible pass, localized SVG for web/email, light-background artwork or outline on very dark backgrounds, and at least 0.1 badge-height clear space. Current English-only interim assets and dark-theme treatment therefore need owner/license review before release.
- Existing email preview renders a single Apple action. Provider-specific offer/eligibility data is absent from public pages and email assembly.

Sources in repository: `src/shared/device.ts`; `src/web/portal/{device.ts,my-passes-page.tsx,holder-pass-view.tsx}`; `src/worker/ssr/{pass-page.tsx,bundle-page.tsx}`; `src/worker/modules/{public/routes.ts,bundles/public-routes.ts,me/repo.ts,me/service.ts,delivery/email.ts,bundles/deliver.ts,orgs/email-preview.ts}`; `src/worker/email/{pass.ts,bundle.ts}`; `src/shared/{apple-badge.ts,email-art.ts}`; `public/apple/README.md`.

## Provider action constraints

| Provider | Official action/asset constraints | Email/public integration consequence |
|---|---|---|
| Apple Wallet | Apple-supplied localized badge; use SVG for web/email; don't recreate, recolor, dim, shadow, animate, rotate, or use the Wallet icon alone. Light background preferred; use official outline on very dark backgrounds; 0.1× badge-height clear space. Badge is for a compatible pass only. | Direct `.pkpass` remains provider-specific. Email/web copy must explain opening on an Apple device when necessary. Obtain the correct licensed artwork rather than retaining the interim repository copies. [Apple badge guidelines](https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/) |
| Google Wallet | Google-supplied localized assets; black primary/condensed variants; don't alter shape, color, font, or padding; keep aspect ratio; at least 48 dp high and 8 dp clear space. Primary for light backgrounds; condensed if space is constrained. Button must trigger a Google Wallet API flow. | A working action requires Google’s save flow (including a signed save JWT/provider object), not a `.pkpass` link. Google explicitly permits its button in email. No current Google adapter/account readiness was verified. [Google button guidelines](https://developers.google.com/wallet/generic/resources/brand-guidelines) |
| Samsung Wallet | Use Samsung-provided button resources/API and partner data. Web flow requires partner card ID, encrypted Cdata and partner values; Cdata expires 30 seconds after creation, so create it on click. Provider guidance includes button locale/theme handling and availability checks. | Email cannot rely on the JavaScript web button: Samsung documents a Data Fetch Link using a non-inferable reference ID and partner server-side card-data fetch. Treat that reference as a capability secret and define expiration/replay behavior. No current Samsung adapter/partner approval was verified. [Samsung web button](https://developer.samsung.com/wallet/api_new/addto/button.html) · [Samsung add flow and Data Fetch Link](https://developer.samsung.com/wallet/api/add-to-wallet-interface.html) |

## Acceptance criteria

1. One server-computed offer contract per pass contains provider, eligibility/readiness state, add URL or click-time action, official localized asset, exact requirements, and separately observed installation state. Unsupported, unavailable, unknown, and installed are distinct; a missing provider integration never becomes a fake button.
2. Device signal affects ranking only. Apple device recommends Apple; Samsung model/platform recommends Samsung only after current eligibility; generic Android recommends Google only after eligibility. Unsupported or ambiguous signals use an honest fallback. A recommendation never hides an eligible alternative or asserts install status.
3. Portal, public pass SSR, public bundle SSR, customer pass detail and email preview use the same semantics. Public SSR’s “Other wallets” disclosure works without hydration. It exposes alternatives to keyboard, screen reader and touch users, and visible text names the destination.
4. Email includes every eligible provider’s official CTA per relevant pass, plus concise individual requirements and plain-text links/instructions. Email-safe HTML must not depend on provider JavaScript; Samsung uses its documented Data Fetch Link, Google its supported save URL/JWT flow, Apple its compatible pass link. Do not assume provider-specific bulk issuance exists.
5. “Added”/“in wallet” is never inferred from button click, UA, QR scan, or opening the provider URL. Add one provider/device instance without suppressing other eligible wallet offers. Any install/registration failure leaves the other options available.
6. Use licensed official provider assets and their localization/contrast/clear-space rules. Test light/dark themes, reduced-motion, long localized labels, email clients, disabled/unavailable offers and provider errors without altering provider artwork.

## Boundaries

No provider accounts, Samsung partner approval, Google issuer configuration, external delivery, or production state were checked. This is a source audit and official-document review, not proof of live eligibility, install success, or device behavior. Recommended ordering among multiple eligible providers, fallback for unknown devices, and ownership of issuer credentials remain product/operations decisions; preserve the customer’s visible alternative choices in all cases.
