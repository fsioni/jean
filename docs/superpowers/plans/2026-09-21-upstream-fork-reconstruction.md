# Upstream Fork Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruire le fork Jean sur `upstream/main` en conservant les fonctionnalités validées et en supprimant les capacités obsolètes.

**Architecture:** La branche de migration part exactement de `upstream/main`. Chaque capacité du fork est portée comme un lot cohérent en comparant son ancien commit à l’architecture upstream actuelle, sans fusion globale de l’ancien arbre.

**Tech Stack:** Tauri v2, Rust, React 19, TypeScript, Zustand 5, TanStack Query, Vitest 4, Bun, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-21-upstream-fork-reconstruction-design.md`

## Global Constraints

- `upstream/main` est la base unique.
- Conserver une branche distante de sauvegarde de l’ancienne `origin/main`.
- Toute commande Tauri ajoutée doit être enregistrée dans `jean-core/src/lib.rs` et `jean-core/src/http_server/dispatch.rs`.
- Les données persistantes restent en snake_case ; les structures d’API utilisent camelCase avec serde quand nécessaire.
- Ne pas réintroduire Mission Control, les split panes, l’attention Claude ou le code multi-remotes déjà upstream.
- `bun run check:all` doit réussir avant la bascule de `origin/main`.

---

### Task 1: Sécuriser la migration et établir la nouvelle base

**Files:**
- Create: `docs/superpowers/specs/2026-09-21-upstream-fork-reconstruction-design.md`
- Create: `docs/superpowers/plans/2026-09-21-upstream-fork-reconstruction.md`

**Interfaces:**
- Consumes: `origin/main`, `upstream/main`
- Produces: `backup/main-before-upstream-2026-09-21`, branche courante basée sur `upstream/main`

- [ ] Créer la branche de sauvegarde sur le SHA exact de `origin/main`.
- [ ] Archiver les documents de migration hors de l’arbre avant le reset.
- [ ] Réinitialiser `synchronisation-fork-upstream` sur `upstream/main`.
- [ ] Restaurer les documents et vérifier `git merge-base --is-ancestor upstream/main HEAD`.
- [ ] Exécuter `bun install` puis `bun run check:all` pour valider la base upstream.

### Task 2: Inventorier les patches et doublons upstream

**Files:**
- Create: `docs/developer/fork-features.md`

**Interfaces:**
- Consumes: commits uniques `upstream/main..origin/main`
- Produces: matrice fonctionnalité → commits → état (`porter`, `upstream`, `retirer`)

- [ ] Classer les commits par groupes validés.
- [ ] Comparer chaque patch avec les fichiers et commits upstream.
- [ ] Marquer Mission Control, terminal split, attention Claude et multi-remotes comme exclus.
- [ ] Enregistrer les commits sources de chaque capacité conservée.

### Task 3: Porter les correctifs transversaux encore nécessaires

**Files:**
- Modify selon comparaison: visionneuse de fichiers, chat, notifications, drag-and-drop, Codex, GitHub et plateforme macOS.
- Test: tests colocalisés existants.

**Interfaces:**
- Produces: correctifs isolés sans dépendance aux intégrations métier.

- [ ] Pour chaque correctif, écrire ou restaurer le test de régression.
- [ ] Vérifier que le test échoue sur la base upstream quand le bug subsiste.
- [ ] Porter le changement minimal dans le nouveau fichier upstream.
- [ ] Exclure le patch si upstream couvre déjà le scénario.
- [ ] Exécuter les tests ciblés, typecheck et tests Rust concernés.

### Task 4: Porter la supervision locale et les ports Jean

**Files:**
- Source historique: commit `a50a635b` et correctifs suivants.
- Modify: `jean-core/src/projects/*`, `jean-core/src/terminal/*`, `src/services/managed-runs.ts`, `src/services/projects.ts`, stores et composants de statut.
- Test: `src/services/run-config.test.ts`, tests Rust de supervision et tests de store.

**Interfaces:**
- Produces: scripts normalisés, processus supervisés, ports alloués, standby, favoris et statuts UI.

- [ ] Restaurer les tests de normalisation des scripts et d’allocation des ports.
- [ ] Adapter le superviseur aux types `Project`, `Worktree` et événements upstream.
- [ ] Enregistrer les commandes natives et WebSocket.
- [ ] Adapter le service frontend à TanStack Query et aux caches upstream.
- [ ] Restaurer les badges, favoris, standby et actions de redémarrage.
- [ ] Exécuter les tests ciblés, `bun run typecheck` et `cargo test` ciblé.

### Task 5: Porter le flux prompt-first

**Files:**
- Source historique: `2ce4ae9a`, `f00f6718`, `ab2294dc`, `4f111146`, `fbf7ea6d`, `e371274b`.
- Modify: composants `src/components/worktree/`, état chat/UI et persistance.
- Test: tests `NewSessionComposer`, récupération de prompt et stores.

**Interfaces:**
- Consumes: création de worktree upstream et support multi-remotes upstream.
- Produces: création différée pilotée par prompt, modèle, skills et pièces jointes.

- [ ] Restaurer les tests de cycle de vie du prompt en attente.
- [ ] Porter l’état minimal dans le store actuel avec gardes anti-no-op.
- [ ] Adapter le compositeur au modal et au Canvas upstream.
- [ ] Restaurer la persistance et récupération après interruption.
- [ ] Couvrir desktop, web et mobile.
- [ ] Exécuter les tests ciblés et le typecheck.

### Task 6: Porter l’organisation de l’espace

**Files:**
- Source historique: `ea4d7236`, `444a2f4d`.
- Modify: Canvas, listes de sessions/worktrees et sélecteurs de store.
- Test: tests de tri et catégorisation.

**Interfaces:**
- Produces: catégories par attention avec priorité standby métier.

- [ ] Restaurer les tests de classement.
- [ ] Adapter les catégories aux statuts et sessions upstream.
- [ ] Utiliser des sélecteurs Zustand sur les données, jamais sur les getters.
- [ ] Vérifier desktop, web et mobile.

### Task 7: Porter Jenkins / Planexpo

**Files:**
- Source historique: commits Jenkins de `6b8d1cf9` à `c34c8cc2`.
- Create/Modify: modules Rust Jenkins, `src/services/jenkins.ts`, types, hooks, badges et popovers.
- Test: tests Rust Jenkins et `src/services/jenkins.test.tsx`.

**Interfaces:**
- Produces: état de pipeline, preview, relances, diagnostic et réparation automatique.

- [ ] Restaurer les tests de parsing pour les états queued/build/test/deploy.
- [ ] Porter le client Jenkins et sa configuration sans secret versionné.
- [ ] Enregistrer toutes les commandes dans les transports natif et WebSocket.
- [ ] Restaurer le polling adaptatif et les invalidations de cache.
- [ ] Porter badges et popovers dans les nouvelles listes/Canvas.
- [ ] Porter fraîcheur/offline preview et compteurs de retry.
- [ ] Porter relances complète/ciblée, diagnostic et réparation automatique.
- [ ] Exécuter tests frontend/Rust ciblés puis typecheck et clippy.

### Task 8: Porter le pipeline IA et ClickUp minimal

**Files:**
- Source historique: commits `83b57413`, `8d4c8150`, `996d0f31`, `e73a15aa`, `9a13673c`, `3fc7fe3e`, `88ef0d3d`, `be4c2760`, `ecde4cc0`.
- Modify: `src/services/ai-pipeline.ts`, `src/services/clickup.ts`, types, menus de worktree et commandes Rust.
- Test: tests ClickUp et pipeline IA.

**Interfaces:**
- Consumes: statuts Jenkins et liens PR/worktree.
- Produces: reprise/finalisation de PR, transitions automatiques ClickUp et clôture après déploiement.

- [ ] Restaurer les tests de détection des tickets et PR éligibles.
- [ ] Porter la lecture via `gh` et les sous-tâches ClickUp.
- [ ] Porter les transitions automatiques IN REVIEW et déployé.
- [ ] Exposer seulement statut + lien ClickUp dans l’UI générale.
- [ ] Supprimer auto-assignation, édition manuelle et liste Sprint.
- [ ] Exécuter tests ciblés et typecheck.

### Task 9: Porter le canal Edge

**Files:**
- Source historique: commits Edge/build de `5b94c998` à `479941cd`.
- Modify: workflows GitHub, config Tauri/updater, scripts de build et docs release.
- Test: validations YAML, build metadata et tests updater existants.

**Interfaces:**
- Produces: builds macOS/Linux et mises à jour signées du fork.

- [ ] Adapter les workflows aux versions et chemins upstream.
- [ ] Préserver l’identité bundle macOS et la configuration du canal.
- [ ] Restaurer la génération/publication des artefacts updater.
- [ ] Restaurer les launchers internes sans secret dans le dépôt.
- [ ] Valider les workflows et builds locaux disponibles.

### Task 10: Nettoyage, validation et bascule

**Files:**
- Modify: documentation développeur et notes de migration.

**Interfaces:**
- Produces: nouvelle `origin/main` vérifiée et sauvegarde distante de l’ancienne main.

- [ ] Rechercher et supprimer les restes Mission Control, terminal split et attention Claude.
- [ ] Exécuter `bun run check:all` jusqu’au succès complet.
- [ ] Effectuer les smoke tests manuels documentés.
- [ ] Récupérer `origin/main` et `upstream/main`, puis revérifier l’absence de conflit/dérive.
- [ ] Pousser la branche de sauvegarde.
- [ ] Pousser la branche migrée sur une branche distante de revue.
- [ ] Après vérification, remplacer `origin/main` avec `--force-with-lease`.
- [ ] Vérifier la CI et le canal Edge.
