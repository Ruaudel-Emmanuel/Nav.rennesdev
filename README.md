# Nav.rennesdev — navigateur web léger côté VPS (v1)

Service web sur **https://nav.rennesdev.fr** : un « navigateur » minimaliste où c'est **le VPS qui charge les pages**. Barre d'adresse → le VPS télécharge la page, la nettoie (scripts supprimés, tracking réduit) et la sert en **mode lecture** ; les liens restent cliquables et sont **routés par le VPS** (navigation de page en page).

## Feuille de route

- **v1 (ceci)** : navigateur simple et léger. Le contenu des pages passe par le serveur.
- **v2 (à venir, branche dédiée)** : **assistant IA intégré** (bouton « Demander à l'IA ») — résumé / Q&A sur la page affichée via API ou LLM local (Ollama). Comme la page est déjà côté VPS, l'IA la lit **directement** : plus besoin de copier-coller (c'est la limite d'ÉCLAIREUR que Nav corrige). ÉCLAIREUR devient le moteur interne de la v2.

## Architecture

| Élément | Détail |
|---|---|
| Frontal | Caddy (service host) — vhost `nav.rennesdev.fr` (basic auth, credentials `/etc/caddy/nav-auth.txt` root 600) → reverse_proxy `127.0.0.1:8086` |
| Service | conteneur `nav_rennesdev` (`node:22-alpine`, zéro dépendance npm) — `~/projects/Nav.rennesdev/docker-compose.yml`, port 127.0.0.1:8086 |
| App | `app/server.js` (un seul fichier) |
| Réseau | Docker `apps` (pour brancher Ollama à la v2) |

## Fonctionnement

- `GET /` : accueil — barre d'adresse + historique local (localStorage, 50 dernières pages)
- `GET /go?url=<url encodée>` : lecteur — page nettoyée + barre de navigation (accueil, retour, adresse, lien vers l'original)
- `GET /health` : 200 (pour le watchdog)

### Nettoyage appliqué aux pages
- suppression de `<script>`, `<style>`, `<iframe>`, `<svg>`, formulaires, `<video>/<audio>`, commentaires, attributs `on*`/`style`/`class`/`id`/`data-*`/`srcset`
- liens réécrits vers `/go?url=…` (relatifs résolus, entités HTML décodées, `&` protégé en `%26`)
- images conservées (chargées directement par le navigateur du client, URL absolues)
- sélection du contenu : `<article>` sinon `<main>` sinon `<body>` ; titre extrait pour l'historique
- charset géré (header HTTP + meta, fallback utf-8)

### Garde-fous
| Risque | Protection |
|---|---|
| SSRF (réseaux privés/Tailscale) | résolution DNS + blocage IP privées (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10 CGNAT, fc00::/7, fe80::/10, multicast) ; http/https uniquement |
| Abus (proxy ouvert) | basic auth Caddy + service lié à 127.0.0.1 |
| DoS | timeout 20 s, max 3 Mo, max 5 redirections |
| Exécution de code | aucun JS servi pour les pages tierces (2 mini-scripts inline maison uniquement) |
| Injection HTML dans le chrome | titres/liens échappés (`escHtml`), historique rendu via `textContent` (pas d'innerHTML) |

## Pièges rencontrés (déploiement 19/09)

1. **Entités HTML dans les attributs** : le source contient `&` — il faut décoder AVANT résolution d'URL, sinon double-encodage (`%25C3%25BC`).
2. **Double encodage des liens** : `URL.href` est déjà encodé — ne pas re-passer `encodeURIComponent` ; protéger seulement le `&` du paramètre (`%26`).
3. Échappements HTML : construire les entités par concaténation JS (`'\u0026amp;'`) — fiable et lisible.

## Opérations courantes

```bash
# état du service
curl -s http://127.0.0.1:8086/health
docker ps --filter name=nav_rennesdev

# redémarrer (depuis le dossier du projet)
cd ~/projects/Nav.rennesdev && docker compose restart

# lire les identifiants du basic auth
sudo cat /etc/caddy/nav-auth.txt
```

## Tests effectués (19/09)

- navigation wiki sur 2 niveaux (lien interne suivi et re-rendu) ✅
- liens avec query `&` → rechargés correctement ✅
- erreurs propres : DNS inconnu, HTTP 404, contenu non HTML (image), protocole interdit, SSRF (127.0.0.1 / IP Tailscale bloquées) ✅
- unitaires `decodeEntites` / `escHtml` / `escText` ✅
- HTTPS via Cloudflare : 401 sans auth / 200 avec auth ✅
