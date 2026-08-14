#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/macos"
DIST_DIR="$PROJECT_DIR/dist"
APP_NAME="Group Relay"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
ICONSET="$BUILD_DIR/AppIcon.iconset"
DMG_PATH="$DIST_DIR/Group-Relay-macOS-arm64.dmg"
DMG_STAGE="$BUILD_DIR/dmg"

rm -rf "$BUILD_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$ICONSET" "$DIST_DIR"

xcrun swiftc \
  "$PROJECT_DIR/macos/GroupRelayApp.swift" \
  -o "$CONTENTS/MacOS/GroupRelay" \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework Security \
  -framework ServiceManagement \
  -framework WebKit

xcrun swiftc \
  "$PROJECT_DIR/macos/GroupRelayBridge.swift" \
  -o "$CONTENTS/MacOS/GroupRelayBridge" \
  -O \
  -target arm64-apple-macos13.0 \
  -framework Security

cp "$PROJECT_DIR/macos/Info.plist" "$CONTENTS/Info.plist"

# 仓库里的 DefaultRelayURL 是空的:烧一个会过期的临时隧道地址进安装包,只会让别人编译出来
# 默认连不上(这正是反馈里那条工单)。要给自己团队打包就在构建时传入口地址:
#   GROUP_RELAY_DEFAULT_URL=https://chat.example.com ./macos/build-macos.sh
# 不传就留空,客户端首启会直接问用户要地址。
if [ -n "${GROUP_RELAY_DEFAULT_URL:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :DefaultRelayURL $GROUP_RELAY_DEFAULT_URL" "$CONTENTS/Info.plist"
  echo "Bundled default server: $GROUP_RELAY_DEFAULT_URL"
else
  echo "No GROUP_RELAY_DEFAULT_URL set; the client will ask for the server address on first launch."
fi

SOURCE_ICON="$PROJECT_DIR/public/icon-512.png"
sips -z 16 16 "$SOURCE_ICON" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$SOURCE_ICON" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$SOURCE_ICON" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SOURCE_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"

codesign --force --deep --sign - "$APP_BUNDLE"

rm -rf "$DMG_STAGE"
mkdir -p "$DMG_STAGE"
cp -R "$APP_BUNDLE" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

echo "$APP_BUNDLE"
echo "$DMG_PATH"
