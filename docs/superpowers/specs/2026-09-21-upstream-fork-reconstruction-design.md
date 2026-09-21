# Reconstruction du fork Jean sur upstream/main

## Objectif

Repartir de `upstream/main` et réintégrer proprement les fonctionnalités encore utilisées du fork, selon l’architecture actuelle d’upstream. La migration ne doit pas conserver aveuglément les anciens fichiers ou conflits : chaque capacité est portée vers les nouveaux composants, commandes, stores et transports.

## Principes

- `upstream/main` est la nouvelle base de référence.
- L’ancienne `origin/main` est conservée sous une branche de sauvegarde avant remplacement.
- Une fonctionnalité déjà présente upstream n’est pas réimplémentée.
- Les fonctionnalités conservées sont adaptées aux patterns actuels : `jean-core`, commandes natives + WebSocket, TanStack Query pour les données persistantes, Zustand pour l’état UI, notifications toast pour les opérations de fond.
- Chaque lot doit compiler et avoir ses tests ciblés avant intégration du lot suivant.
- `bun run check:all` doit réussir avant le remplacement de `origin/main`.

## Périmètre conservé

### Jenkins / Planexpo

Conserver l’intégralité : statuts et badges par worktree, run en attente et dernier build, fraîcheur et disponibilité de preview, tentatives de tests d’intégration, relances complète et ciblée, notifications, diagnostic, lancement d’un agent de réparation, polling adaptatif, anciens builds purgés et contrôleurs sans `wfapi`.

### Pipeline IA métier

Conserver l’intégralité : reprise et finalisation de PR, tickets STUCK et sous-tâches ClickUp, passage en IN REVIEW, clôture après déploiement, prise en charge des drafts et accès direct via `gh`.

### ClickUp

Conserver uniquement l’affichage du statut d’un ticket et l’ouverture du ticket au clic. Supprimer l’auto-assignation, les changements de statut manuels et la sélection de liste Sprint, sauf quand une transition automatique fait partie du pipeline IA métier.

### Supervision locale

Conserver l’intégralité : processus supervisés, allocation de ports Jean, scripts favoris, standby, badges, redémarrage et suivi d’état.

### Création de worktrees orientée prompt

Conserver l’intégralité, adaptée au nouveau flux upstream : prompt avant création, modèles, skills, pièces jointes/images, mobile, persistance et récupération après interruption.

### Organisation de l’espace

Conserver la catégorisation par attention, la priorité métier standby et les indicateurs utiles dans les listes, en les intégrant au Canvas et aux sessions actuels d’upstream.

### Distribution Edge

Conserver le canal Edge du fork, les builds macOS/Linux, l’updater, la signature et l’identité macOS, les artefacts et les launchers internes.

### Correctifs transversaux

Conserver les correctifs encore pertinents qui ne sont pas déjà upstream : copie du chemin, restauration du prompt après annulation, notifications Linux/WebKitGTK, drag-and-drop, robustesse Codex, limites système macOS, identité GitHub par dépôt, avatars et méthode de merge autorisée. Les doublons upstream et les correctifs visant une architecture supprimée sont exclus.

## Périmètre supprimé ou fourni par upstream

- Mission Control : supprimé.
- Multiplexeur et split panes de terminaux du fork : supprimés.
- Attention Claude Code : supprimée ; Claude n’est plus utilisé.
- Attention Codex : utiliser l’implémentation upstream.
- Worktrees multi-remotes : utiliser l’implémentation upstream (`base_remote`).

## Architecture de migration

1. Créer une référence de sauvegarde de l’ancienne `origin/main`.
2. Rebaser la branche de synchronisation sur `upstream/main` sans reprendre l’ancien historique en bloc.
3. Porter les capacités par lots indépendants :
   1. fondations et correctifs transversaux ;
   2. supervision locale ;
   3. prompt-first ;
   4. organisation de l’espace ;
   5. Jenkins ;
   6. pipeline IA + ClickUp minimal ;
   7. Edge et distribution.
4. Pour chaque lot, comparer les anciens commits et l’état upstream afin de ne reprendre que le comportement manquant.
5. Enregistrer toutes les nouvelles commandes dans Tauri et dans le dispatch WebSocket.
6. Maintenir la compatibilité de sérialisation et de persistance avec les données utilisateur existantes lorsque ces données correspondent à une fonctionnalité conservée.

## Validation

- Tests unitaires ciblés à chaque lot.
- TypeScript : typecheck et lint.
- Rust : fmt, clippy et tests.
- Tests frontend complets.
- `bun run check:all` final.
- Vérification manuelle des parcours Jenkins, pipeline IA, création prompt-first, supervision locale et mise à jour Edge.
- Vérification que Mission Control, split panes, actions ClickUp supprimées et attention Claude ne restent pas exposés.

## Bascule

Après validation complète :

1. récupérer `origin/main` et `upstream/main` ;
2. vérifier que la branche migrée contient bien le dernier upstream ;
3. pousser la sauvegarde de l’ancienne main ;
4. remplacer `origin/main` par la branche migrée avec `--force-with-lease` ;
5. vérifier la CI et le canal Edge.
