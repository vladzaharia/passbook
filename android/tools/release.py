#!/usr/bin/env python3
"""Build, sign, verify and checksum an installable pilot APK; never uploads it."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SECRETS = ROOT.parent / ".secrets" / "android-reader"
DIST = ROOT / "dist"
VERSION = "0.1.0"


def run(arguments, **kwargs):
    return subprocess.run([str(arg) for arg in arguments], check=True, **kwargs)


def main():
    environment = os.environ.copy()
    bundled_java = Path("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
    if not environment.get("JAVA_HOME") and bundled_java.exists():
        environment["JAVA_HOME"] = str(bundled_java)
    sdk = Path(environment.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
    environment["ANDROID_HOME"] = str(sdk)
    java = Path(environment["JAVA_HOME"]) / "bin"
    tools = sdk / "build-tools" / "35.0.0"
    run([ROOT / "gradlew", ":app:testDebugUnitTest", ":app:lint", ":app:assembleRelease"],
        cwd=ROOT, env=environment)
    run(["node", "--test", ROOT / "web/reader-client.test.mjs"], cwd=ROOT, env=environment)
    SECRETS.mkdir(parents=True, exist_ok=True, mode=0o700)
    SECRETS.chmod(0o700)
    password_file = SECRETS / "store-password"
    key = SECRETS / "release.p12"
    if not key.exists():
        if password_file.exists():
            raise RuntimeError("Password exists without a key; restore the signing key before releasing.")
        password_file.write_text(secrets.token_urlsafe(48))
        password_file.chmod(0o600)
        environment["PASSBOOK_SIGNING_PASSWORD"] = password_file.read_text()
        run([java / "keytool", "-genkeypair", "-keystore", key, "-storetype", "PKCS12",
             "-storepass:env", "PASSBOOK_SIGNING_PASSWORD", "-alias", "passbook-reader",
             "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
             "-dname", "CN=PassBook Reader, OU=Android pilot, O=PassBook"], env=environment)
        key.chmod(0o600)
    environment["PASSBOOK_SIGNING_PASSWORD"] = password_file.read_text().strip()
    DIST.mkdir(exist_ok=True)
    apk = DIST / f"passbook-reader-{VERSION}.apk"
    unsigned = ROOT / "app/build/outputs/apk/release/app-release-unsigned.apk"
    run([tools / "zipalign", "-c", "-P", "16", "4", unsigned], env=environment)
    run([tools / "apksigner", "sign", "--ks", key, "--ks-key-alias", "passbook-reader",
         "--ks-pass", "env:PASSBOOK_SIGNING_PASSWORD", "--out", apk, unsigned], env=environment)
    verified = run([tools / "apksigner", "verify", "--verbose", "--print-certs", apk],
                   capture_output=True, text=True, env=environment)
    (DIST / "signature.txt").write_text(verified.stdout)
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    (DIST / "SHA256SUMS").write_text(f"{digest}  {apk.name}\n")
    for filename in ["README.md", "BRIDGE.md", "ACCEPTANCE.md", "RELEASE-NOTES.md", "REVIEW.md", "NOTICE"]:
        shutil.copyfile(ROOT / filename, DIST / filename)
    shutil.copyfile(ROOT / "third-party/kormax-LICENSE", DIST / "kormax-LICENSE")
    (DIST / "release.json").write_text(json.dumps({
        "version": VERSION, "applicationId": "im.plrs.passbook.reader", "channel": "pilot",
        "apk": apk.name, "sha256": digest, "minimumAndroid": 26, "targetAndroid": 35,
        "physicalP400Tested": False, "verifierIntegrated": False,
    }, indent=2) + "\n")
    print(f"Signed pilot APK: {apk}\nSHA-256: {digest}")


if __name__ == "__main__":
    main()
