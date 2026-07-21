# Mission Control — diagnostic d'échec + passage à l'agent (design #10)

_2026-07-21 — fork perso/équipe, ne remonte pas chez coollabsio._

Objectif : **ne plus retourner sur Jenkins**. Mission Control disait *qu'*un build cassait, jamais
*pourquoi* — la seule action possible était « Re-run » ou ouvrir Jenkins. Cette itération ajoute la
cause, les tests en échec, la file d'attente, l'état de rebase, et le passage en un clic à l'agent.

## 0. Correctif — la vue restait collée

`missionControlOpen` n'était remis à `false` que par la flèche retour et par « Ouvrir » : cliquer un
worktree dans la sidebar changeait la sélection sans quitter la vue. `useCloseMissionControlOnNavigate`
(monté depuis `MainWindowContent`) observe la cible de navigation et ferme la vue quand elle change.
Volontairement **hors des stores partagés** — un seul point de contact upstream (cf. `fork-workflow.md`).

## 1. Diagnostic d'échec (`get_jenkins_failure_report`)

### Ce que la chaîne Jenkins impose

Vérifié sur le contrôleur réel (`build-and-test` #7139) : le pipeline **orchestre** des jobs
downstream. Le log de la stage en échec ne contient que du markup de lien :

```
Scheduling project: <a …>elm-tests</a>
Starting building: <a …>elm-tests #6377</a>
Build <a …>elm-tests #6377</a> completed: FAILURE
```

⇒ s'arrêter au log de la stage ne donne **rien d'exploitable**. Le backend suit le downstream :

1. `wfapi/describe` → première stage `FAILED` (les suivantes échouent par cascade) → son `id`
2. `execution/node/<id>/wfapi/describe` → premier `stageFlowNode` FAILED (sinon le dernier : timeout)
3. `…/wfapi/log` → texte, dont on extrait `job #num` après strip du HTML
4. `logText/progressiveText` du downstream — `HEAD` donne `X-Text-Size`, donc seul le **tail** transite
5. `testReport/api/json` du downstream, si publié

### Nettoyage du log

Sans filtrage, le tail brut ne contient que du bruit (Slack, blobs base64, `[Pipeline]`) et rate
l'erreur. `clean_log_excerpt` retire ANSI + markup HTML + préfixes de bruit + lignes >200 car. sans
espace, compresse les lignes vides et garde les **120 dernières lignes utiles** (12 000 car. max).
Validé : l'erreur `TYPE MISMATCH` Elm (au milieu du log) survit ; le bruit de fin disparaît.

### Tests en échec

`errorDetails` est **vide chez jest** (vérifié sur `unit-tests` #7031) — tout est dans
`errorStackTrace`. `failure_message()` prend `errorDetails`, sinon la tête du stack trace sans les
frames `at …`. Cap à 15 cas ; `failedTestCount` porte le total réel.

### Coût

Plusieurs allers-retours Jenkins ⇒ **jamais dans le poller ni par ligne de liste**. La commande est
appelée à la demande (montage de `FailureReportPanel`), cache keyé par numéro de build
(`staleTime: Infinity` — l'échec d'un build fini ne change plus).

## 2. « Corriger avec Jean »

`useSendFailureToAgent` calque le flux upstream « investigate workflow run » (`WorkflowRunsModal`) :
réutilise une session vide (ou en crée une), envoie, puis navigue. Différence : le prompt **embarque
déjà** log + tests, il n'y a pas de CLI Jenkins à faire tourner. Modèle / mode / provider suivent les
réglages magic-prompt `investigate_workflow_run`, pour que les deux investigations CI se comportent
pareil. Le prompt demande explicitement de **ne pas maquiller un test flaky**.

## 3. File d'attente, rebase, notifications

- **File** : `JenkinsQueueItem` porte `position` / `total` (items des jobs pipeline triés par
  `inQueueSince`). Affiché en ligne (`2/5 · 8 min`) — plus besoin d'ouvrir la file Jenkins.
- **Rebase** : pas de build sur master chez Planexpo ; ce qui compte est « ma branche a-t-elle master ? ».
  Réutilise `behind_count` (live) / `cached_behind_count` (fallback), même précédence que `WorktreeItem`.
- **Notifications** : `PollMemory` remplace la map de résultats — même règle anti-spam (première
  observation = baseline) pour deux ajouts : preview repassée `UP_TO_DATE`, et build en file depuis
  plus de 15 min (une fois, réarmé à la sortie de file).

## 4. Couverture : les quatre formes d'une PR en cours

Mission Control ne listait que les worktrees dont Jean connaît le `pr_number`. Trois angles morts,
tous corrigés dans `classifyProjectRows` (pure, testée) :

| Forme      | Situation                                          | Statut CI vient de |
| ---------- | -------------------------------------------------- | ------------------ |
| `linked`   | worktree + PR enregistrée dans Jean                 | cache du poller    |
| `detached` | worktree sans `pr_number`, PR ouverte sur la branche | commande batch     |
| `no-pr`    | worktree sans PR (branche en cours)                 | — (trié en dernier)|
| orphan     | PR ouverte de l'utilisateur, aucun worktree actif    | commande batch     |

- **`detached`** : la ligne est affichée immédiatement, et `detect_and_link_pr` répare le lien en
  arrière-plan (une fois par worktree). Une fois persisté, le poller reprend la main.
- **orphan** : `is:open author:@me` via `search_github_prs` — le filtre par auteur est délibéré,
  les PR des collègues n'ont pas leur place ici. Action unique : « Récupérer » (`checkout_pr`, qui
  restaure un worktree archivé quand il en existe un).
- **Coût maîtrisé** : le poller n'itère que les worktrees PR-liés, donc `detached` et orphan n'ont
  pas de cache. `get_jenkins_statuses` (batch) fetch les listes de builds **une fois** pour tout le
  lot, au lieu de 4 requêtes par PR.

`GitHubPullRequest` gagne un champ `url` (optionnel), pour lier une PR qui n'a pas de worktree.

## Fixtures

`src-tauri/src/jenkins/tests/fixtures/` — captures **réelles** du contrôleur, anonymisées (hôtes,
chemins, noms de tests neutralisés ; structure intacte) : `wfapi-describe-failed.json`,
`wfapi-stage-node-failed.json`, `wfapi-node-log.json`, `elm-tests-console.log`,
`test-report-failed.json`.

## Reste ouvert

- Historique / flakiness par PR : écarté explicitement.
- Les requêtes `gh` (PR ouvertes + `author:@me`) ne portent que sur le **premier** projet Jenkins.
  Un second projet Jenkins n'aurait ni `detached` ni orphan — à généraliser le jour où ça arrive.
