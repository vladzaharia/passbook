# Wallet providers: current state

Retired 2026-11-25. The survey that stood here (five kill switches, no Google publish, Samsung refs never promoted)
described a codebase that no longer exists: CW1 to CW7, CW9b, CW10b, CW11, CW12-prep, GM1, GM2, the credential gaps
(0207, 0208) and event boundaries (0205) are on main.

Status as of 2026-11-27 (main plus `test/samsung-contract` and `test/cross-wallet-e2e`). Everything below is built and dark unless marked owner.

- **Built:** conversion pipeline and both runtimes; designer Wallets tab (`src/web/admin/templates/designer/wallets/`); import fidelity report (`templates/upload-report.tsx`); per-item omission review (`templates/releases/wallet-review*.ts*`, Blocked rows); system candidate backfill for Google and Samsung (`projection-system-authority.ts`); per-provider, per-mode release with `draining` rollback (`wallet-providers/release.ts`, `0229`).
- **Journeys 2 and 18:** built for Google and Samsung, dark.
- **Journey 19:** doc-shape fixtures and contract tests for both providers (Samsung: `test/samsung-contract`). No recorded fixtures: `tools/record-wallet-contract.ts` and `docs/runbooks/record-wallet-fixtures.md` wait on the owner.
- **E2E:** typed per-type, lifecycle (void, unvoid, delete, expiry), transfer, bundles for Google and Samsung; reissue, Live isolation and designer 390 px in `test/cross-wallet-e2e` (`e2e/94-wallets-reissue-live.spec.ts`).
- **Owner-gated:** journey 20 (real Pixel and Galaxy runs, Test then Live); Google issuer and class review; Samsung partner account and the Q13 and Q14 answers; recorded fixtures; the four release flips (one `RELEASE` cell plus one migration each).

Design: architecture.md. Product and journeys: product.md. Capabilities: capabilities.md.
