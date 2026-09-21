# Fonctionnalités propres au fork

Cette matrice décrit les capacités à maintenir lors des synchronisations avec `coollabsio/jean`.

| Groupe | Décision | Commits sources principaux | Notes de migration |
|---|---|---|---|
| Jenkins / Planexpo | Porter intégralement | `6b8d1cf9`, `fc74bf88`, `d417a693`, `7adf7f07`, `902379b6`, `ede805b3`, `9984ed0d`, `6aaf102a`, `4d225885`, `05237c58`, `c7402d73`, `eb9e0f2b`, `4c506cc1`, `98ca5463`, `3d45d43b`, `498473d0`, `c09122ad`, `a4020a1d`, `82ec7b55`, `550a2f4d`, `21d30a29`, `6bd12f48`, `c34c8cc2` | Adapter aux listes/Canvas, caches et transports upstream. |
| Mission Control | Retirer | `05d6631f`, `e8c4e1e9` | Ne pas restaurer le dashboard global. Le diagnostic Jenkins reste conservé depuis les surfaces par worktree. |
| Pipeline IA métier | Porter intégralement | `83b57413`, `8d4c8150`, `996d0f31`, `e73a15aa`, `9a13673c`, `3fc7fe3e`, `88ef0d3d`, `be4c2760`, `ecde4cc0` | Conserver les transitions ClickUp automatiques nécessaires au workflow. |
| ClickUp général | Porter partiellement | `9cf89c11` | UI limitée au statut et au lien. Pas d’assignation ni changement manuel. `a9d57ea0` (liste Sprint) est exclu. |
| Split panes / multiplexeur | Retirer | `33027443`, `8a35eebc` | Utiliser le terminal upstream sans groupes du fork. |
| Attention CLI | Upstream | `d79d4ce1` | Codex est repris upstream dans `terminal/attention.rs`. Ne pas restaurer l’attention Claude (`410c81a0`). |
| Supervision locale | Porter intégralement | `a50a635b` | Processus, ports, favoris, standby, badges et redémarrage. |
| Prompt-first | Porter intégralement | `2ce4ae9a`, `f00f6718`, `ab2294dc`, `4f111146`, `fbf7ea6d`, `e371274b` | Adapter au compositeur, au Canvas et à la persistance upstream. |
| Multi-remotes | Upstream | `b446d110`, `f8afc5d8`, `894c08cc` | Fourni upstream via `base_remote`; ne pas restaurer. |
| Organisation par attention | Porter intégralement | `ea4d7236`, `444a2f4d` | Adapter aux statuts et sessions upstream. |
| Distribution Edge | Porter intégralement | `5b94c998`, `322758ce`, `9441689b`, `9999d4ac`, `93ae7e51`, `6d64a7e7`, `b6c7df4d`, `8a7b1e85`, `f6dc3383`, `479941cd` | Préserver identité macOS, artefacts updater et builds macOS/Linux. |
| Correctifs transversaux | Porter si encore manquants | `140dae1d`, `76eab7ae`, `a97fb287`, `53431da8`, `41f049b9`, `e147f7e6`, `d23bd4ff`, `e9fd8e97`, `4ee76add`, `96bf93f1`, `6bff9468`, `43f0637c`, `61c3036e`, `e772283b`, `77865d05`, `b1ef71bb`, `06b50552` | Vérifier chaque régression contre upstream avant portage. |

## Règles de synchronisation

1. Chercher d’abord l’équivalent upstream par test, symbole et historique.
2. Porter un comportement, jamais un ancien fichier complet, lorsque l’architecture a changé.
3. Ajouter toute nouvelle commande aux transports Tauri et WebSocket.
4. Garder des tests ciblés pour chaque comportement propre au fork.
5. Ne jamais versionner de secret Jenkins, ClickUp, GitHub ou de signature.
