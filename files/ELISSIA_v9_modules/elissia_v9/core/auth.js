// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — auth.js : Session, CSRF, Auth middleware, Rate limit
// ═══════════════════════════════════════════════════════════════
const { db, encryptText, decryptText, hmac, sha256, id, now, json, parseJson, clean } = require('./db');
// ══ SESSIONS ══════════════════════════════════════════════════
function createSession(userId, req, res) {
  const raw  = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(32).toString("hex");
  const sid  = id();
  const exp  = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)")
    .run(sid, userId, sha256(raw), sha256(csrf), now(), exp);
  res.cookie("sid", sid + "." + raw, { httpOnly: true, sameSite: "strict",
    secure: String(process.env.COOKIE_SECURE || "false") === "true", path: "/", maxAge: SESSION_DAYS * 86400000 });
  return csrf;
}
function authOptional(req, res, next) {
  const c = req.cookies.sid;
  if (!c || !c.includes(".")) return next();
  const [sid, raw] = c.split(".");
  const s = db.prepare("SELECT * FROM sessions WHERE id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?").get(sid, sha256(raw), now());
  if (!s) return next();
  // CORRECTIF v8 : toujours relire l'utilisateur FRAIS depuis la DB
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  if (!u) return next();
  req.session = s; req.user = u;
  next();
}
function requireAuth(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Authentification requise." });
    next();
  });
}
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ ok: false, error: "Admin requis." });
  next();
}
function requireCsrf(req, res, next) {
  if (!["POST","PUT","PATCH","DELETE"].includes(req.method)) return next();
  const token = req.headers["x-csrf-token"];
  if (!token || !req.session || sha256(token) !== req.session.csrf_hash)
    return res.status(403).json({ ok: false, error: "Token CSRF invalide." });
  next();
}

// ══ MODÉRATION — zéro censure sauf illégal absolu ════════════
function moderation(text) {
  const t = String(text || "").toLowerCase();
  // UNIQUEMENT les interdits légaux absolus — pas de censure du reste
  const rules = [
    ["minor",        ["mineur","mineure","moins de 18","underage","fillette","garçonnet","ado de 12","ado de 13","ado de 14","pédo","pedophil","pédophil"]],
    ["non_consent",  ["sans consentement réel","contre son gré pour de vrai","droguer pour violer","inconsciente pour"]],
    ["exploitation", ["zoophilie","bestialité","traite sexuelle"]],
    ["hate",         ["exterminer","gazage des"]]
  ];
  // NB : "viol consenti", "roleplay viol", "scénario viol", "fantasme viol" sont AUTORISÉS (fiction adulte consentie)
  const containsWord = (haystack, needle) => {
    if (needle.includes(" ")) return haystack.includes(needle);
    const re = new RegExp("(^|[^a-zàâäéèêëïîôöùûüç])" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-zàâäéèêëïîôöùûüç]|$)", "i");
    return re.test(haystack);
  };
  for (const [cat, words] of rules) {
    for (const w of words) { if (containsWord(t, w)) return { allowed: false, category: cat }; }
  }
  return { allowed: true, category: "safe" };
}

// ══ MÉMOIRE — fonctions définies en haut du fichier (v12)

// ══ WORKFLOW PERPÉTUEL — messages proactifs programmés ═══════
function scheduleProactiveMessages(userId, ext, aiName) {
  // Supprimer les anciens pending
  db.prepare("DELETE FROM proactive_schedule WHERE user_id=? AND status='pending'").run(userId);

  const proactivite = (ext && ext.proactivite) || "normale";
  if (proactivite === "off") return;

  const intervals = { haute: 90, normale: 180, basse: 360 }; // en minutes
  const interval = intervals[proactivite] || 180;

  const now_ms = Date.now();
  const count = proactivite === "haute" ? 8 : proactivite === "normale" ? 4 : 2;

  for (let i = 1; i <= count; i++) {
    const scheduledAt = new Date(now_ms + i * interval * 60 * 1000).toISOString();
    const moment = personality.getMoment(new Date(scheduledAt));
    const persona = (ext && ext.persona) || "girlfriend";
    const msgContent = personality.getMessageProactif(moment, persona, ext || {});

    db.prepare("INSERT INTO proactive_schedule(id,user_id,scheduled_at,type,content_enc,status) VALUES(?,?,?,?,?,?)")
      .run(id(), userId, scheduledAt, "message", encryptText(msgContent), "pending");
  }

  // Planifier un selfie dans la journée si mode adulte
  if (ext && ext.auto_photo) {
    const selfieAt = new Date(now_ms + 4 * 60 * 60 * 1000).toISOString(); // +4h
    const selfiePrompt = personality.buildSelfiePrompt(ext || {}, "sensuelle");
    db.prepare("INSERT INTO proactive_schedule(id,user_id,scheduled_at,type,content_enc,status) VALUES(?,?,?,?,?,?)")
      .run(id(), userId, selfieAt, "selfie", encryptText(selfiePrompt), "pending");
  }
}

// Route pour récupérer les messages proactifs en attente
app.get("/api/proactive/pending", requireAuth, (req, res) => {
  const n = now();
  const pending = db.prepare(`
    SELECT * FROM proactive_schedule
    WHERE user_id=? AND status='pending' AND scheduled_at<=?
    ORDER BY scheduled_at ASC LIMIT 5
  `).all(req.user.id, n);

  const messages = pending.map(p => ({
    id: p.id,
    type: p.type,
    content: decryptText(p.content_enc || ""),
    mediaUrl: p.media_url,
    scheduledAt: p.scheduled_at
  }));

  // Marquer comme envoyés
  if (messages.length > 0) {
    const ids = messages.map(m => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const stmt = db.prepare(`UPDATE proactive_schedule SET status='sent', sent_at=? WHERE id IN (${placeholders})`);
    stmt.run(n, ...ids);
  }

  res.json({ ok: true, messages });
});

// ══ BUILD SYSTEM PROMPT ═══════════════════════════════════════
