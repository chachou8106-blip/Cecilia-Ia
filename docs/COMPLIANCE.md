# Conformité locale / RGPD / sécurité

## Données traitées

- email local de connexion
- hash de mot de passe (bcrypt, coût 12)
- profil chiffré (nom, nom de l'IA, style relationnel)
- messages chiffrés (AES-256-GCM)
- souvenirs chiffrés (AES-256-GCM)
- logs d'audit techniques (HMAC chaînés)

## Droits utilisateur inclus

- export de ses données (`/api/export`)
- suppression de la conversation
- suppression des souvenirs
- suppression du compte (cascade SQLite)
- consentement confidentialité explicite
- désactivation du mode adulte

## Sécurité incluse

- chiffrement applicatif AES-256-GCM (messages, souvenirs, profil)
- SQLite local (WAL, foreign_keys ON)
- cookies `HttpOnly` + `SameSite=strict`
- protection CSRF (token par session)
- rate limiting (global, login, register, chat, tts)
- logs d'audit HMAC chaînés, vérifiables via `/api/admin/stats`

## Modération

Le système bloque, côté requête utilisateur **et** côté réponse du modèle :

- mineurs
- non-consentement / coercition
- violence sexuelle / exploitation / inceste
- atteinte à la vie privée (deepfake réel non consenti, etc.)
- haine / violence extrême

Le mode adulte exige la confirmation **18+** ET son activation volontaire.

## Si commercialisation

À ajouter impérativement avant toute mise en production publique :

- politique de confidentialité publique complète + CGU
- registre de traitement RGPD, durées de conservation explicites
- DPA avec les fournisseurs éventuels
- modération renforcée multi-couches + signalement utilisateur
- vérification d'âge proportionnée au risque légal
- journal des consentements
- HTTPS strict, rotation des secrets, sauvegardes chiffrées hors-site
- revue juridique
