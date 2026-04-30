#!/bin/bash
echo "Uninstalling WinExplorer + WinPhotos..."
rm -rf "$HOME/.local/share/win-explorer"
rm -rf "$HOME/.cache/winex-thumbs"
rm -f "$HOME/.local/share/applications/win-explorer.desktop"
rm -f "$HOME/.local/share/applications/win-photos.desktop"
rm -f "$HOME/.config/winex-"*.json
update-desktop-database "$HOME/.local/share/applications/" 2>/dev/null || true
echo "✓ Removed."
