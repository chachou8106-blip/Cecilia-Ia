# Système de plugins

## Emplacement

```
plugins/*.plugin.cjs
```

Les fichiers sont chargés par ordre alphabétique. Préfixe-les par un numéro
(`01-`, `02-`...) pour contrôler l'ordre d'exécution.

## Structure d'un plugin

```js
module.exports = {
  id: "mon-plugin",          // identifiant unique (obligatoire)
  name: "Mon plugin",
  version: "1.0.0",
  description: "Ce que fait le plugin.",
  enabled: true,             // false pour désactiver

  async beforeChat(ctx) { /* ... */ },
  async afterChat(ctx)  { /* ... */ }
};
```

## Hooks

### `beforeChat(ctx)`

Appelé avant l'appel au LLM.

`ctx` contient : `userId`, `user`, `message`, `persona`, et (cumulé entre
plugins) `systemPrompt`.

Retours possibles :

```js
// Ajouter/enrichir le prompt système
return { systemPrompt: "instruction additionnelle" };

// Bloquer la requête
return { block: true, reason: "raison technique", userMessage: "message affiché à l'utilisateur" };
```

### `afterChat(ctx)`

Appelé après génération. `ctx` contient en plus `reply`.

```js
return { reply: "réponse modifiée" };
```

## Bonnes pratiques

- Ne jamais contourner la modération ni encourager du contenu interdit.
- Garder les plugins petits et testables.
- Journaliser les comportements critiques côté serveur.
- Tester avec `npm run plugins` après chaque ajout.
