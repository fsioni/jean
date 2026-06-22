#!/usr/bin/env bash
# gh-fsioni — lancer `gh` en tant que compte **fsioni** SANS toucher au compte
# gh actif global.
#
# Pourquoi : `gh auth switch` mute un état partagé (le compte actif dans le
# keyring) → il **race** avec les autres agents/sessions qui utilisent `gh` en
# parallèle (et casse le chargement PR des repos boulot tant qu'on est sur
# fsioni). Un override `GH_TOKEN` **scopé au process** n'a aucun de ces effets :
# il ne modifie rien de partagé, le compte actif reste `fares-spottt`.
#
# À utiliser pour toute commande gh qui doit **agir** (commenter/fermer/éditer)
# sur `fsioni/jean` ou un autre repo possédé par fsioni.
#
# Usage :
#   scripts/gh-fsioni.sh issue close 5 --repo fsioni/jean --comment "…"
#   scripts/gh-fsioni.sh pr comment 12 --repo fsioni/jean --body "…"
#
# Override du binaire gh si besoin : GH_BIN=/usr/bin/gh scripts/gh-fsioni.sh …
set -euo pipefail

GH="${GH_BIN:-gh}"

token="$("$GH" auth token --user fsioni 2>/dev/null || true)"
if [ -z "$token" ]; then
  echo "gh-fsioni: pas de token pour le compte 'fsioni' — connecte-le d'abord :" >&2
  echo "           gh auth login  (compte fsioni)" >&2
  exit 1
fi

# GH_TOKEN est lu par gh à la place du keyring, uniquement pour ce process.
GH_TOKEN="$token" exec "$GH" "$@"
