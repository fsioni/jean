#!/usr/bin/env bash
# jean-dev.sh — lance le dev Jean avec le bon environnement.
#
# Pourquoi ce script : `bun` n'est ajouté au PATH que dans ~/.zshrc (shells
# interactifs). Lancé depuis un shell non-interactif (launcher, `zsh -c`, etc.)
# seul ~/.zshenv est lu — qui met Node 18 (pour planexpo) mais ni bun ni Node 22.
# Or Jean a besoin de Node 22 + bun + cargo. Ce launcher prépare tout ça.
#
# Usage : ./scripts/jean-dev.sh   (depuis n'importe où)

set -euo pipefail

# Node 22 via nvm (prioritaire sur le Node 18 de ~/.local/bin).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || echo "jean-dev: ⚠ Node 22 introuvable via nvm (nvm install 22)" >&2
fi

# bun + cargo en tête de PATH.
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

command -v bun  >/dev/null 2>&1 || { echo "jean-dev: bun introuvable (~/.bun/bin/bun ?)" >&2; exit 1; }
command -v cargo >/dev/null 2>&1 || echo "jean-dev: ⚠ cargo introuvable (~/.cargo/bin) — le build Rust échouera" >&2

# Racine du repo = parent de scripts/.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "jean-dev: node $(node -v 2>/dev/null) · bun $(bun --version 2>/dev/null) — bun run tauri:dev"
exec bun run tauri:dev "$@"
