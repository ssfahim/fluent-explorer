#!/bin/bash
set -e
APP="$HOME/.local/share/win-explorer"
APPS="$HOME/.local/share/applications"
echo "╔════════════════════════════════════════════════╗"
echo "║  WinExplorer + WinPhotos v5 — Installer        ║"
echo "╚════════════════════════════════════════════════╝"

echo "[1/4] Checking dependencies..."
if ! command -v node &>/dev/null; then
  echo "  → Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  ✓ Node $(node -v)"
command -v ffmpeg &>/dev/null || sudo apt-get install -y ffmpeg
echo "  ✓ ffmpeg"
command -v smbclient &>/dev/null || sudo apt-get install -y smbclient 2>/dev/null || true
echo "  ✓ smbclient"

echo "[2/4] Copying files..."
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$APP"
for f in package.json main.js preload.js explorer.html photos.html icon.svg uninstall.sh; do
  [ -f "$DIR/$f" ] && cp "$DIR/$f" "$APP/"
done

echo "[3/4] Installing Electron..."
cd "$APP" && npm install --save-dev electron@28 2>&1 | tail -3
echo "  ✓ Electron ready"

echo "[4/4] Creating launchers..."
cat > "$APP/launch-explorer.sh" << 'EOF'
#!/bin/bash
cd "$HOME/.local/share/win-explorer"
./node_modules/.bin/electron main.js "$@"
EOF
chmod +x "$APP/launch-explorer.sh"

cat > "$APP/launch-photos.sh" << 'EOF'
#!/bin/bash
cd "$HOME/.local/share/win-explorer"
./node_modules/.bin/electron main.js --photos "" "${1:-$HOME/Pictures}" "$@"
EOF
chmod +x "$APP/launch-photos.sh"

ICON="$APP/icon.svg"
command -v rsvg-convert &>/dev/null && rsvg-convert -w 256 -h 256 "$APP/icon.svg" -o "$APP/icon.png" 2>/dev/null && ICON="$APP/icon.png"
mkdir -p "$APPS"

cat > "$APPS/win-explorer.desktop" << EOF
[Desktop Entry]
Name=WinExplorer
Comment=Windows 11 File Manager
Exec=$APP/launch-explorer.sh %U
Icon=$ICON
Terminal=false
Type=Application
Categories=System;FileTools;FileManager;
MimeType=inode/directory;
EOF
chmod +x "$APPS/win-explorer.desktop"

cat > "$APPS/win-photos.desktop" << EOF
[Desktop Entry]
Name=WinPhotos
Comment=Windows 11 Photo Viewer
Exec=$APP/launch-photos.sh %f
Icon=$ICON
Terminal=false
Type=Application
Categories=Graphics;Viewer;Photography;
MimeType=image/jpeg;image/png;image/gif;image/webp;image/bmp;
EOF
chmod +x "$APPS/win-photos.desktop"
update-desktop-database "$APPS" 2>/dev/null || true

echo ""
echo "╔════════════════════════════════════════════════╗"
echo "║  ✓ Installed!                                  ║"
echo "╠════════════════════════════════════════════════╣"
echo "║  📁 WinExplorer → App Menu or:                 ║"
echo "║     ~/.local/share/win-explorer/                ║"
echo "║     launch-explorer.sh                          ║"
echo "║  🖼️  WinPhotos → App Menu or:                   ║"
echo "║     ~/.local/share/win-explorer/                ║"
echo "║     launch-photos.sh                            ║"
echo "║                                                 ║"
echo "║  Set as defaults:                               ║"
echo "║   xdg-mime default win-explorer.desktop \\       ║"
echo "║     inode/directory                              ║"
echo "║   xdg-mime default win-photos.desktop \\         ║"
echo "║     image/jpeg image/png image/gif               ║"
echo "║                                                 ║"
echo "║  Uninstall:                                     ║"
echo "║   bash ~/.local/share/win-explorer/uninstall.sh ║"
echo "╚════════════════════════════════════════════════╝"
