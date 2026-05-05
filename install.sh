#!/bin/bash
set -e
APP="$HOME/.local/share/win-explorer"
APPS="$HOME/.local/share/applications"
echo "╔════════════════════════════════════════════════╗"
echo "║  Fluent Explorer v1.4 — Installer              ║"
echo "║  Now with sharp (10-50x faster thumbnails)     ║"
echo "╚════════════════════════════════════════════════╝"

echo "[1/5] Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo "  → Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  ✓ Node $(node -v)"

echo "[2/5] Checking system dependencies..."
command -v ffmpeg &>/dev/null || sudo apt-get install -y ffmpeg
command -v smbclient &>/dev/null || sudo apt-get install -y smbclient 2>/dev/null || true
echo "  ✓ ffmpeg, smbclient"

echo "[3/5] Copying files..."
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$APP"
for f in package.json main.js preload.js explorer.html photos.html icon.svg uninstall.sh LICENSE README.md; do
  [ -f "$DIR/$f" ] && cp "$DIR/$f" "$APP/"
done

echo "[4/5] Installing Electron + sharp..."
cd "$APP"
npm install 2>&1 | tail -5
echo "  ✓ Dependencies installed"

echo "[5/5] Creating launchers..."
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
Name=Fluent Explorer
Comment=Windows 11 Style File Manager
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
Name=Fluent Photos
Comment=Windows 11 Style Photo Viewer
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
echo "║  ✓ Installed with sharp thumbnail engine!      ║"
echo "║  📁 Fluent Explorer → App Menu                 ║"
echo "║  🖼️  Fluent Photos   → App Menu                ║"
echo "╚════════════════════════════════════════════════╝"
