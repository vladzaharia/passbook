# Wallet providers: current state

Retired 2026-11-25. The survey that stood here (five kill switches, no Google publish, Samsung refs never promoted)
described a codebase that no longer exists: CW1 to CW7, CW9b, CW10b, CW11, CW12-prep, GM1, GM2, the credential gaps
(0207, 0208) and event boundaries (0205) are on main.

Status now lives in the cross-wallet plan, section 1 (`.wrangler/agent-logs/cross-wallet-plan.md`, not in the repo):

- The conversion pipeline and both runtimes are built and dark. All 78 capabilities compile at their declared level on
  both providers; 74 per provider are gated only by the release, 4 per provider are half.
- Journeys, of 20 per provider: Google 3 done, 9 gated, 5 half, 3 missing. Samsung 3 done, 9 gated, 4 half, 4 missing.
- Still missing: the designer Wallets tab, the import fidelity report, per-item omission review, candidate backfill, a
  per-provider and per-mode release, recorded provider fixtures (`docs/operations.md`, "Recording wallet contract
  fixtures"), e2e for typed types and the Samsung lifecycle, and the owner's provider accounts and device runs.

Design: `architecture.md`. Product and journeys: `product.md`. Capabilities: `capabilities.md`.
