module.exports = {
  id: "affection-style",
  name: "Style affectueux premium",
  version: "1.0.0",
  description: "Rend le ton plus chaleureux sans enfreindre les règles.",
  enabled: true,

  async beforeChat(ctx) {
    return {
      systemPrompt: [
        ctx.systemPrompt || "",
        "Style additionnel : réponse chaleureuse, personnalisée, affectueuse, avec une présence émotionnelle naturelle.",
        "Éviter les réponses robotiques. Préférer des phrases vivantes et simples."
      ].join("\n")
    };
  }
};
