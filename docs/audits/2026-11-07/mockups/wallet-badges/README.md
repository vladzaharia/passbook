# Wallet badge and barcode assets

These files support local visual mockups only. Mock actions do not call wallet APIs.

| Asset | Source and use |
| --- | --- |
| `google-add-to-wallet-primary-en-US.svg` | Google Wallet's [Generic pass brand guidelines](https://developers.google.com/wallet/generic/resources/brand-guidelines) and current [SVG archive](https://developers.google.com/static/wallet/download-assets/add-to-wallet-svg.zip), downloaded 2026-11-09. Primary asset, 283×50; SHA-256 `83709de651f171bb2e278140dd938abb97ec96e3f8e0fa9ebab6fc05a87c9c7c`. |
| `google-add-to-wallet-compact-en-US.svg` | Same Google archive. Compact asset, 199×55; SHA-256 `fee1f26a7f5d5c591869deb81c20b3d38ac05fb675c7b920ef6d299cb0555de2`. |
| `google-add-to-wallet-email-en-US.png` | Google's current [PNG archive](https://developers.google.com/static/wallet/download-assets/add-to-wallet-png.zip), downloaded 2026-11-09. Primary asset, 283×50; SHA-256 `2ae7a2615b8371b91476d85974a23183abc39c587bdc00d5ed43bcb3463ba718`. |
| `samsung-add-to-wallet-light-en-US.png` | Samsung Wallet's official [Image Resources](https://developer.samsung.com/wallet/references/imageresources.html), US CDN `https://us-cdn-gpp.mcsvc.samsung.com/lib/v2/add-to-samsung-wallet_en-us.png`. Black button for light grounds; SHA-256 `941efd0180cd5585627399110422fb9752bd5fb371aadc33e0fe7a682b94d723`. |
| `samsung-add-to-wallet-dark-en-US.png` | Same resource page, US CDN `https://us-cdn-gpp.mcsvc.samsung.com/lib/v2/add-to-samsung-wallet_dark_en-us.png`. White button for dark grounds. The page's published logo asset is v2025_2.0 (2025-01-15; still listed 2026-11-09); SHA-256 `b46fc95b06db1bd421406cce9242d359eba1ba8a96ec5af213e353ea95e62456`. |
| `demo-code128.svg` | Generated with the repository's `bwip-js` barcode encoder for synthetic value `HBR-1042`. Illustration only; not a live pass credential. |

Use the supplied artwork unchanged and preserve its aspect ratio. Google's current guidelines require localized artwork, at least 8 dp clear space, and a 48 dp minimum button height. The mockups use Google SVG for web and PNG for the email frame; the compact SVG is used only below 360 px. Samsung artwork uses its light/dark variants. Do not apply CSS effects to any provider artwork.

The Apple mockups reference the existing `public/apple/badge/en/black.svg`, shared with `AppleWalletBadge`. Apple's official [badge guidelines](https://developer.apple.com/wallet/add-to-apple-wallet-guidelines/) were checked 2026-11-09; they list localized SVG/EPS artwork in 45 locales and require an authorized developer-account representative to accept the Wallet Marketing Artwork License Agreement before downloading. The repository's `public/apple/README.md` identifies the current artwork as an interim copy. The account owner must supply and accept the licensed kit before the shared app/mockup asset is replaced; this task did not accept the agreement or replace the interim file.
