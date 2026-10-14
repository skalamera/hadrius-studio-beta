#!/bin/bash
# Builds "Install Hadrius Studio.app", a double-click Mac installer with the team credentials baked in.
#
#   bash installer/build.sh             # bakes in this repo's .env
#   bash installer/build.sh other.env   # or another env file
#
# Output (in dist/, gitignored):
#   dist/Hadrius Studio Installer/       the app + READ ME FIRST.txt
#   dist/Hadrius Studio Installer.zip    the same folder zipped: share THIS (Slack DM, Drive)
#
# The zip contains working API keys and tokens. The GitHub repo is public, so never commit dist/ or
# a team.env, and share the zip only inside Hadrius. Rebuild and re-share after changing any key;
# running the new installer refreshes each teammate's .env.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
SRC_ENV="${1:-$REPO/.env}"
DIST="$REPO/dist"
APP_NAME="Install Hadrius Studio"
PKG_DIR="$DIST/Hadrius Studio Installer"
APP="$PKG_DIR/$APP_NAME.app"
ZIP="$DIST/Hadrius Studio Installer.zip"

# Keys that describe one machine rather than the team; everything else in .env ships.
#   PR_WATCH_USER must be set on ONE machine only (see .env.example), STUDIO_USER is a person,
#   KBS_BRIDGE_PORT has to match the port setup.sh registers, the rest are local paths/overrides.
MACHINE_ONLY='PR_WATCH_USER|STUDIO_USER|KBS_BRIDGE_PORT|KBS_PROFILE_DIR|KBS_COMPANY_ID|NARRATION_PROVIDER'
# Without these the install still works but a feature is dead on arrival.
EXPECTED='PYLON_API_TOKEN GEMINI_API_KEY ELEVENLABS_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN'

[[ "$(uname -s)" == Darwin ]] || { echo "Build this on a Mac (it needs osacompile and codesign)." >&2; exit 1; }
[[ -f "$SRC_ENV" ]] || { echo "No env file at $SRC_ENV" >&2; exit 1; }
if ! git check-ignore -q "$DIST/probe"; then
  echo "dist/ isn't gitignored. Add it to .gitignore first: the build puts credentials there." >&2
  exit 1
fi
for k in STUDIO_SHARED_SECRET STUDIO_LIBRARY_URL; do
  grep -qE "^$k=.+" "$SRC_ENV" || { echo "$SRC_ENV has no $k; the installer can't work without it." >&2; exit 1; }
done
for k in $EXPECTED; do
  grep -qE "^$k=.+" "$SRC_ENV" || echo "⚠ $SRC_ENV has no $k, so installs won't have it either."
done

rm -rf "$PKG_DIR" "$ZIP"
mkdir -p "$PKG_DIR"

echo "Compiling the app…"
osacompile -o "$APP" installer/Installer.applescript
RES="$APP/Contents/Resources"
cp installer/install.sh "$RES/install.sh"
chmod 755 "$RES/install.sh"

{
  echo "# Hadrius Studio team credentials, built $(date '+%Y-%m-%d %H:%M') by installer/build.sh. Internal only."
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=.+' "$SRC_ENV" | grep -vE "^($MACHINE_ONLY)=" || true
} > "$RES/team.env"
chmod 644 "$RES/team.env"

# App icon: the extension's logo. osacompile's asset-catalog icon (CFBundleIconName) wins over
# applet.icns, so drop it.
ICONSET="$(mktemp -d)/applet.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" extension/icons/logo.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) extension/icons/logo.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/applet.icns"
rm -rf "$(dirname "$ICONSET")" "$RES/Assets.car"

PLIST="$APP/Contents/Info.plist"
plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
plutil -replace CFBundleIdentifier -string com.hadrius.studio.installer "$PLIST"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$(date '+%Y.%m.%d')" "$PLIST"
plutil -replace NSAppleEventsUsageDescription -string "The installer opens Chrome's Extensions page for you." "$PLIST"

# Every file changed after osacompile signed the bundle, so sign it again (ad hoc). A stale
# signature makes macOS call a downloaded app "damaged", with no way to open it.
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

cat > "$PKG_DIR/READ ME FIRST.txt" <<'EOF'
Installing Hadrius Studio
=========================

1. Double-click "Install Hadrius Studio".

   The first time, macOS may say it "could not verify" the app. That's expected for an
   internal tool. Click Done, then:
     - Open System Settings > Privacy & Security.
     - Scroll down to the message about "Install Hadrius Studio" and click Open Anyway.
     - Enter your Mac password, then click Open Anyway again.
   (On macOS 14 or older: right-click the app, choose Open, then click Open.)

2. Click Install and wait 5 to 10 minutes. If macOS asks to install the "command line
   developer tools", click Install.

3. Follow the on-screen steps to add the extension to Chrome (about a minute).

4. Recommended: click Sign In to connect Claude.

Run the installer again any time to update, repair, or sign in to Claude.
Problem? Send Stephen the log: in Finder choose Go > Go to Folder, paste
~/Library/Logs/Hadrius Studio Installer and send install.log.
EOF

ditto -c -k --sequesterRsrc --keepParent "$PKG_DIR" "$ZIP"

echo
echo "✓ Built: $APP"
echo "✓ Share: $ZIP ($(du -h "$ZIP" | cut -f1 | tr -d ' '))"
echo "  Keys baked in: $(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$RES/team.env" | tr -d '=' | paste -sd' ' -)"
skipped="$(grep -oE "^($MACHINE_ONLY)=" "$SRC_ENV" | tr -d '=' | paste -sd' ' - || true)"
[[ -z "$skipped" ]] || echo "  Left out (this machine only): $skipped"
echo "  The zip holds live credentials: share it only inside Hadrius, never commit it."
