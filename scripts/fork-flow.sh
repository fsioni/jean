#!/usr/bin/env bash
# fork-flow.sh — workflow git du fork Jean (fsioni/jean) au-dessus de coollabsio/jean.
#
# Convention des remotes de CE repo (inversée par rapport à l'usuel) :
#   origin = coollabsio/jean   -> l'upstream, la base publique
#   fork   = fsioni/jean       -> TA version (upstream + tes features perso/équipe)
#
# fork/main = ta version intégrée : c'est ce que tu build et utilises au quotidien.
#
# Décision au démarrage d'une feature :
#   - elle partira en PR upstream (coollabsio)  -> `fork-flow up <nom>`    (base = coollabsio/main)
#   - elle reste perso/équipe (jamais upstream) -> `fork-flow perso <nom>` (base = fork/main)
#
# Règle d'or : une branche destinée à l'upstream NE DOIT JAMAIS être basée sur fork/main,
#              sinon le diff de la PR embarque tous tes patches perso.

set -euo pipefail

UPSTREAM="${FORK_FLOW_UPSTREAM:-origin}"                   # coollabsio/jean (la base)
MINE="${FORK_FLOW_MINE:-fork}"                             # fsioni/jean (ta version)
INTEGRATION="${FORK_FLOW_INTEGRATION:-fork-main-update}"   # branche locale d'intégration (= fork/main)

die() { echo "fork-flow: $*" >&2; exit 1; }

require_remote() {
  git remote get-url "$1" >/dev/null 2>&1 \
    || die "remote '$1' introuvable — configure-le ou exporte FORK_FLOW_UPSTREAM / FORK_FLOW_MINE."
}

check_convention() {
  require_remote "$UPSTREAM"
  require_remote "$MINE"
  local up mine
  up="$(git remote get-url "$UPSTREAM")"
  mine="$(git remote get-url "$MINE")"
  case "$up"   in *coollabsio*) ;; *) echo "fork-flow: ⚠ '$UPSTREAM' ne pointe pas vers coollabsio ($up)" >&2 ;; esac
  case "$mine" in *fsioni*)     ;; *) echo "fork-flow: ⚠ '$MINE' ne pointe pas vers fsioni ($mine)" >&2 ;; esac
}

# Se placer sur la branche d'intégration, alignée sur fork/main (ff-only, refuse si divergence).
ensure_integration() {
  if git show-ref --verify --quiet "refs/heads/$INTEGRATION"; then
    git switch "$INTEGRATION"
    git merge --ff-only "$MINE/main" \
      || die "'$INTEGRATION' diverge de $MINE/main — résous-le avant de continuer."
  else
    git switch -c "$INTEGRATION" "$MINE/main"
  fi
}

# Merge $1 (ref) dans la branche d'intégration et affiche le push à faire. $2 = libellé humain.
merge_into_integration() {
  echo "→ merge de $2 dans $INTEGRATION (= fork/main)…"
  if git merge --no-edit "$1"; then
    cat <<EOF
✓ $2 intégré. Build/teste, puis publie ta version :
    git push $MINE $INTEGRATION:main
EOF
  else
    cat <<EOF
⚠ Conflits — résous-les, puis :
    git add -A && git commit
    git push $MINE $INTEGRATION:main
EOF
  fi
}

cmd_up() {
  [ "$#" -eq 1 ] || die "usage: fork-flow up <nom-de-branche>"
  check_convention
  git fetch "$UPSTREAM"
  git switch -c "$1" "$UPSTREAM/main"
  cat <<EOF
✓ '$1' créée depuis $UPSTREAM/main (coollabsio) — destinée à l'UPSTREAM.
  Pousser : git push -u $MINE $1
  Puis ouvrir la PR vers coollabsio/jean depuis fsioni/jean.
  Pour l'utiliser AVANT son merge upstream : fork-flow preview $1
EOF
}

cmd_perso() {
  [ "$#" -eq 1 ] || die "usage: fork-flow perso <nom-de-branche>"
  check_convention
  git fetch "$MINE"
  git switch -c "$1" "$MINE/main"
  cat <<EOF
✓ '$1' créée depuis $MINE/main (ta version) — PERSO/ÉQUIPE, ne part pas upstream.
  Pousser : git push -u $MINE $1
  Puis intègre dans $MINE/main : PR interne sur le fork, ou fork-flow land $1
EOF
}

# Intègre une branche dans fork/main. Sert à 2 cas (même mécanique) :
#   - lander une feature perso/équipe
#   - prévisualiser une branche upstream-bound avant son merge upstream (alias `preview`)
cmd_land() {
  [ "$#" -eq 1 ] || die "usage: fork-flow land|preview <branche>"
  check_convention
  git fetch "$MINE"
  ensure_integration
  merge_into_integration "$1" "'$1'"
}

cmd_sync() {
  check_convention
  git fetch "$UPSTREAM"
  git fetch "$MINE"
  ensure_integration
  merge_into_integration "$UPSTREAM/main" "$UPSTREAM/main (coollabsio)"
}

cmd_status() {
  check_convention
  git fetch -q "$UPSTREAM" "$MINE" 2>/dev/null || true
  local ba behind ahead cur
  ba="$(git rev-list --left-right --count "$UPSTREAM/main...$MINE/main")"
  behind="$(printf '%s' "$ba" | cut -f1)"
  ahead="$(printf '%s' "$ba" | cut -f2)"
  echo "ta version (fork/main) vs base (coollabsio/main) :"
  echo "   en retard de ${behind} | en avance de ${ahead}  (le retard se rattrape via \`fork-flow sync\`)"
  cur="$(git branch --show-current 2>/dev/null || true)"
  echo "branche courante : ${cur:-(détaché)}"
  echo "   commits depuis coollabsio/main : $(git rev-list --count "$UPSTREAM/main..HEAD" 2>/dev/null || echo '?')"
  echo "   commits depuis fork/main       : $(git rev-list --count "$MINE/main..HEAD" 2>/dev/null || echo '?')"
  echo "   (le plus petit indique ta base probable)"
}

usage() {
  cat <<EOF
fork-flow — workflow git du fork Jean

  fork-flow up <nom>          Feature destinée à une PR upstream  (base = coollabsio/main)
  fork-flow perso <nom>       Feature perso/équipe                (base = fork/main, jamais upstream)
  fork-flow land <branche>    Intègre une branche dans fork/main  (lander une feature perso)
  fork-flow preview <branche> Idem land — utiliser une branche upstream-bound AVANT son merge
  fork-flow sync              Merge-forward : rapatrie coollabsio/main dans ta version (fork/main)
  fork-flow status            Où j'en suis : divergence fork/main vs coollabsio + base de la branche

Remotes attendus : origin=coollabsio/jean (base), fork=fsioni/jean (ta version).
Surcharge : FORK_FLOW_UPSTREAM, FORK_FLOW_MINE, FORK_FLOW_INTEGRATION.
EOF
}

main() {
  [ "$#" -ge 1 ] || { usage; exit 1; }
  local cmd="$1"; shift
  case "$cmd" in
    up)             cmd_up "$@" ;;
    perso)          cmd_perso "$@" ;;
    land|preview)   cmd_land "$@" ;;
    sync)           cmd_sync "$@" ;;
    status)         cmd_status "$@" ;;
    -h|--help|help) usage ;;
    *)              die "commande inconnue '$cmd' (voir: fork-flow help)" ;;
  esac
}

main "$@"
