# Workflow du fork (fsioni/jean au-dessus de coollabsio/jean)

Ce repo est un **fork avec patches downstream** : on suit l'upstream public
`coollabsio/jean` tout en y empilant des features **perso/équipe** qui ne
remontent pas en PR (intégration Jenkins, workflows internes, etc.).

## Modèle mental

| Remote   | Pointe vers       | Rôle                                                   |
| -------- | ----------------- | ------------------------------------------------------ |
| `origin` | `coollabsio/jean` | **L'upstream, la base.** Source de vérité publique.    |
| `fork`   | `fsioni/jean`     | **Ta version** = upstream + tes features perso/équipe. |

> ⚠️ Nommage inversé par rapport à l'usuel (`origin` = upstream, pas ton fork).
> C'est volontaire et cohérent partout ; `fork-flow.sh` encapsule ces noms pour
> t'éviter de te tromper. `git push origin …` échoue (pas de droits sur
> coollabsio) — c'est un garde-fou, pas un bug.

- **`fork/main`** = ta version intégrée. C'est ce que tu build (`build-jean.sh`)
  et utilises au quotidien. Si un jour l'équipe l'adopte, elle hérite de tes outils.
- **`origin/main`** = coollabsio. On n'y commit jamais directement ; on le rapatrie.

## La décision au démarrage d'une feature

> **Cette feature partira-t-elle en PR sur coollabsio ?**

```
OUI (upstream-bound)              NON (perso / équipe)
   │                                 │
   ▼                                 ▼
base = origin/main (coollabsio)   base = fork/main (ta version)
fork-flow up <nom>                fork-flow perso <nom>
   │                                 │
   ▼                                 ▼
push fork → PR vers coollabsio    push fork → merge dans fork/main
```

**Selon comment tu démarres la feature :**

- **Worktree Jean** (ton cas habituel) : la décision = le `baseBranch` passé à la
  création du worktree → `origin/main` (upstream-bound) ou `fork/main` (perso).
  Le nom auto-généré (`terra-newt`…) n'a aucune importance, seule la base compte.
- **Checkout classique** (ex. le repo principal `~/dev/jean`) : `fork-flow up <nom>`
  ou `fork-flow perso <nom>`. À lancer hors d'un worktree Jean (ça fait un
  `git switch -c` sur place).

**Règle d'or :** une branche destinée à l'upstream ne doit **jamais** être basée
sur `fork/main` — sinon le diff de la PR embarque tous tes patches perso.

Pour utiliser une feature upstream-bound *avant* qu'elle soit mergée chez
coollabsio : merge sa branche dans `fork/main`. Tes commits reviendront
proprement lors du prochain `sync` (git reconnaît les patches déjà présents).

## Le script `scripts/fork-flow.sh`

```bash
fork-flow up <nom>          # feature pour PR upstream   (base = coollabsio/main)
fork-flow perso <nom>       # feature perso/équipe       (base = fork/main)
fork-flow land <branche>    # intègre une branche dans fork/main (lander une feature perso)
fork-flow preview <branche> # idem land — utiliser une branche upstream-bound AVANT son merge
fork-flow sync              # merge-forward coollabsio → fork/main
fork-flow status            # divergence fork/main vs coollabsio + base de la branche courante
```

### Utiliser une PR upstream avant qu'elle soit mergée

Une seule branche, basée sur `coollabsio/main` (`fork-flow up`). Tu ouvres la PR
vers coollabsio **et** tu intègres la même branche dans ta version :

```bash
fork-flow preview <branche>   # merge la branche dans fork/main (= fork-main-update)
git push fork fork-main-update:main
```

Pas de seconde PR. Quand l'upstream merge ta PR, le prochain `fork-flow sync`
réconcilie : si upstream a mergé tel quel → rien à faire ; s'il a **squashé/rebasé**
→ au pire un petit conflit (contenu identique) à résoudre une fois. Si la PR évolue
en review, re-lance `fork-flow preview <branche>` pour rester synchro.

> `land` et `preview` sont la même commande : merge d'une branche dans `fork/main`.
> Deux noms juste pour l'intention (feature perso permanente vs aperçu temporaire).

Alias pratique (à ajouter à `~/.zshrc`) :

```bash
alias ff="$(git rev-parse --show-toplevel)/scripts/fork-flow.sh"
```

`fork-flow sync` opère sur la branche locale `fork-main-update` (ta branche
d'intégration existante, alignée sur `fork/main`), merge `origin/main` dedans,
puis t'indique le push à faire (`git push fork fork-main-update:main`) — il ne
pousse jamais tout seul, pour te laisser build/tester d'abord.

## Garder les merges peu coûteux (crucial pour le code perso dans l'app)

Le code Jenkins/workflows vit dans l'app (Rust + React), donc isole-le pour que
les merge-forward ne génèrent presque jamais de conflits :

- **Fichiers/modules neufs** plutôt que des edits dans le cœur. Un nouveau
  fichier ne conflicte jamais. Ex. `src-tauri/src/jenkins/`, des composants React dédiés.
- **Minimise les points de contact** dans les fichiers partagés. Les
  incontournables (cf. `CLAUDE.md`) : enregistrement des commandes dans
  `src-tauri/src/lib.rs` (`generate_handler![]`) **et** `http_server/dispatch.rs`.
  Groupe tes ajouts dans un bloc balisé (`// --- perso/jenkins ---`) pour
  localiser les conflits.
- **Secrets & URLs en config, jamais en dur.** L'URL Jenkins, le token, etc.
  passent par les settings/env → `fork/main` reste partageable avec l'équipe et propre.
- Optionnel : un feature flag pour activer/désactiver le bloc perso.

## Cadence

- `fork-flow sync` régulièrement (hebdo, ou dès que coollabsio a du neuf utile).
  Plus tes patches perso sont petits et isolés, moins le merge coûte.
- Pousse upstream tout ce qui est générique : ça réduit ton delta privé et donc
  le coût des futurs merges.
