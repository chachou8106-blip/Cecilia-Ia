# Cloudflare Tunnel (optionnel)

## Option simple : Quick Tunnel (URL temporaire)

```bash
docker compose --profile tunnel up -d
docker compose logs -f cloudflared
```

Cloudflare affiche une URL `*.trycloudflare.com` temporaire.

## Option propre : tunnel nommé avec domaine

1. Crée un tunnel dans Cloudflare Zero Trust et récupère un **token**.
2. Dans `.env` :

```env
CF_TUNNEL_TOKEN=ton_token
COOKIE_SECURE=true
PUBLIC_BASE_URL=https://ton-domaine.example
```

3. Adapte la commande du service `cloudflared` dans `docker-compose.yml` :

```yaml
command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN}
```

## ⚠️ Avant toute exposition Internet

- `COOKIE_SECURE=true` (cookies seulement en HTTPS)
- `ALLOW_REGISTRATION=false` après avoir créé ton compte, ou impose `INVITE_CODE`
- mot de passe fort
- Cloudflare Access recommandé devant l'app
- sauvegardes régulières + secrets en lieu sûr
- voir `docs/COMPLIANCE.md`
