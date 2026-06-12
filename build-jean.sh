#!/usr/bin/env bash
# Build de "notre Jean" (fork fsioni/jean, branche main = notre version) puis
# installation dans ~/Documents avec un numero de version + icone + lanceur
# applicatif. A lancer depuis la racine du repo clone : ./build-jean.sh
set -euo pipefail
cd "$(dirname "$0")"

# bun / cargo sur le PATH ; charger Node 22 via nvm s'il est installe.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" && nvm use 22 >/dev/null 2>&1 || true
fi

# 1. Recuperer la derniere version de l'equipe.
git checkout main
git pull --ff-only

# 2. Compiler le binaire release (sans bundle = plus rapide).
bun install
bun run tauri build --no-bundle

BIN="$(pwd)/src-tauri/target/release/jean"

# 3. Copier dans ~/Documents avec un numero de build incremental (jamais
#    d'ecrasement). Nom : jean-<version>-build<N>.
DEST_DIR="$HOME/Documents"
APP_VERSION="$(node -p "require('./package.json').version")"
last=0
for f in "$DEST_DIR"/jean-"$APP_VERSION"-build*; do
  [ -e "$f" ] || continue
  n="${f##*-build}"
  [[ "$n" =~ ^[0-9]+$ ]] && ((n > last)) && last=$n
done
DEST="$DEST_DIR/jean-$APP_VERSION-build$((last + 1))"
cp "$BIN" "$DEST"
chmod +x "$DEST"

# 4. Integration bureau (icone + lanceur) : le binaire --no-bundle n'en a aucune.
#    Le .desktop doit s'appeler comme le binaire et declarer le meme
#    StartupWMClass pour que l'icone du dock soit bien associee (GNOME/Wayland).
binbase="$(basename "$DEST")"
buildn="${binbase##*-}"
for sz in 128 256 512; do
  icondir="$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps"
  mkdir -p "$icondir"
  cp -f "src-tauri/icons/${sz}x${sz}.png" "$icondir/jean.png"
done
apps="$HOME/.local/share/applications"
mkdir -p "$apps"
# Purger les lanceurs des builds precedents (menu propre) sans toucher a
# jean.desktop (AppImage officielle eventuelle).
rm -f "$apps"/jean-*-build*.desktop
cat > "$apps/$binbase.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jean (build $buildn)
Comment=Jean - fork equipe (fsioni/jean)
Exec="$DEST" %U
Icon=jean
Terminal=false
Categories=Development;
StartupWMClass=$binbase
StartupNotify=true
EOF
update-desktop-database "$apps" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo
echo "OK Binaire    : $DEST"
echo "OK Lanceur    : cherche \"Jean\" dans tes applications."
echo "Astuce : ferme le Jean officiel avant de lancer (memes donnees partagees)."
