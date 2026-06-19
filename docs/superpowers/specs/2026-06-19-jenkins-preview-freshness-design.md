# Jenkins — Fraîcheur de la preview vs PR (design)

_2026-06-19 — branche `preview-freshness` (fork perso/équipe, ne remonte pas chez coollabsio)._

Étend le module Jenkins existant (`src-tauri/src/jenkins/`). **Ne réécrit rien.** Le module
gère déjà statut/stages/queue/re-run/notifs + `preview: Option<JenkinsBuild>` et `preview_url`
dans `assemble_status`. Il manque deux choses, décidées avec Farès :

1. **Fraîcheur** : « ma preview est-elle à jour avec ma PR ? » → comparer le commit du dernier
   build `deploy-preview` de la PR au **HEAD de la PR sur GitHub**.
2. **Accès** : surfacer l'URL preview via un **badge Preview dédié** dans la barre du worktree
   (pas seulement enfoui dans le popover Jenkins).

## 1. Récupérer le SHA du build preview

Le build `deploy-preview` checkout la branche source (`BRANCH`), pas un merge ref. Donc le
commit construit = tip de la branche au moment du build = comparable au `headRefOid` de la PR.

- **Étendre** `BUILDS_TREE` (client.rs) pour ramener le SHA git du build :
  `actions[parameters[name,value],lastBuiltRevision[SHA1,branch[name,SHA1]],remoteUrls,causes[...]]`.
- **Nouveau champ** `JenkinsBuild.commit_sha: Option<String>` (camelCase `commitSha`).
- **Extraction** (`parse.rs`, `extract_commit_sha(build, branch)`), par ordre de préférence :
  1. param ghprb `ghprbActualCommit` / `GIT_COMMIT` si full-hex (40) ;
  2. `hudson.plugins.git.util.BuildData.lastBuiltRevision.SHA1` — en choisissant le BuildData
     dont un `branch[].name` matche le param `BRANCH` (évite la BuildData de la shared library).
- Inoffensif pour `build-and-test` (le champ reste rempli ou `None`, non utilisé là).

## 2. Comparer au HEAD de la PR (GitHub)

Nouveau module `src-tauri/src/jenkins/freshness.rs` :

```rust
pub struct PreviewFreshness {        // camelCase
    pub status: String,              // UP_TO_DATE | STALE | BUILDING | NO_PREVIEW | UNKNOWN
    pub preview_sha: Option<String>, // SHA du build deploy-preview
    pub pr_head_sha: Option<String>, // headRefOid de la PR
    pub behind_by: Option<u32>,      // nb de commits de retard (best-effort)
}
```

- **Pure** `compute_freshness(preview, pr_head_sha, behind_by)` — unit-testée :
  - pas de preview → `NO_PREVIEW` ; preview en cours → `BUILDING` ;
  - SHA preview == HEAD (prefix-insensitive) → `UP_TO_DATE` (`behind_by = 0`) ;
  - SHA preview != HEAD → `STALE` (`behind_by` renseigné si dispo) ;
  - un des SHA manquant → `UNKNOWN`.
- **I/O** (sync, via `silent_command` comme `pr_status.rs`, appelées en `spawn_blocking`) :
  - `fetch_pr_head_sha(repo, pr_number, gh)` → `gh pr view <n> --json headRefOid --jq .headRefOid` ;
  - `fetch_behind_by(repo, base, head, gh)` → `gh api repos/{owner}/{repo}/compare/<base>...<head> --jq .ahead_by`
    (gh résout `{owner}/{repo}` depuis le repo ; appelé seulement si `STALE`).
- **Orchestrateur** `resolve_freshness(repo, pr_number, preview, gh)` enchaîne les deux.

Réutilise `worktree.path` (repo) + `worktree.pr_number`, et `resolve_gh_binary(&app)` (même
binaire que `pr_status.rs`).

## 3. Intégration (pas de nouvelle commande Tauri)

`JenkinsWorktreeStatus` gagne `preview_freshness: Option<PreviewFreshness>`. Calculé **après**
`assemble_status`, uniquement si un build preview existe :

- `get_jenkins_status` (à la demande, frontend) — charge `data` une fois (config + worktree).
- `poller.rs` (60 s, background) — déjà la boucle worktrees ; émet via `jenkins:status-update`.

Aucune commande ajoutée → rien à enregistrer dans `lib.rs` / `dispatch.rs`. Surface d'edit
minimale, merge-forward friendly.

## 4. UI — Badge Preview dédié

Nouveau `src/components/jenkins/PreviewBadge.tsx`, monté dans la barre du worktree
(`SessionChatModal.tsx`, à côté de `JenkinsStatusBadge`, **pas** `ChatWindow.tsx`). Réutilise
`useJenkinsStatus` (même `queryKey` → une seule requête partagée).

- Caché si pas de `previewUrl`.
- Pastille : vert `UP_TO_DATE` · ambre `STALE` (+ « en retard de N ») · bleu `BUILDING` · gris `UNKNOWN`.
- Clic → `openUrl(previewUrl)`. Tooltip/popover : libellé fraîcheur + SHA preview vs PR.

Types TS : `commitSha` sur `JenkinsBuild`, interface `PreviewFreshness`, `previewFreshness` sur
`JenkinsWorktreeStatus`.

## 5. Tests

- `parse.rs` : `extract_commit_sha` choisit la bonne BuildData (branche matchée), ignore la lib.
- Fixture `deploy-preview-builds.json` enrichie avec `lastBuiltRevision.SHA1` réalistes
  (non référencée ailleurs aujourd'hui).
- `freshness.rs` : tous les états de `compute_freshness` (up-to-date, stale, building, no preview, unknown).
- `bun run check:all`.

## Hors scope v1

- Pas de bouton « redéployer la preview » (séparé ; la preview se redéploie via son job).
- `behind_by` best-effort : si l'appel compare échoue, on affiche quand même `STALE` (SHA ≠ SHA).
```
