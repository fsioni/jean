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

# 4. Integration bureau (icone + lanceur). Le binaire --no-bundle n'embarque
#    aucune icone. CLE Wayland/GNOME : l'icone + le nom du dock sont associes a
#    une fenetre via son app_id = nom de l'executable lance (verifie via
#    WAYLAND_DEBUG: set_app_id("<basename argv0>")). Le binaire versionne donne
#    donc un app_id qui CHANGE a chaque build (jean-<ver>-build<N>, avec des
#    points de version) -> association fragile, a refaire/reindexer a chaque
#    fois. On lance plutot via un symlink a nom STABLE "jean-team" : app_id
#    stable -> un seul .desktop, indexe une fois, qui matche tous les builds.
LINK="$DEST_DIR/jean-team"
ln -sfn "$DEST" "$LINK"

for sz in 128 256 512; do
  icondir="$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps"
  mkdir -p "$icondir"
  cp -f "src-tauri/icons/${sz}x${sz}.png" "$icondir/jean.png"
done

apps="$HOME/.local/share/applications"
mkdir -p "$apps"
# Purger d'anciens lanceurs versionnes (quand un .desktop par build etait cree)
# sans toucher a jean.desktop (AppImage officielle eventuelle).
rm -f "$apps"/jean-*-build*.desktop
# Un SEUL lanceur stable : nom de fichier + StartupWMClass = "jean-team" (= app_id
# du symlink), pour que GNOME associe icone/nom quel que soit le build courant.
cat > "$apps/jean-team.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jean (équipe) $APP_VERSION-build$((last + 1))
Comment=Jean — fork équipe fsioni/jean
Exec="$LINK" %U
Icon=jean
Terminal=false
Categories=Development;
StartupWMClass=jean-team
StartupNotify=true
EOF
update-desktop-database "$apps" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo
echo "OK Binaire    : $DEST"
echo "OK Symlink    : $LINK -> $(basename "$DEST")"
echo "OK Lanceur    : cherche \"Jean (équipe)\" dans tes applications,"
echo "                ou lance directement: $LINK"
echo "IMPORTANT : lance via le lanceur ou le symlink jean-team (PAS le binaire"
echo "            versionne), sinon l'icone/nom du dock ne s'associent pas."
echo "Astuce : ferme le Jean officiel avant de lancer (memes donnees partagees)."
