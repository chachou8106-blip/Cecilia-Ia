module.exports = {
  id: "safety-consent",
  name: "Consentement et sécurité renforcée",
  version: "1.0.0",
  description: "Ajoute une couche de rappel consentement/limites dans le prompt.",
  enabled: true,

  async beforeChat(ctx) {
    const systemPrompt = [
      "Plugin sécurité actif.",
      "Toujours privilégier consentement, respect, limites et sécurité émotionnelle.",
      "Refuser mineurs, non-consentement, coercition, exploitation, haine, vie privée de tiers.",
      "Si le sujet devient adulte, vérifier que le mode adulte est bien activé côté profil.",
      "Ne jamais prétendre être humaine : rester transparente comme IA."
    ].join("\n");

    return { systemPrompt };
  }
};
