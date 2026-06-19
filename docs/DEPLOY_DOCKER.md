# Déploiement Docker

## Build & start

```bash
docker compose build
docker compose up -d app
```

Application : http://localhost:3000 (et `/mobile`).

## Accès à Ollama

Si Ollama tourne sur la machine hôte (et pas dans Docker), mets dans `.env` :

```env
OLLAMA_URL=http://host.docker.internal:11434
```

Puis :

```bash
docker compose up -d --build app
```

(Le service `app` déclare déjà `extra_hosts: host.docker.internal:host-gateway`.)

## Backup / maintenance via Docker

```bash
docker compose --profile tools run --rm backup
docker compose --profile tools run --rm maintenance
```

## Volumes persistants

- `./data` → base SQLite
- `./backups` → sauvegardes chiffrées `.aibak`
- `./.env` → secrets (monté en lecture seule)

## Healthcheck

Le conteneur exécute `node scripts/healthcheck.cjs` (GET `/api/health`) toutes
les 30 s.
