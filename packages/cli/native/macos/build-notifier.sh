#!/usr/bin/env bash
#
# Build (and optionally install / notarize) Ayo.app — the signed helper that puts
# the Ayo logo on macOS toasts. osascript can't set a notification icon, so the
# daemon posts through this bundle instead (see notify.ts).
#
#   ./build-notifier.sh                 # 2a: build + sign (Apple Development) → ./build
#   ./build-notifier.sh --install       #     also install to $AYO_DIR (default ~/.ayo)
#
#   # 2b (distribution): a Developer ID cert + a stored notary profile named "ayo-notary"
#   #   xcrun notarytool store-credentials ayo-notary --apple-id <id> --team-id <team> --password <app-specific-pw>
#   IDENTITY="Developer ID Application: Wilson Overfield (TEAMID)" NOTARIZE=1 ./build-notifier.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/AyoNotifier/main.swift"
PLIST="$HERE/AyoNotifier/Info.plist"
ICON_PNG="${ICON_PNG:-$HERE/../../assets/ayo.png}"
OUT="${OUT:-$HERE/build}"
APP="$OUT/Ayo.app"
IDENTITY="${IDENTITY:-}"
NOTARIZE="${NOTARIZE:-0}"
INSTALL=0; [ "${1:-}" = "--install" ] && INSTALL=1

if [ -z "$IDENTITY" ]; then
  echo "error: set IDENTITY to your codesigning certificate name. List yours with:" >&2
  echo "  security find-identity -v -p codesigning" >&2
  echo "then re-run, e.g.:  IDENTITY='Apple Development: Your Name (TEAMID)' $0" >&2
  exit 1
fi

echo "→ compiling AyoNotifier…"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O "$SRC" -o "$APP/Contents/MacOS/AyoNotifier" -framework Foundation -framework UserNotifications -framework AppKit
cp "$PLIST" "$APP/Contents/Info.plist"

echo "→ building AppIcon.icns from $ICON_PNG…"
ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z "$d" "$d" "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "→ signing as: $IDENTITY"
HARDENED=""; [ "$NOTARIZE" = "1" ] && HARDENED="--options runtime"
codesign --force --timestamp $HARDENED --sign "$IDENTITY" "$APP"
codesign --verify --verbose=2 "$APP"

if [ "$NOTARIZE" = "1" ]; then
  echo "→ notarizing (Developer ID + 'ayo-notary' keychain profile required)…"
  ZIP="$OUT/Ayo.zip"; rm -f "$ZIP"; ditto -c -k --keepParent "$APP" "$ZIP"
  xcrun notarytool submit "$ZIP" --keychain-profile ayo-notary --wait
  xcrun stapler staple "$APP"
fi

if [ "$INSTALL" = "1" ]; then
  DEST="${AYO_DIR:-$HOME/.ayo}"; mkdir -p "$DEST"
  rm -rf "$DEST/Ayo.app"; cp -R "$APP" "$DEST/Ayo.app"
  echo "→ installed to $DEST/Ayo.app"
fi

echo "✓ done: $APP"
