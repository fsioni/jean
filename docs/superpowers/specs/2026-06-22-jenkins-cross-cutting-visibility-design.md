# Jenkins — Visibilité transverse + diagnostic notifs (design #8)

_2026-06-22 — branche `jenkins-visibility` (fork perso/équipe, ne remonte pas chez coollabsio)._

Étend le module Jenkins existant (`src-tauri/src/jenkins/`). **Ne réécrit rien.** Le poller global
(`jenkins::start_poller`, spawné une fois dans `lib.rs`) itère déjà tous les worktrees à PR de tous
les projets, émet `jenkins:status-update` par worktree toutes les 60 s, et notifie sur transition
rouge↔vert. Côté front, `useJenkinsStatusEvents()` (monté dans `MainWindow`) pousse déjà chaque
event dans le cache TanStack keyé par `worktreeId`. Les badges `JenkinsStatusBadge` / `PreviewBadge`
ne s'affichent que **dans** le worktree.

Deux objectifs (issue #8), prioritaires avant le dashboard #9 :

1. **Badge Jenkins (+ preview) dans la LISTE des worktrees** — visible sans entrer dans le worktree.
2. **Diagnostiquer / corriger l'absence de notifs** alors que le poller émet sur transition.

---

## 1. Badge transverse dans la liste des worktrees

### Source de données — consommation passive du cache (zéro fetch en plus)

Le poller broadcast **déjà** le statut de chaque worktree à PR toutes les 60 s, et
`useJenkinsStatusEvents()` écrit ces payloads dans `queryKey = ['jenkins','status',worktreeId]`.
Le premier `poll_cycle()` s'exécute **immédiatement** au démarrage (la boucle poll *puis* sleep),
donc le cache se remplit en ~1 latence réseau.

⇒ Les rows de liste **ne doivent PAS appeler `useJenkinsStatus()`** (qui déclenche un `invoke
get_jenkins_status` par row, soit N fetchs redondants au mount + tous les 60 s). On lit **uniquement
le cache** alimenté par le poller global :

```ts
// src/services/jenkins.ts — nouveau hook lecture-seule
export function useJenkinsStatusCached(worktreeId: string | null) {
  return useQuery<JenkinsWorktreeStatus>({
    queryKey: jenkinsQueryKeys.status(worktreeId ?? ''),
    queryFn: () => { throw new Error('cache-only') }, // jamais appelé
    enabled: false,            // pas de fetch ; re-render via setQueryData des events
    staleTime: Infinity,
  })
}
```

`setQueryData` (fait par `useJenkinsStatusEvents`) notifie les abonnés ⇒ les badges se
rafraîchissent en quasi temps réel sans requête supplémentaire. Robuste à N worktrees.

### Composant compact partagé

Nouveau `src/components/jenkins/WorktreeStatusDot.tsx` (variante compacte, dédiée liste) :

- Rend un point/pastille selon `overallStatus` : 🟢 `SUCCESS` · 🔴 `FAILURE` · 🟡 `BUILDING`/`QUEUED` ·
  rien si `UNKNOWN` (pas de PR / pas encore pollé) — sauf cas « non configuré » ci-dessous.
- Optionnel : micro-dot de fraîcheur preview (réutilise la logique couleur de `PreviewBadge`).
- **Non interactif en v1** (tooltip seulement) — le popover détaillé reste dans le worktree. Évite
  de dupliquer le popover et garde la row légère.
- Ne rend rien si le worktree n'a pas de `pr_number`.

### Points d'insertion (rows **niveau worktree**)

Les vrais rows worktree (avec `pr_number`, `id`, `branch`, `projectId`) :

- `src/components/projects/WorktreeItem.tsx` — sidebar : après les badges git (behind/unpushed).
- `src/components/dashboard/ProjectCanvasView.tsx` → `WorktreeSectionHeader` — canvas : après
  `GitStatusBadges` (~ligne 681), avant les pills de label.

> Note : `SessionListRow.tsx` est **niveau session** (pas de contexte worktree/PR direct) — on ne
> l'instrumente pas en v1 ; le badge vit au niveau worktree, là où vit la PR.

---

## 2. Diagnostic « je ne reçois pas de notif »

Approche **systematic-debugging** : instrumenter → observer en dev → corriger le vrai bloqueur.
Causes candidates identifiées par lecture du code (`poller.rs`), de la plus probable à la moins :

| # | Cause | Preuve dans le code | Correctif |
|---|-------|---------------------|-----------|
| A | **Baseline silencieuse + état en mémoire.** `last_results` est un `HashMap` en mémoire, remis à zéro à chaque lancement. 1ᵉʳ cycle ⇒ `detect_transition(None, X) → None` : aucune notif. On n'est notifié que si le build **bascule pendant que l'app tourne**. | `poller.rs:32` (HashMap local), `:119-124`, `detect_transition` ignore `prev=None` | **Voulu** (anti-spam au démarrage). On ne « corrige » pas, mais on **log** la baseline (voir D) pour la rendre observable, et on ajoute un **bouton test** (E) pour valider le canal OS indépendamment. |
| B | **Worktree sans `pr_number`.** Le poller skip tout worktree dont `pr_number == None`. Si Jean n'a pas lié le n° de PR au worktree, il est invisible au poller. | `poller.rs:64-66`, `pr_number: Option<u32>` (`projects/types.rs:218`) | Log debug du skip + vérifier en dev que les worktrees de Farès ont bien `pr_number`. Hint UI : badge grisé si PR mais projet non configuré (cause C). |
| C | **Config Jenkins absente/non lue.** Projet sans url/user/token ⇒ `continue` silencieux. | `poller.rs:50-52`, `config::config_from_project` | **Hint clair en contexte** : si un worktree a une PR mais que le projet n'a pas de config Jenkins, le badge liste rend une pastille grise « CI ⚙ » + tooltip « Jenkins non configuré — Réglages du projet ». |
| D | **Zéro observabilité.** Tout est `log::trace!` ⇒ invisible en Info (prod). Impossible de savoir si le poller tourne/matche/notifie. | `poller.rs:36,154` | Passer en `log::info!` : résumé par cycle (`N projets configurés, M worktrees à PR pollés`) + log quand une notif est **émise**. Skips en `debug`. |
| E | **Permission OS / DND (surtout macOS) ; plugin notif initialisé 2×.** Le `.show()` Rust contourne la gate JS ; sur Linux ça passe en général via le démon, sur macOS il faut la permission accordée. `tauri_plugin_notification::init()` est enregistré **deux fois**. | `lib.rs:3527` **et** `:3546` | (1) Supprimer le doublon d'`init()`. (2) Hook front `useNotificationPermission()` (`@tauri-apps/plugin-notification`) appelé au démarrage : `isPermissionGranted()` → sinon `requestPermission()`. (3) **Bouton « Envoyer une notif test »** dans les Réglages projet (section Jenkins) pour isoler le canal OS du pipeline Jenkins. |

### Plan d'action #2 (ordre)
1. Instrumenter (D) + supprimer doublon init (E1) → lancer `bun run tauri:dev`, observer les logs :
   combien de projets configurés ? combien de worktrees pollés ? une transition se produit-elle ?
2. Selon l'observation : si 0 worktree pollé ⇒ cause B/C (PR non liée ou config absente) → hint UI (C)
   + vérif `pr_number`. Si worktrees pollés mais pas de notif au flip ⇒ canal OS (E) → permission + test.
3. Le **bouton test notif** (E3) + le **hint config** (C) sont livrés dans tous les cas : ils rendent
   le système auto-diagnostiquable sans relire les logs.

---

## Contraintes & périmètre
- Reste dans `src-tauri/src/jenkins/` + composants `src/components/jenkins/` dédiés. Touche aux rows
  worktree (`WorktreeItem`, `WorktreeSectionHeader`) — **possédés par cette session**.
- Pas de nouvelle commande backend indispensable (lecture cache only). Si un bouton « test notif »
  passe par une commande Rust → l'enregistrer dans `lib.rs` **et** `dispatch.rs`. Sinon, faire le
  `requestPermission`/`sendNotification` côté front via le plugin (pas de commande).
- Fork **public** : aucun domaine/secret en dur (URL preview déjà via `jenkins_preview_url_template`).
- `bun run check:all` vert + tests (hook cache-only, rendu badge selon `overallStatus`, gating
  `pr_number`/config). Commits sur `jenkins-visibility`.

## Hors périmètre (→ #9)
Dashboard « mission control » (vue unique tous worktrees, stages, re-run depuis la liste, durées).
Construit ensuite sur la même donnée poll-ée.

---

## Suite (2026-07-21) — pastilles muettes : rétention Jenkins, pas `pr_number`

Symptôme rapporté : la CI/preview ne s'affiche pas pour certains worktrees à PR
(ex. `pr-4143-CU-86cahukqt-vue-exposant-readonly`), « selon comment la branche a
été créée ».

**Ce n'était pas la cause B** (`pr_number` manquant) : le worktree l'avait bien.
Mesure sur le contrôleur réel : `build-and-test` ne **retient que ~23 builds**
(~6 h de CI) — demander `{0,300}` renvoie toujours 23, les autres sont purgés.
`match_build()` ne trouvait donc rien pour toute PR construite quelques heures
plus tôt ⇒ `overallStatus = UNKNOWN` ⇒ la row **ne rendait rien**, ce qui se lit
comme « la feature est cassée ». La variable n'était pas le mode de création de
la branche mais **la date du dernier build**.

Corrections :

1. **Fallback GitHub** (`jenkins/gh_checks.rs`). Le verdict survit en commit
   status sur la tête de PR (écrit par ghprb) ; GitHub le garde indéfiniment.
   Un seul `gh pr list --json number,headRefOid,statusCheckRollup` par projet et
   par cycle reconstruit le verdict de toutes les PR ouvertes. Utilisé
   uniquement quand Jenkins n'a plus de build ; `verdictSource`
   (`jenkins` | `github` | `none`) le dit à l'UI, qui l'annonce en tooltip.
2. **Le même appel renvoie `headRefOid`**, réutilisé par la sonde de fraîcheur
   preview : supprime un `gh pr view` par worktree et par cycle. Net, le poller
   fait **moins** de sous-processus qu'avant.
3. **Poller : worktrees archivés ignorés** (`archived_at.is_none()`) — 21
   worktrees pollés pour 5 actifs avant le correctif.
4. **Plus jamais de row muette** : `WorktreeCiStatus` affiche « CI inconnu »
   (icône + texte + tooltip, jamais la couleur seule) quand ni Jenkins ni GitHub
   n'a de verdict, et ne rend rien que dans les cas légitimes (pas de PR, projet
   pas encore chargé, ligne pas encore pollée).
