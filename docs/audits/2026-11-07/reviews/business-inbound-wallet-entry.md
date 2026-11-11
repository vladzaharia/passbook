# Inbound integration addendum — wallet recommendations and invitation buttons

This extends local://inboundpartner1-provider-neutral.md for the owner's wallet-entry UX requirement. It preserves Apple as full-fidelity primary, genuine Google/Samsung 1.5-class subsets, and concurrent installation of one entitlement across many supported providers/devices. Recommendations below are not implemented or verified.

## Current inbound boundary

Connector auto-create passes `sendEmail` when auto-email is enabled and a holder email exists (`src/worker/modules/connections/records.ts:172-182`). The delivery intent currently stores recipient and attachment choice (`src/worker/modules/delivery/service.ts:123-138`). Rendering is Apple-specific: it supplies a `.pkpass` download URL, one badge URL and the current Apple pass summary, with an optional Apple attachment (`src/worker/modules/delivery/email.ts:55-86,109-123`). This is current implementation evidence, not the intended multi-wallet experience.

## Required handoff contract

- **One domain invitation, additive wallet entry.** Auto-email should invite the authorized holder to the single semantic entitlement, with provider-specific Add actions for every eligible wallet. Source mappings and auto-create must not persist an exclusive provider choice based on an upstream hint, email open or user agent. Choosing another provider/device adds an instance; it does not replace successful siblings or create another CRM/domain pass.
- **Recommend on web; do not gate by brittle detection.** Public/customer pages may rank a likely appropriate available wallet using platform hints. Keep every other eligible provider discoverable in a keyboard/screen-reader-accessible accordion or secondary chooser, including when detection is absent or incorrect. Detecting an OS is neither proof of account eligibility nor evidence of installation. Do not record installation or provider attachment merely because a recommendation/add link was shown or opened.
- **Emails offer all eligible Add actions.** Server-created invitations generally have no reliable recipient device context. Show every eligible provider-specific Add button, not only Apple or a guessed favorite; also provide the entitlement's manage/open link. Use each provider's compliant branded button assets/styles, meaningful accessible names/alt text, and usable text-email links. Do not relabel or recolor Apple's badge for another provider. Current provider branding requirements/assets were not externally verified in this read-only slice.
- **Eligibility and requirements stay precise.** Eligibility comes from tenant/template policy, native adapter support, readiness, required semantics and actual provider/account/device permissions—not user-agent exclusion alone. Explain required account/sign-in/app/region/device prerequisites without claiming that a recipient has already satisfied unknown conditions. Secondary wallets may expose narrower subsets or be unavailable; never manufacture an Add button for a mock/unready integration or silently downgrade a required security semantic.
- **Preserve delivery authority.** Fix the inherited stale-recipient/credential-generation P1 before adding more sensitive links. Bind the invitation to authorized recipient/entitlement lifecycle intent; do not enrich obsolete queued mail with newly rotated credentials or provider access. Adding native buttons must not multiply connector auto-create emails, defeat existing caps or infer customer consent from mail-image/link prefetch.
- **Make authoring/rehearsal truthful.** Connector/template dry-run should preview the actual multi-provider email and public entry states: primary recommendation, secondary choices, native branded Add buttons, omitted/unavailable targets and exact requirement/fallback messages. Separate native preview/readiness from actual provider issuance and installation evidence. Keep per-instance outcomes visible beneath the customer's one-entitlement aggregate.

## Acceptance scenarios — proposed, not executed

1. On known, unknown and deliberately incorrect platform hints, recommendation order may change but every eligible alternative remains reachable with keyboard and screen reader; none is mislabeled installed.
2. The same invitation opened on an iPhone and Android device offers appropriate web recommendations without changing the domain pass, overwriting an existing wallet instance or hiding another valid choice.
3. An auto-email with multiple eligible native targets contains all corresponding compliant branded Add buttons plus accessible text equivalents; unavailable targets are not falsely offered.
4. Add to two providers/devices from those links: both coexist, their update/install state remains independent, and no second CRM record or automatic invitation is created.
5. Remove an adapter's readiness or require an unsupported security feature: the affected target/flow stops being issuable with an honest reason; another valid target remains usable. An optional fallback is explicit in previews and UI.
6. Reassign/revoke the entitlement while its invitation is queued: the former holder receives no fresh provider access. Opening/prefetching any link must not count as installation.

No code changes, builds, tests, secret reads, external provider calls or branding/account approvals were performed.
