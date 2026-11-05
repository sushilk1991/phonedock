# Releasing PhoneDock

A release is three things: a notarized DMG (new installs), a zip of the same app (the update archive), and an item in
`site/appcast.xml`, which GitHub Pages serves at <https://sushilk1991.github.io/phonedock/appcast.xml>. Every copy of
PhoneDock reads that feed once a day and each time it opens. When the feed has a newer build, the app shows
"PhoneDock x.y.z · Update" at the bottom of the main window's sidebar. One click downloads the zip, verifies it, replaces
the app and relaunches it.

The update engine is [Sparkle 2](https://sparkle-project.org) (`app/Package.swift`, pinned exactly). PhoneDock draws its
own UI for it (`UpdateController.swift`, `UpdateSidebarItem.swift`, Settings › General › Updates in
`UpdatesSettingsSection.swift`), and App menu › Check for Updates… starts a check.

## Once: the update signing key

Sparkle signs each update archive with an EdDSA (Ed25519) key. The public half is built into every copy of the app.
The private half signs releases and stays in your login keychain. **Never put the private key in the repo.**

```sh
# Sparkle's tools come with the Swift package
(cd app && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift package resolve)

# 1. Create the key in your login keychain (under its own account, so it can't be confused with another app's key)
app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock

# 2. Save the public key where build-app.sh embeds it (SUPublicEDKey), and commit that file
app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock -p > app/sparkle-public-ed-key.txt
git add app/sparkle-public-ed-key.txt

# 3. Back up the private key somewhere safe (a password manager), not in the repo
app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock -x ~/Desktop/phonedock-sparkle-private.key
#    …move that file into the password manager, then delete it. On another Mac: generate_keys --account phonedock -f <file>
```

If the key is lost, copies already out there can't verify any later update: people would have to download the next
version by hand. If it leaks, rotate it in a release signed with the old key. The app also refuses any update that isn't
Developer ID signed by your team (see below), so a leaked key alone can't push someone else's app.

`build-app.sh --release` stops with a clear message if `app/sparkle-public-ed-key.txt` is missing.
`release-appcast.sh` stops if the private key isn't in the keychain or doesn't match the app's public key.

You also need a notarytool profile, as before:
`xcrun notarytool store-credentials phonedock-notary --apple-id <apple-id> --team-id <team-id>`.

Copies built before auto-update (0.1.0 without Sparkle) can't update themselves. People with those copies need to
download the first release that has it.

## Every release

1. **Bump the version** in `package.json` (`MAJOR.MINOR.PATCH`). The build number comes from it (see below).
2. **Build:**
   ```sh
   PHONEDOCK_NOTARY_PROFILE=phonedock-notary scripts/build-app.sh --release
   ```
   This signs everything with the Developer ID: Sparkle's helpers first, then the framework, node, and finally the
   app, all with the hardened runtime. It checks that every part has the app's Team ID, then notarizes, staples and
   checks with Gatekeeper. It writes `dist/PhoneDock-<version>.dmg`, `dist/PhoneDock-<version>.zip` and
   `dist/SHA256SUMS.txt`, then runs `scripts/release-appcast.sh` on the zip, which:
   - checks that the app in the zip is Developer ID signed, notarized and stapled, and that Gatekeeper accepts it;
   - signs the zip with the key in your keychain (`sign_update --account phonedock`) and verifies the signature against
     the app's own `SUPublicEDKey`;
   - adds the item to `site/appcast.xml`, newest first. The item has the version, build, length, signature, minimum
     macOS 15, Apple silicon only, and the release notes link
     `https://github.com/sushilk1991/phonedock/releases/tag/v<version>`. The script refuses if the appcast already has
     a newer build. A rebuilt release with the same build replaces its own item.
3. **Look at the diff:** `git diff site/appcast.xml`. There should be one new item, and the enclosure URL should be
   `https://github.com/sushilk1991/phonedock/releases/download/v<version>/PhoneDock-<version>.zip`.
4. **Publish the assets first:**
   ```sh
   gh release create v<version> dist/PhoneDock-<version>.dmg dist/PhoneDock-<version>.zip dist/SHA256SUMS.txt \
     --title "PhoneDock <version>" --notes-file <notes.md>
   ```
5. **Then publish the feed:** commit `site/appcast.xml` (and the version bump) and push to `main`. The Pages workflow
   deploys `site/`. Do it in this order so no copy is offered an archive that isn't on GitHub yet.
6. **Check:** `curl -s https://sushilk1991.github.io/phonedock/appcast.xml`. Then, in a copy of the previous version,
   choose PhoneDock › Check for Updates….

If the release script stops partway, fix the cause and run `scripts/release-appcast.sh dist/PhoneDock-<version>.zip`
on its own (`--help` lists its options). It changes nothing outside `site/appcast.xml`.

### Build numbers

Sparkle compares `CFBundleVersion`, not the version string. `build-app.sh` derives it as
`MAJOR × 1000000 + MINOR × 1000 + PATCH`: 0.1.0 → 1000, 0.2.0 → 2000, 1.4.12 → 1004012. Minor and patch stay under
1000. A pre-release version (`0.2.0-beta.1`) would share its build number with 0.2.0, so a release build of one needs
`PHONEDOCK_BUILD_NUMBER` set by hand. Never ship a build number twice, and never ship a lower one.

### Pulling a bad release

Remove its item from `site/appcast.xml` and push. Copies that haven't updated stop being offered it. Copies that
already updated stay on it, so ship a fixed, higher version (a copy never downgrades).

## What protects an update

- **The feed** is HTTPS on GitHub Pages and lists only HTTPS archives (`release-appcast.sh` insists).
- **EdDSA:** Sparkle checks the archive's signature against the app's `SUPublicEDKey` before it unpacks anything
  (`SUVerifyUpdateBeforeExtraction`). A changed byte means nothing is installed.
- **Code signing:** after Sparkle unpacks the update, and before it installs anything, `UpdateVerifier.swift` checks
  the new app:
  - its signature is valid (strict, all architectures, nested code);
  - it has the same identifier, and it's a Developer ID Application certificate with the running app's Team ID;
  - the hardened runtime is on;
  - it's the build that was offered.
  
  Sparkle on its own would accept a different team as long as the EdDSA signature is valid, and this check closes that
  gap. If the check fails, the update is cancelled and the sidebar says "Couldn’t verify the update".
- **Install:** Sparkle's installer replaces the app where it is (usually /Applications) and relaunches it. It refuses to
  run from a disk image or a translocated (quarantined, not moved) copy, and the sidebar then asks to move PhoneDock to
  Applications. The new copy isn't quarantined, and Sparkle never installs an older build.

The checks rely on Sparkle's internals in two places. `UpdateVerifier.stagedUpdate` reads where Sparkle's installer
unpacks an update (`~/Library/Caches/<bundle id>[.sparkle]/org.sparkle-project.Sparkle/Installation/…`). If it
can't find the update there, it refuses to install, so it fails safe. That's why the Sparkle version is pinned
exactly. **When you bump Sparkle, run the local update test below before releasing.**

## Testing the update path locally

Use throwaway copies and a throwaway key. Never use /Applications/PhoneDock.app or the production key.

1. **Make a throwaway key** and keep it out of the repo:
   ```sh
   app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock-test
   PUB=$(app/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account phonedock-test -p)
   ```
   Delete it afterwards in Keychain Access ("Private key for signing Sparkle updates", account `phonedock-test`).
2. **Build two versions** into a scratch folder. They are ad-hoc signed. The test key goes in, and the bundle id is
   changed so the test copies share nothing with your real app (preferences, Sparkle's cache):
   ```sh
   PHONEDOCK_DIST=/tmp/pd-old PHONEDOCK_SPARKLE_PUBLIC_KEY="$PUB" scripts/build-app.sh
   PHONEDOCK_DIST=/tmp/pd-new PHONEDOCK_VERSION=0.1.1-test PHONEDOCK_BUILD_NUMBER=1001 \
     PHONEDOCK_SPARKLE_PUBLIC_KEY="$PUB" scripts/build-app.sh
   ```
   In each copy, set `CFBundleIdentifier` to `dev.phonedock.pdtest.app` and add an `LSEnvironment` dict with
   `PHONEDOCK_UPDATE_FEED_URL=http://127.0.0.1:47561/appcast.xml` and `PHONEDOCK_PORT=<your test port>`. Do it with
   PlistBuddy, then run `codesign --force --deep -s -` on the copy. LSEnvironment survives Sparkle's relaunch, which a
   shell variable wouldn't. The app accepts a feed override only for a loopback address.
3. **Make the feed** from the new copy:
   ```sh
   mkdir /tmp/pd-feed && ditto -c -k --sequesterRsrc --keepParent /tmp/pd-new/PhoneDock.app /tmp/pd-feed/PhoneDock-0.1.1-test.zip
   cp site/appcast.xml /tmp/pd-feed/appcast.xml
   scripts/release-appcast.sh --local-test --account phonedock-test --appcast /tmp/pd-feed/appcast.xml \
     --download-url-prefix http://127.0.0.1:47561/ --release-notes-url http://127.0.0.1:47561/notes.html \
     /tmp/pd-feed/PhoneDock-0.1.1-test.zip
   python3 -m http.server 47561 --bind 127.0.0.1 --directory /tmp/pd-feed
   ```
4. **Open the old copy** with `open /tmp/pd-old/PhoneDock.app`. About 8 seconds after launch the sidebar shows
   "PhoneDock 0.1.1-test · Update". Click Update. The app downloads, quits, and reopens as 0.1.1-test; About PhoneDock
   and Settings › General › Updates show build 1001. The daemon the old copy started is replaced by the new version's
   (`curl -s http://127.0.0.1:<port>/v1/health` reports the new version).
   Launch with `open`, never by running `Contents/MacOS/PhoneDock` from a terminal. Started that way, the terminal is
   the responsible process, macOS App Management hides write access to the bundle, and Sparkle asks for an admin
   password, which real users never see.
5. **Tamper test:** flip one byte in the middle of the zip, keep the appcast, start again from a fresh old copy, and
   click Update. The sidebar says "Couldn’t verify the update", and the old copy stays on 0.1.0.
6. **Clean up:** quit the copies, then run `defaults delete dev.phonedock.pdtest.app` and
   `rm -rf ~/Library/Caches/dev.phonedock.pdtest.app.sparkle`. Delete the test key.

Copies that aren't Developer ID signed are checked for the same identifier and a valid signature only. The team check
needs real Developer ID builds, so check it on the first real release: update a copy of the previous release from the
live feed. (Done for 0.2.2 → 0.2.3 on 2026-11-05: no password prompt, about 3 s from Update to the relaunched app.)
