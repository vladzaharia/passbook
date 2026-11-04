-- PassBook moved to passbook.mobile. wallet.plrs.im only redirects, and Wallet does not follow
-- redirects, so a pass that keeps the old web service URL could never update. No pass was on a
-- device yet, so stored URLs move too; the next build (Identities, Re-sign) ships them.
UPDATE passes SET web_service_url = 'https://passbook.mobile/wallet'
WHERE web_service_url = 'https://wallet.plrs.im/wallet';
