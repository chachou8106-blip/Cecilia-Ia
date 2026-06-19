# Roadmap

Le code est volontairement **modulaire** (`config/product-modules.json`,
`plugins/`) pour rester 100 % évolutif. Pistes suivantes :

## Court terme
- Éditeur visuel de personnalités (au lieu d'un simple select)
- Résumés automatiques de session pour condenser la mémoire
- Mémoire typée avancée + scoring émotionnel + expiration
- Avatar 2D animé plus vivant (Live2D / VRM)

## Moyen terme
- **Whisper.cpp** local pour une dictée (STT) premium
- **XTTS / Coqui** local pour une voix encore plus naturelle
- Génération d'images **sûres** (portraits non explicites)
- Marketplace locale de personnalités (import/export validé)
- Router multi-modèles : local low-cost + API premium optionnelle

## Long terme (SaaS)
- Cloudflare Pages + Workers (gateway API)
- Supabase / Postgres + R2 pour backups
- Stripe (abonnement), onboarding email
- Monitoring produit + conformité RGPD commerciale complète
- Authentification 2FA, argon2id, chiffrement par utilisateur, rotation de clés

## Sécurité avancée
- argon2id à la place de bcrypt
- chiffrement par utilisateur (clé dérivée)
- 2FA, verrouillage de compte
- Cloudflare Access devant l'app
- export d'audit signé
