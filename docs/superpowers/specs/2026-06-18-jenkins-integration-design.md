# Intégration Jenkins app-native (fsioni/jean#2)

Date : 2026-06-18 · Branche : `jenkins-integration` (feature perso/équipe, base `fork/main`,
ne remonte PAS chez coollabsio).

## 1. Objectif

Pain point n°1 du workflow Planexpo : suivre les jobs Jenkins de la PR/branche du worktree
courant sans re-vérifier manuellement. Trois besoins :

1. **Statut live** des jobs de la PR du worktree (vert/rouge, durée, lien), au niveau **stage**.
2. **Notifs desktop** quand un build casse / repasse au vert (même si le worktree n'est pas ouvert).
3. **Re-run** d'un job — surtout le stage flaky `Integration tests`.

## 2. Vérité terrain — API Jenkins (`https://jenkins.example.com`)

Confirmé en live (auth Basic `login:token`, user `ci-user`).

### Structure des jobs (jobs classiques à numéro global, PAS multibranch)

```
build-and-test_Launcher-on-pr   (FreeStyleProject)  ← entrée déclenchée par GitHub PR (plugin ghprb)
   └─ build-and-test            (WorkflowJob)        ← pipeline déclaratif parapluie
        stages: Pre-stage · Unit tests · Elm tests · AIO Build Test for PR ·
                AIO Build Master · Integration tests · AIO Build all clients for PR · Deploy preview
   deploy-preview               (WorkflowJob)        ← job autonome, déclenché en aval, alimente
                                                       https://<PR_ID>.preview.example.com/admin
```

Jobs autonomes aussi présents (`unit-tests`, `elm-tests`, `aio-build-test`, `integration-tests`
au pluriel, `test`, …) mais le **pipeline `build-and-test` est la source de vérité** pour une PR :
ses stages couvrent unit/elm/integration/aio/deploy.

> **Découverte clé :** le `integration-test` que Farès surveille = le **stage « Integration tests »
> du pipeline `build-and-test`**, pas un job racine (`/job/integration-test` → 404). Ça conditionne
> la fonctionnalité re-run (cf. §9).

### Mapping build → worktree (PR / branche)

Les builds portent l'identité de la PR **en paramètres** :

| Job | Paramètres utiles |
| --- | --- |
| `build-and-test_Launcher-on-pr` | `ghprbPullId` (= n° PR), `ghprbSourceBranch`, `ghprbPullLink`, `GIT_BRANCH` |
| `build-and-test` | **`PR_ID`** (= n° PR), **`BRANCH`**, `NODE`, `DEPLOY_BRANCH` |
| `deploy-preview` | **`PR_ID`**, `BRANCH`, `DEPLOY_BRANCH` |

→ **Clé de mapping = paramètre `PR_ID`** (fallback `BRANCH` == nom de branche du worktree pour
les builds sans PR). Jean connaît déjà le n° de PR par worktree (`projects/pr_status.rs`).

### Endpoints utilisés (lecture)

- Liste des builds d'un job + identité PR :
  `GET /job/<job>/api/json?tree=builds[number,result,building,timestamp,duration,url,actions[parameters[name,value],causes[shortDescription,upstreamProject,upstreamBuild]]]{0,30}`
- Détail des stages d'un build pipeline :
  `GET /job/build-and-test/<n>/wfapi/describe` → `stages[{name,status,durationMillis,...}]`
  (statuts : `SUCCESS` / `FAILED` / `NOT_EXECUTED` / `IN_PROGRESS` / `ABORTED`).
- CSRF : `GET /crumbIssuer/api/json` → `{crumb, crumbRequestField:"Jenkins-Crumb"}` (attaché aux POST).

### Endpoints utilisés (écriture / re-run)

- Re-run pipeline complet : `POST /job/build-and-test/buildWithParameters` (params recopiés du
  dernier build : `PR_ID`, `BRANCH`, `NODE`, `DEPLOY_BRANCH`) + header crumb.
- Restart d'un stage (pipeline déclaratif — l'action `RestartDeclarativePipelineAction` est présente
  sur les builds) : `POST /job/build-and-test/<n>/restart/restart` form `stageName=Integration tests`.
  À confirmer en impl ; fallback = re-run pipeline complet.

## 3. Architecture (approche B — validée)

Module **Rust neuf et isolé** `src-tauri/src/jenkins/` qui :

