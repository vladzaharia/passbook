# NFC tag programming: device acceptance

Checks on a real NTAG 424 DNA and a reader, before NFC programming leaves dark. The simulator (`ntag424/sim`) runs ISO commands inside an authenticated session as `isoInSession: 'refuse'` (answer 6985); silicon is unverified.

- ISO command inside an authenticated session: record whether the tag keeps the session, ends it or answers 6985. The product flow assumes it does not need the session after an ISO command.
- `ChangeKey(0)` to an identical key and version must answer 9100. If the tag refuses it, the recovery script's last step cannot close the session that way.
- Fallback when a read-back fails after the script: re-SELECT the NDEF application before the read-back.
- A fully blank tag on a non-releaser resume is refused and audited as `TAG_CLONE_SUSPECTED`; a console abandon is the only way on. Check a genuinely half-keyed tag still resumes.
