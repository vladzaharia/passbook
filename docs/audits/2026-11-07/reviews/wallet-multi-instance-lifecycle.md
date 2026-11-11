# Customer multi-wallet and multi-device audit

## Conclusion

Current Apple Wallet supports multiple device registrations, but the customer journey is Apple-only and its global `inWallet` flag suppresses some add/bulk actions for a pass registered anywhere. Google/Samsung instances, offers, callbacks and status are absent. Target: **one logical entitlement → multiple provider-specific objects/instances → provider-scoped installation/save observations**, without duplicate entitlements or independent redemption gates.

Source and official-documentation review; no edits, tests, builds, provider accounts, production calls, hardware or secrets were used. Acceptance scenarios are proposed, not run.

## Current evidence and risks

- Apple registration key is `(device_id, identity_id, pass_id)`, supports multiple devices and is capped at 20. `inWallet` is `EXISTS(registration for pass_id)` across any device, not evidence of this holder’s current device installation; unregister can mean disabling automatic updates.
- Customer portfolio is keyed by authenticated `owner_user_id`, intentionally across organizations. This differs from provider account identity and org-admin membership. A provider login/email or Apple registration must not authorize cross-tenant portfolio data.
- Device classifier recognizes iPhone/Mac/other, not Android provider eligibility. Portal has touchpoint input for iPad; public SSR sees only UA. No UA proves a wallet is installed or a pass is eligible.
- Add-again and QR handoff exist on pass detail, but portfolio tiles suppress add and Add-all eligibility filters out any registered pass. Bundle pagination recalculates registration-filtered rows with count+OFFSET; installing part 1 can invalidate later batch parts or skip passes.
- Public bearer `.pkpass` links are not owner-session scoped and are not time-expiring; holder reassignment clears ownership but does not rotate pass credential/serial, existing Apple registration or bearer link. “Remove from My passes,” external wallet removal and logical pass revoke are distinct operations.
- Actual expiry/active-org eligibility differs between list/detail/bundle surfaces. Reuse one provider eligibility rule rather than extending these mismatches.
- Scanner gates already use canonical `passes.id`: all provider credentials must resolve to the same tenant-scoped logical pass and shared admission/check-in policy. Multiple wallet copies must not imply multiple admissions.

Sources: `src/worker/modules/apple/{service.ts,repo.ts}`; `src/worker/modules/me/{repo.ts,service.ts}`; `src/web/portal/{my-passes-page.tsx,holder-pass-view.tsx,add/area.ts}`; `src/worker/modules/{public, bundles}/`; `src/worker/modules/holders/{repo.ts,service.ts}`; `src/worker/modules/scan/{repo-gates.ts,act-check-in.ts,resolve.ts}`; report [customer wallet entry](business-customer-wallet-entry.md).

## Provider facts

- **Apple:** one pass type/serial maps across installs; registrations are per device/pass, not Apple account IDs. Apple bundles support up to ten passes or 150 MB. Wallet updates do not prove that every device fetched an update or physically removed a pass.
- **Google:** issuer class/object with account-based save; choose `ONE_USER_ALL_DEVICES` for same owner’s devices, not `MULTIPLE_HOLDERS` unless multi-person sharing is intended. Save/delete callbacks are best effort and do not provide named-device inventory. `hasUsers` is object-level, not current-device state. Watch support is type/OS-limited. Sources: [multi-device policy](https://developers.google.com/wallet/reference/rest/v1/MultipleDevicesAndHoldersAllowedStatus), [callbacks](https://developers.google.com/wallet/generic/use-cases/use-callbacks-for-saves-and-deletions), [Wear OS eligibility](https://support.google.com/wallet/answer/14260807?hl=en).
- **Samsung:** eligibility depends on Galaxy model, country, account, OS and partner/card approval. Public sources reviewed do not establish general concurrent-device guarantees for the eventual selected template. Preserve a multi-instance domain model but require partner/card evidence before claiming Samsung compatibility. Source: [prerequisites](https://developer.samsung.com/wallet/welcome/prerequisites.html).

## Target ownership and lifecycle

Separate (1) logical pass/entitlement and authoritative owner/validity/revocation/admission; (2) provider issuer accounts and tenant grants; (3) provider objects/artifacts, desired/applied revision and failures; (4) provider installation/save observations, only where observable. Same provider may need multiple instances/accounts; missing telemetry remains `unknown`. Keep provider auth, public link, scan credential, save JWT/Cdata, APNs token and callback secrets separate.

Provider actions must resolve to one `(org_id, canonical_pass_id, active credential generation)` and share the same scan gate. Provider status, push accepted, object published, device registration, object saved and device fetch are separate evidence. Commit logical revocation before attempting provider fan-out; show pending/stale/failed native updates honestly. Never claim physical deletion where the provider/device cannot prove it.

Apple full-fidelity first-class; Google/Samsung genuine 1.5-class native adapters with declared subsets. Optional losses disclosed; unsupported or unknown required security semantics block add/issuance. Add a provider without deleting another mapping/resource. A save to one provider/device must never clear or hide another eligible offer.

## Customer and email acceptance

- Recommend the likely wallet by platform only; accessible “Other wallets” exposes every eligible provider and cross-device handoff. Unknown/spoofed UA, in-app browser, tablet and desktop preserve recovery choices. Do not label a click/open/download as installation.
- Always permit add-again/replacement-device flow for eligible passes regardless of any existing installation; registration does not change eligibility. Keep Add-all batch membership stable while registrations/callbacks arrive, and disclose provider limits/partial results.
- Distinguish “Remove from My passes” (account ownership/reattach consequence), provider-specific removal, and entitlement cancellation/revocation. Transfers require explicit credential-generation policy; old bearer link/installed copy must not be assumed retired.
- Email provides every eligible provider’s compliant branded action and precise requirements, plus plain text and neutral portal action; no recipient-device guess. Use provider-specific durable/click-time flows; never pre-store short-lived tokens or substitute `.pkpass` for native provider creation. Provider bulk add is separate from per-pass actions.
- Verify concurrent provider/device saves still create one entitlement and one shared admission policy; revoke while offline, provider failure, duplicate/out-of-order callbacks, batch continuation after first install, and truthful observed status.

Detailed official-source constraints and a 20-scenario matrix were prepared in `local://multi-wallet-customer-audit.md`; expanded acceptance, if desired, should be carried into the final globally ranked audit, not mistaken for executed tests.