- expose des **commandes Tauri** de fetch/re-run (pilotage à la demande par le front, façon
  `github_actions.rs`) ;
- lance **sa propre tâche tokio de polling** périodique qui garde le dernier état connu en mémoire,
  détecte les **transitions** (cassé↔vert) et déclenche **notif native + event** (façon
  `background_tasks` mais sans toucher ce fichier partagé).

```
Front (TanStack Query)  ──invoke──▶  jenkins::commands  ──reqwest──▶  Jenkins REST
        ▲                                                                  │
        │  listen("jenkins:status-update")                                 │
        └────────────  app.emit  ◀── jenkins::poller (tokio loop, état en mémoire, notif native)
```

### Découpage du module

| Fichier | Rôle |
| --- | --- |
| `jenkins/mod.rs` | déclare les sous-modules, `pub use`, `start_poller(app)` |
| `jenkins/client.rs` | client reqwest : auth Basic, crumb, GET builds/wfapi, POST re-run |
| `jenkins/types.rs` | structs `#[serde(rename_all="camelCase")]` (API/command data) |
| `jenkins/poller.rs` | boucle tokio, état `HashMap`, détection transition, notif native, emit |
| `jenkins/commands.rs` | `#[tauri::command]` : get status, re-run, save config |

## 4. Modèle de données (`jenkins/types.rs`, camelCase)

```rust
#[serde(rename_all = "camelCase")]
struct JenkinsBuild { number: u64, result: Option<String>, building: bool,
                      timestamp_ms: i64, duration_ms: u64, url: String,
                      pr_id: Option<String>, branch: Option<String> }

#[serde(rename_all = "camelCase")]
struct JenkinsStage { name: String, status: String, duration_ms: u64 }

#[serde(rename_all = "camelCase")]
struct JenkinsWorktreeStatus {
    worktree_id: String, pr_id: Option<String>,
    pipeline: Option<JenkinsBuild>,        // dernier build-and-test de la PR
    stages: Vec<JenkinsStage>,             // via wfapi
    preview: Option<JenkinsBuild>,         // dernier deploy-preview de la PR
    preview_url: Option<String>,           // https://<PR_ID>.preview.example.com/admin
    overall_status: String,                // SUCCESS|FAILURE|BUILDING|UNKNOWN (agrégé)
    checked_at: i64,
}
```

Constantes Planexpo (YAGNI — par-projet configurable plus tard si besoin) :
`PIPELINE_JOB="build-and-test"`, `PREVIEW_JOB="deploy-preview"`, `PR_PARAM="PR_ID"`,
`INTEGRATION_STAGE="Integration tests"`, `POLL_INTERVAL=60s`.

## 5. Config (par-projet, pattern `linear_api_key`)

Ajout sur `Project` (`projects/types.rs`, snake_case persisté, `#[serde(default)]`) :
`jenkins_url: Option<String>`, `jenkins_user: Option<String>`, `jenkins_token: Option<String>`.

- Sauvegarde via **commande dédiée** `save_jenkins_config(project_id, url, user, token)` dans
  `jenkins/commands.rs` (mute le Project via `projects::storage`) — **n'étend PAS**
  `update_project_settings` (évite un point de contact dans un fichier partagé très mergé).
- UI : section « Jenkins » dans `GeneralPane.tsx` (URL + user + token), calquée sur la section Linear.
- URL + token **jamais en dur**. Token sensible : `skip_serializing_if`/masqué à l'affichage comme Linear.

## 6. Polling + notifications (`jenkins/poller.rs`)

- `start_poller(app)` spawné une fois au `setup` (une ligne, bloc balisé).
- Boucle toutes les 60 s : pour chaque projet avec config Jenkins → 1 fetch `build-and-test`
  (`{0,30}`) + 1 fetch `deploy-preview`, indexés par `PR_ID`. Pour chaque worktree ayant une PR
  (énumération via le même mécanisme que le PR-polling existant), on associe le build par `PR_ID`,
  on récupère les stages (wfapi) du build matché.
- État en mémoire `HashMap<(project_id, pr_id), last_overall_result>`. Sur build **terminé**
  (`building=false`, `result` non nul) :
  - `SUCCESS → FAILURE` : notif `❌ build-and-test cassé — PR #<id>` (+ stage en échec si dispo).
  - `FAILURE → SUCCESS` : notif `✅ build-and-test repassé au vert — PR #<id>`.
  - Notif native via `app.notification().builder()...show()` (plugin déjà configuré).
