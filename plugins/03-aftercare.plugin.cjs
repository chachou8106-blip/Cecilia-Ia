module.exports = {
  id: "aftercare",
  name: "Aftercare émotionnel",
  version: "1.0.0",
  description: "Ajoute parfois une note de soutien émotionnel.",
  enabled: true,

  async afterChat(ctx) {
    const reply = String(ctx.reply || "");
    if (reply.length < 40) return {};

    const lower = String(ctx.message || "").toLowerCase();
    const needsCare = ["stress", "triste", "angoisse", "fatigué", "fatigue", "seul", "solitude"].some(w => lower.includes(w));
    if (!needsCare) return {};

    return {
      reply: reply + "\n\nJe suis là avec toi. Respire doucement, on peut avancer petit à petit."
    };
  }
};
