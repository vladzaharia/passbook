# Add to Apple Wallet badge

The console, portal, `/p` and email show Apple's badge artwork without visual changes, through the
kit `AppleWalletBadge` (`src/web/ui/apple-wallet-badge.tsx`) and the pass email (`EMAIL_BADGE`).

| File | Use |
| --- | --- |
| `badge/<locale>/black.svg` | Console, portal and `/p`, on every ground (its grey edge carries it on dark ones) |
| `badge/<locale>/black@2x.png`, `black@3x.png` | Email |

If Apple's kit ships a separate art for dark grounds, add it here and switch to it in
`AppleWalletBadge` then; until then there is one art.

Pending: the owner supplies Apple's badge kit and accepts its licence. Until then every file under
`badge/en/` is a copy of the previous artwork, a preserved copy attributed to Apple at Wikimedia
Commons (https://commons.wikimedia.org/wiki/File:Add_to_Apple_Wallet_badge.svg, downloaded
2026-10-30), and the PNGs are a 480 px rendering of it. When the kit lands, replace the files
unmodified and fill in the record below.

| Field | Value |
| --- | --- |
| Source URL | Pending (Apple Wallet badge kit, https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/) |
| Downloaded | Pending |
| SHA-256 `black.svg` | `197d8e89a9991633d9fc7a145c559692b8531c6182d5d5a7e9dfa1c6aced7d4f` (interim copy) |
| SHA-256 `black@2x.png`, `black@3x.png` | `3672862f9e4ee3c4e3cfdb3f13928cb93a01e4039ef658f41a0312c4192483d9` (interim copy) |
| Licence | Apple's Add to Apple Wallet badge terms (accepted by the owner when the kit is downloaded) |
| Credit | Apple, the Apple logo and Apple Wallet are trademarks of Apple Inc. |

`add-to-apple-wallet.svg` and `.png` stay until the SSR page and email move to the badge paths.
