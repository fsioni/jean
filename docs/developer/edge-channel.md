# Canal "edge" — auto-update de ta version (fork fsioni)

Ce fork ne suit plus les releases de `coollabsio` : il s'auto-met à jour vers **tes**
builds, produits à chaque push sur `main` par `.github/workflows/edge.yml`.

## Comment ça marche

1. Push sur `fork/main` (code app) → `edge.yml` build un **AppImage Linux** et une **app/DMG macOS universelle** signés pour l'updater.
2. Version = `<base>-edge.<run_number>` (monotone croissante → toujours « plus récent » en semver).
3. Publication sur une **release roulante `edge`** (assets écrasés à chaque build, URL stable).
4. Une fois les deux builds terminés, un unique job publie la release et régénère `latest.json` avec la même version pour `linux-x86_64`, `darwin-aarch64` et `darwin-x86_64`.
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
2. Télécharge l'AppImage (Linux) ou le DMG (macOS) depuis la release `edge` et remplace ton installation actuelle.
3. À partir de là, l'OTA repart avec ta clé → tu n'as plus rien à faire.

## Versioning edge

`github.run_number` est monotone par workflow → `0.1.56-edge.7 > 0.1.56-edge.6`. Quand la
base (`tauri.conf.json` → `version`) montera (ex. `0.1.57`), `0.1.57-edge.1` reste supérieur
à n'importe quel `0.1.56-edge.N`. Aucun tag git n'est créé (canal roulant).

## Pièges connus

- **`tauri.conf.json` = fichier du cœur.** Tes 2 lignes (`endpoints`, `pubkey`) **conflicteront**
  au merge-forward si coollabsio touche son updater. Conflit minuscule : garde **tes** valeurs.
- **Linux : AppImage uniquement** (x86_64). `latest.json` ne pointe **jamais** sur un `.deb`
  (cause de l'écran blanc / ENOEXEC). macOS utilise le même artefact universel pour Apple Silicon et Intel.
- **Signature macOS.** La signature Tauri de l’updater utilise `TAURI_PRIVATE_KEY`. Le workflow edge
  ne charge pas de certificat Apple : un secret de certificat absent ou invalide ne doit pas bloquer
  le build universel. La signature Developer ID et la notarisation restent réservées aux releases
  officielles qui disposent d'identifiants Apple valides.
- **Bascule d'équipe.** Quiconque rebuild `fork/main` obtient une app sur le canal edge avec ta
  clé. Nabil/Martin devront aussi faire le bootstrap (installer un build edge une fois).
- **Fréquence.** Edge build à chaque push de code app (les changements `docs/**`, `*.md`, etc.
  sont ignorés via `paths-ignore`). Build concurrente annulée par un nouveau push.

## Tester / vérifier

- Déclencher manuellement : onglet Actions → « Edge build (Linux + macOS) » → Run workflow.
- Vérifier le manifeste : `curl -sL https://github.com/fsioni/jean/releases/download/edge/latest.json`
  → doit contenir une version unique et les entrées Linux + macOS dans `platforms`.
- Dans l'app (build edge installé) : menu → Check for Updates → doit proposer la version supérieure.
