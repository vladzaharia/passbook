#!/usr/bin/env python3
"""Build, sign, verify and checksum an APK with the existing update identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def run(arguments, **kwargs):
    return subprocess.run([str(arg) for arg in arguments], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ci", action="store_true", help="Require explicitly configured signing credentials")
    args = parser.parse_args()
    environment = os.environ.copy()
    bundled_java = Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
    if not environment.get("JAVA_HOME") and bundled_java.exists():
        environment["JAVA_HOME"] = str(bundled_java)
    sdk = Path(environment.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
    environment["ANDROID_HOME"] = str(sdk)
    tools = sdk / "build-tools" / "35.0.0"
    secrets_dir = Path(environment.get("PASSBOOK_READER_SECRETS_DIR", ROOT.parent / ".secrets/android-reader"))
    if args.ci and not environment.get("PASSBOOK_ANDROID_KEYSTORE"):
        raise RuntimeError("CI requires PASSBOOK_ANDROID_KEYSTORE; a new signing key is never generated.")
    key = Path(environment.get("PASSBOOK_ANDROID_KEYSTORE", secrets_dir / "release.p12"))
    if not key.is_file():
        raise RuntimeError("Restore the existing Android signing key before releasing.")
    if not environment.get("PASSBOOK_SIGNING_PASSWORD"):
        password_file = secrets_dir / "store-password"
        environment["PASSBOOK_SIGNING_PASSWORD"] = password_file.read_text().strip()
    gradle = (ROOT / "app/build.gradle").read_text()
    version = re.search(r"versionName '([^']+)'", gradle).group(1)
    tag = environment.get("ANDROID_RELEASE_TAG")
    if tag and tag != f"android-v{version}":
        raise RuntimeError("The release tag must match versionName in android/app/build.gradle.")
    run([ROOT / "gradlew", "--no-daemon", ":app:testDebugUnitTest", ":app:lint", ":app:assembleRelease"], cwd=ROOT, env=environment)
    run(["node", "--test", ROOT / "web/reader-client.test.mjs"], cwd=ROOT, env=environment)
    DIST.mkdir(exist_ok=True)
    apk = DIST / f"passbook-reader-{version}.apk"
    unsigned = ROOT / "app/build/outputs/apk/release/app-release-unsigned.apk"
    run([tools / "zipalign", "-c", "-P", "16", "4", unsigned], env=environment)
    run([tools / "apksigner", "sign", "--ks", key, "--ks-key-alias", "passbook-reader",
         "--ks-pass", "env:PASSBOOK_SIGNING_PASSWORD", "--out", apk, unsigned], env=environment)
    verified = run([tools / "apksigner", "verify", "--verbose", "--print-certs", apk], capture_output=True, text=True, env=environment)
    (DIST / "signature.txt").write_text(verified.stdout)
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    (DIST / "SHA256SUMS").write_text(f"{digest}  {apk.name}\n")
    for filename in ["README.md", "BRIDGE.md", "ACCEPTANCE.md", "RELEASE-NOTES.md", "REVIEW.md", "NOTICE"]:
        shutil.copyfile(ROOT / filename, DIST / filename)
    shutil.copyfile(ROOT / "third-party/kormax-LICENSE", DIST / "kormax-LICENSE")
    (DIST / "release.json").write_text(json.dumps({
        "version": version, "applicationId": "im.plrs.passbook.reader", "channel": "pilot",
        "apk": apk.name, "sha256": digest, "minimumAndroid": 26, "targetAndroid": 35,
        "physicalP400Tested": False, "verifierIntegrated": True,
        "scannerPath": "/scan", "barcodeVerification": True, "appleVasVerification": False,
    }, indent=2) + "\n")
    print(f"Signed APK: {apk}\nSHA-256: {digest}")


if __name__ == "__main__":
    main()
