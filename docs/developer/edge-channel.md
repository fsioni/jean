# Canal "edge" — auto-update de ta version (fork fsioni)

Ce fork ne suit plus les releases de `coollabsio` : il s'auto-met à jour vers **tes**
builds, produits à chaque push sur `main` par `.github/workflows/edge.yml`.

## Comment ça marche

1. Push sur `fork/main` (code app) → `edge.yml` build un **AppImage Linux signé**.
2. Version = `<base>-edge.<run_number>` (monotone croissante → toujours « plus récent » en semver).
3. Publication sur une **release roulante `edge`** (assets écrasés à chaque build, URL stable).
4. `latest.json` (entrée `linux-x86_64`) est régénéré et pointe sur le `.AppImage.tar.gz` signé.
5. L'app interroge `https://github.com/fsioni/jean/releases/download/edge/latest.json`
   (configuré dans `tauri.conf.json` → `plugins.updater.endpoints`) et propose la maj.

La confiance repose sur **ta** clé : `tauri.conf.json` → `plugins.updater.pubkey` contient
ta clé publique ; le CI signe avec la privée (secret).

## Setup unique (à faire une fois)

### 1. Secrets sur `fsioni/jean`

La clé a été générée localement dans `~/.tauri/` :

- `~/.tauri/jean-edge.key` → secret **`TAURI_PRIVATE_KEY`**
- `~/.tauri/jean-edge.pass` → secret **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**

Pose-les via l'UI GitHub (Settings → Secrets and variables → Actions → New repository secret)
en collant le **contenu** de chaque fichier. ⚠️ Sauvegarde `~/.tauri/jean-edge.key` +
`~/.tauri/jean-edge.pass` en lieu sûr : sans eux, tu ne peux plus signer de maj.

### 2. Bootstrap de confiance (obligatoire, une fois)

Ton app installée fait encore confiance à la clé de coollabsio. Tant que tu n'as pas
**installé une fois** un build signé avec ta clé, l'updater refusera tes maj. Donc :

1. Laisse le premier build `edge` se terminer (push sur main, ou « Run workflow »).
2. Télécharge l'AppImage depuis la release `edge` et installe-le (remplace ton binaire actuel).
3. À partir de là, l'OTA repart avec ta clé → tu n'as plus rien à faire.

## Versioning edge

`github.run_number` est monotone par workflow → `0.1.56-edge.7 > 0.1.56-edge.6`. Quand la
base (`tauri.conf.json` → `version`) montera (ex. `0.1.57`), `0.1.57-edge.1` reste supérieur
à n'importe quel `0.1.56-edge.N`. Aucun tag git n'est créé (canal roulant).

## Pièges connus

- **`tauri.conf.json` = fichier du cœur.** Tes 2 lignes (`endpoints`, `pubkey`) **conflicteront**
  au merge-forward si coollabsio touche son updater. Conflit minuscule : garde **tes** valeurs.
- **AppImage uniquement** (Linux x86_64). `latest.json` ne pointe **jamais** sur un `.deb`
  (cause de l'écran blanc / ENOEXEC). Pas de macOS/Windows sur ce canal.
- **Bascule d'équipe.** Quiconque rebuild `fork/main` obtient une app sur le canal edge avec ta
  clé. Nabil/Martin devront aussi faire le bootstrap (installer un AppImage edge une fois).
- **Fréquence.** Edge build à chaque push de code app (les changements `docs/**`, `*.md`, etc.
  sont ignorés via `paths-ignore`). Build concurrente annulée par un nouveau push.

## Tester / vérifier

- Déclencher manuellement : onglet Actions → « Edge build (Linux) » → Run workflow.
- Vérifier le manifeste : `curl -sL https://github.com/fsioni/jean/releases/download/edge/latest.json`
  → doit contenir `version`, `platforms.linux-x86_64.{signature,url}`.
- Dans l'app (build edge installé) : menu → Check for Updates → doit proposer la version supérieure.