- Emit `app.emit("jenkins:status-update", JenkinsWorktreeStatus)` à chaque cycle pour rafraîchir le front.

## 7. Commandes Tauri (enregistrées dans `lib.rs` **et** `http_server/dispatch.rs`, bloc balisé)

| Commande | Args | Retour |
| --- | --- | --- |
| `get_jenkins_status` | `projectId`, `worktreeId`, `prId?`, `branch?` | `JenkinsWorktreeStatus` |
| `rerun_jenkins_pipeline` | `projectId`, `prId`/`branch` | `()` (toast) |
| `restart_jenkins_integration` | `projectId`, `buildNumber` | `()` (toast, fallback re-run complet) |
| `save_jenkins_config` | `projectId`, `url`, `user`, `token` | `Project` |

## 8. Frontend

- `src/types/jenkins.ts` : interfaces camelCase miroir des structs Rust.
- `src/services/jenkins.ts` :
  - `useJenkinsStatus(projectId, worktreeId, prId, { enabled, staleTime: 60s })` (TanStack Query).
  - `useJenkinsStatusEvents()` : `listen("jenkins:status-update")` → `queryClient.setQueryData`.
  - mutations `rerunJenkinsPipeline`, `restartJenkinsIntegration` avec toasts (`sonner`).
- UI :
  - `JenkinsStatusCard` (composant dédié) dans l'en-tête du worktree/chat (façon `FailedRunsBadge`) :
    badge global + liste de stages (dot coloré, durée, lien Jenkins), lien preview
    `https://<PR_ID>.preview.example.com/admin`, boutons « Re-run pipeline » et « Relancer Integration tests ».
  - Section Jenkins dans `GeneralPane.tsx`.

## 9. Re-run (granularité)

- **Re-run pipeline complet** (`buildWithParameters`) : robuste, mais ~37 min (coût observé).
- **Relancer Integration tests** (restart-from-stage) : ciblé, idéal pour le flaky. Endpoint
  déclaratif `restart/restart` ; **confirmer en impl**, sinon fallback re-run complet (signalé au user).
- v1 expose les deux boutons ; si restart-from-stage indisponible → toast explicite + re-run complet.

## 10. Tests

- **Rust** : parsing `builds[...]` + extraction `PR_ID`/`BRANCH` depuis `actions[].parameters` ;
  parsing `wfapi` stages ; agrégation `overall_status` ; détection de transition (machine d'état).
  Fixtures = réponses réelles capturées (anonymisées).
- **TS** : types + hook (`useJenkinsStatus`), rendu `JenkinsStatusCard` (vert/rouge/building),
  gating natif des affordances clavier (cf. CLAUDE.md web/mobile).
- **Manuel** (cf. §12).

## 11. Isolation merge-forward (points de contact dans fichiers partagés, tous balisés `// --- perso/jenkins ---`)

- `src-tauri/src/lib.rs` : `mod jenkins;`, ligne `jenkins::start_poller(app)` au setup, entrées `generate_handler!`.
- `src-tauri/src/http_server/dispatch.rs` : bras de match des commandes.
- `src-tauri/src/projects/types.rs` : 3 champs `jenkins_*` sur `Project`.
- `src/components/projects/panes/GeneralPane.tsx` : section Jenkins.
- Reste = fichiers **neufs** (zéro conflit).

## 12. Plan de test manuel

- `bun run check:all` vert (lint + types + tests Rust/TS).
- Settings → projet → section Jenkins : saisir URL `https://jenkins.example.com`, user `ci-user`,
  token ; sauver.
- Ouvrir un worktree lié à une PR ouverte → `JenkinsStatusCard` affiche le dernier `build-and-test`
  (badge + stages) et le lien preview.
- Cliquer « Relancer Integration tests » → toast succès, nouveau build visible côté Jenkins.
- Provoquer/attendre une bascule rouge↔vert → notif desktop reçue (worktree fermé inclus).

## 13. Hors périmètre v1 (YAGNI)

Logs console in-app (déjà récupérés autrement), multibranch, liste de jobs / noms de params
configurables (défauts Planexpo en dur), visualisation file d'attente / lock de sérialisation,
restart d'autres stages que Integration tests.
