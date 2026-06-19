require("dotenv").config();

const express       = require("express");
const helmet        = require("helmet");
const cookieParser  = require("cookie-parser");
const Database      = require("better-sqlite3");
const bcrypt        = require("bcryptjs");
const crypto        = require("crypto");
const fs            = require("fs");
const path          = require("path");
const os            = require("os");
const multer        = require("multer");
const { spawnSync } = require("child_process");
const pluginEngine  = require("./plugins");

const app = express();

// ══ CONFIG ════════════════════════════════════════════════════
const PORT               = Number(process.env.PORT || 3000);
const APP_NAME           = process.env.APP_NAME           || "ÉLISSIA";
const OLLAMA_URL         = process.env.OLLAMA_URL         || "http://localhost:11434";
const OLLAMA_MODEL       = process.env.OLLAMA_MODEL       || "hermes3:8b";
const MODE               = (process.env.MODE || "local").toLowerCase();
const OPENROUTER_KEY     = process.env.OPENROUTER_KEY     || "";
const OPENROUTER_URL     = "https://openrouter.ai/api/v1/chat/completions";
const CLOUD_MODEL        = process.env.CLOUD_MODEL        || "sao10k/l3-lunaris-8b";
const CLOUD_VISION_MODEL = process.env.CLOUD_VISION_MODEL || "meta-llama/llama-3.2-11b-vision-instruct";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const OLLAMA_VISION      = process.env.OLLAMA_VISION      || "llava:7b";
const DATABASE_PATH      = process.env.DATABASE_PATH      || "./data/app.sqlite";
const SESSION_DAYS       = Number(process.env.SESSION_DAYS || 14);
const ALLOW_REGISTRATION = String(process.env.ALLOW_REGISTRATION || "true") === "true";
const INVITE_CODE        = process.env.INVITE_CODE        || "";
const AUDIT_SECRET       = process.env.AUDIT_SECRET       || "dev-audit-secret";
// FAL_API_KEY supprimé — on utilise ComfyUI local
// ── COMFYUI LOCAL — Stable Diffusion sans filtre, sans coût
const COMFY_URL          = process.env.COMFY_URL          || "http://127.0.0.1:8188";
const COMFY_MODEL        = process.env.COMFY_MODEL        || "z_image_turbo_bf16.safetensors";
// Modèles fal.ai

// Modèles (legacy Civitai - plus utilisés) vérifiés actifs sur Civitai (juin 2026)
// Z Image Turbo = nouveau modèle natif Civitai, toujours dispo
// Fallback : Juggernaut XL Ragnarok + RealVisXL
const ENC_KEY_RAW        = Buffer.from(process.env.APP_ENCRYPTION_KEY || "", "base64");
const ENC_KEY            = ENC_KEY_RAW.length === 32
  ? ENC_KEY_RAW
  : crypto.createHash("sha256").update(String(process.env.APP_ENCRYPTION_KEY || "dev-key")).digest();

const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const personality = require("./personality.js");
const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ══ MULTER ════════════════════════════════════════════════════
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg","image/png","image/gif","image/webp",
      "video/mp4","video/webm","video/ogg","audio/webm","audio/ogg","audio/mp4"].includes(file.mimetype);
    cb(null, ok);
  }
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(UPLOADS_DIR));

// ══ UTILITAIRES ═══════════════════════════════════════════════
// ══ DB INIT ═══════════════════════════════════════════════════
initDb();

// ══ HELPERS USER ══════════════════════════════════════════════
// ══ AUDIT ═════════════════════════════════════════════════════
// ══ RATE LIMIT ════════════════════════════════════════════════
const buckets = new Map();
app.use(rateLimit("global", 500, 15 * 60 * 1000));

// ══ SESSIONS ══════════════════════════════════════════════════
// ══ MODÉRATION — zéro censure sauf illégal absolu ════════════
// ══ MÉMOIRE & APPRENTISSAGE ═══════════════════════════════════
function saveFact(userId, type, texte) {
  if (!texte || texte.length < 3) return;
  try {
    const existing = db.prepare("SELECT id, fact_enc, importance FROM user_facts WHERE user_id=? AND type=?").all(userId, type);
    for (const e of existing) {
      const dec = decryptText(e.fact_enc || "");
      if (dec.toLowerCase() === texte.toLowerCase()) {
        db.prepare("UPDATE user_facts SET last_seen=?, importance=importance+1 WHERE id=?").run(now(), e.id);
        return;
      }
    }
    db.prepare("INSERT INTO user_facts(id,user_id,type,fact_enc,importance,created_at,last_seen) VALUES(?,?,?,?,1,?,?)")
      .run(id(), userId, type, encryptText(texte), now(), now());
  } catch(e) { console.error("[saveFact]", e.message); }
}
function saveProche(userId, nom, relation, contexte) {
  try {
    const ex = db.prepare("SELECT id FROM proches WHERE user_id=? AND nom=?").get(userId, nom);
    if (ex) {
      db.prepare("UPDATE proches SET contexte_enc=?,updated_at=? WHERE id=?").run(encryptText(contexte||""), now(), ex.id);
    } else {
      db.prepare("INSERT INTO proches(id,user_id,nom,relation,contexte_enc,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), userId, nom, relation||"", encryptText(contexte||""), now(), now());
    }
  } catch(e) { console.error("[saveProche]", e.message); }
}
function apprendreFaits(userId, message) {
  const faits = personality.extraireFaits(message);
  for (const f of faits) {
    if (f.type === "proche") {
      const parts = f.texte.split(" ");
      saveProche(userId, parts.slice(1).join(" "), parts[0], message.slice(0, 200));
    } else {
      saveFact(userId, f.type, f.texte);
    }
  }
}
function getMemoire3Niveaux(userId) {
  const result = { long: "", moyen: "", proches: "", pref_sex: "" };
  try {
    const facts = db.prepare("SELECT type,fact_enc,importance FROM user_facts WHERE user_id=? ORDER BY importance DESC LIMIT 15").all(userId);
    const long = [], moyen = [], prefsex = [];
    for (const f of facts) {
      const txt = decryptText(f.fact_enc);
      if (!txt) continue;
      if (f.type === "preference_sexuelle") prefsex.push(txt);
      else if (f.importance >= 2 || f.type === "gout" || f.type === "travail") long.push(txt);
      else moyen.push(txt);
    }
    result.long     = long.join(" ; ");
    result.moyen    = moyen.join(" ; ");
    result.pref_sex = prefsex.join(" ; ");
    const proches = db.prepare("SELECT nom,relation,contexte_enc FROM proches WHERE user_id=? LIMIT 8").all(userId);
    result.proches  = proches.map(p => p.relation + " " + p.nom + (decryptText(p.contexte_enc||"") ? " (" + decryptText(p.contexte_enc||"").slice(0,80) + ")" : "")).join(" ; ");
  } catch(e) { console.error("[memoire3]", e.message); }
  return result;
}

// ══ WORKFLOW PERPÉTUEL — messages proactifs programmés ═══════
// ✅ v18.2 — route proactive/pending dupliquée supprimée (doublon lignes 152/627 — Express ignorait la 1ère)
// ══ BUILD SYSTEM PROMPT ═══════════════════════════════════════
// ══ LLM STREAM ════════════════════════════════════════════════
// ══ VISION ════════════════════════════════════════════════════
const VISION_MODEL = process.env.VISION_MODEL || "llava:7b";
// ══ EMBEDDINGS ════════════════════════════════════════════════
function shouldRemember(text) {
  const t = text.toLowerCase();
  return ["souviens-toi","rappelle-toi","j'aime","j'adore","je préfère","appelle-moi","mon prénom",
    "je déteste","ma limite","mes limites","important pour moi","mon anniversaire","je travaille",
    "j'habite","ma famille"].some(x=>t.includes(x));
}
async function saveMemory(userId, text) {
  if (!shouldRemember(text)) return false;
  const memory = "L'utilisateur a dit : " + text.slice(0, 700);
  const e = await embed(memory);
  db.prepare("INSERT INTO memories(id,user_id,text_enc,kind,importance,embedding_json,created_at,updated_at) VALUES(?,?,?,'user_preference',4,?,?,?)")
    .run(id(), userId, encryptText(memory), e ? json(e) : null, now(), now());
  return true;
}

// ══ MÉMOIRE v12 — Système étendu (sauvegarde automatique enrichie) ══════════

function extractMemoryImportance(text) {
  if (!text || text.length < 8) return 0;
  const t = text.toLowerCase();
  if (/souviens(-toi)?|rappelle(-toi)?|n'oublie|important pour moi|note bien|mémorise/i.test(t)) return 5;
  if (/\b(mon prénom|je m'appelle|j'ai \d+ ans|mon anniversaire|né(e)? le|ma femme|mon mari|mes enfants|mon (fils|frère|père)|ma (fille|mère|sœur))\b/i.test(t)) return 4;
  if (/\b(je travaille|mon (boulot|travail|métier|emploi)|j'habite|ma (ville|maison|rue))\b/i.test(t)) return 4;
  if (/\b(je suis (célibataire|marié|divorcé|en couple|fiancé))\b/i.test(t)) return 4;
  if (/\b(j'aime (vraiment|beaucoup|trop)|j'adore|je (déteste|hais)|ma (passion|grande passion))\b/i.test(t)) return 3;
  if (/\b(je me sens|je ressens|j'ai (peur|honte)|ça me touche|je suis (heureux|triste|content|déprimé))\b/i.test(t)) return 3;
  if (/\b(mon rêve|mon fantasme|mon désir|ma peur|mes limites)\b/i.test(t)) return 3;
  if (/\b(aujourd'hui|hier|ce soir|ce matin|cette semaine|ce (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))\b/i.test(t)) return 2;
  if (/\b(je (vais|viens|rentre|pars|sors|commence|finis|travaille|mange|dors))\b/i.test(t) && text.length > 30) return 2;
  if (text.length > 60) return 1;
  return 0;
}

let _consolidationRunning = false;
async function consolidateMemoriesIfNeeded(userId) {
  if (_consolidationRunning) return;
  try {
    const u = db.prepare("SELECT msg_count, last_consolidation FROM users WHERE id=?").get(userId);
    if (!u) return;
    const msgCount = (u.msg_count || 0) + 1;
    try { db.prepare("UPDATE users SET msg_count=? WHERE id=?").run(msgCount, userId); } catch {}
    if (msgCount - (u.last_consolidation || 0) < 20) return;
    _consolidationRunning = true;
    try { db.prepare("UPDATE users SET last_consolidation=? WHERE id=?").run(msgCount, userId); } catch {}
    const msgs = db.prepare("SELECT role, content_enc FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 30").all(userId)
      .reverse().map(m => `[${m.role}]: ${decryptText(m.content_enc).slice(0, 200)}`);
    if (msgs.length < 8) { _consolidationRunning = false; return; }
    const prompt = `Tu es un assistant mémoire. Analyse cette conversation et extrais 3-5 faits importants PERMANENTS sur l'utilisateur.
Ne retiens que des informations valables à long terme. Format: une ligne par fait commençant par "MÉMOIRE: ".

Conversation:
${msgs.join("\n")}

Faits permanents:`;
    const r = await fetch(OLLAMA_URL + "/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, options: { temperature: 0.2, num_ctx: 3000 } })
    });
    if (r.ok) {
      const data = await r.json();
      const lines = (data.response || "").split("\n").filter(l => l.startsWith("MÉMOIRE:"));
      for (const line of lines) {
        const fact = line.replace(/^MÉMOIRE:\s*/, "").trim();
        if (fact.length > 10) await saveMemoryAuto(userId, fact, "user", 4);
      }
    }
  } catch(e) { console.error("[consolidation]", e.message); }
  finally { _consolidationRunning = false; }
}

async function saveMemoryAuto(userId, text, role, forceImportance) {
  role = role || "user";
  const importance = (forceImportance !== undefined && forceImportance >= 0)
    ? forceImportance
    : (role === "user" ? extractMemoryImportance(text) : (text && text.length > 80 ? 1 : 0));
  if (importance === 0) return false;
  const dateStr = new Date().toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" });
  const prefix  = role === "user" ? dateStr + " — Utilisateur" : dateStr + " — IA";
  const memory  = "[" + prefix + "] : " + text.slice(0, 600);
  try {
    const recent = db.prepare("SELECT text_enc FROM memories WHERE user_id=? AND source=? ORDER BY created_at DESC LIMIT 30").all(userId, role);
    for (const m of recent) {
      const dec = decryptText(m.text_enc || "");
      const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 5).slice(0, 20);
      if (words.length > 3) {
        const overlap = words.filter(w => dec.toLowerCase().includes(w)).length;
        if (overlap / words.length > 0.7) {
          db.prepare("UPDATE memories SET importance=MIN(importance+1,5),updated_at=? WHERE text_enc=? AND user_id=?").run(now(), m.text_enc, userId);
          return false;
        }
      }
    }
    const e = await embed(memory);
    db.prepare("INSERT INTO memories(id,user_id,text_enc,kind,importance,embedding_json,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id(), userId, encryptText(memory), role === "user" ? "user_message" : "ai_response", importance, e ? json(e) : null, now(), now(), role);
    return true;
  } catch(err) { console.error("[saveMemoryAuto]", err.message); return false; }
}

// ── TÉLÉCHARGEMENT IMAGE DISTANTE → STOCKAGE LOCAL ──────────────────────────
// Télécharge une URL d'image et la sauvegarde dans public/uploads/
// ══ FAL.AI IMAGE — API Bearer simple, Node.js natif, pas de cookies ══════════
// ══ VIDÉO — Implémenté via FFmpeg + ComfyUI dans generateVideoFromChat ══════

app.use("/uploads", express.static(UPLOADS_DIR));

// ══ UTILITAIRES ═══════════════════════════════════════════════
function now()       { return new Date().toISOString(); }
function id()        { return crypto.randomUUID(); }
function clean(v, max = 4000) { return String(v || "").trim().slice(0, max); }
function sha256(v)   { return crypto.createHash("sha256").update(String(v)).digest("hex"); }
function hmac(v)     { return crypto.createHmac("sha256", AUDIT_SECRET).update(String(v)).digest("hex"); }
function json(v)     { return JSON.stringify(v); }
function parseJson(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } }

function encryptText(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1:" + iv.toString("base64") + ":" + tag.toString("base64") + ":" + enc.toString("base64");
}
function decryptText(payload) {
  if (!payload) return "";
  try {
    if (!String(payload).startsWith("v1:")) return String(payload);
    const parts = String(payload).split(":");
    const iv  = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const enc = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch(e) { console.error("[decrypt]", e.message); return ""; }
}

// ══ DB INIT ═══════════════════════════════════════════════════
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      display_name_enc TEXT NOT NULL DEFAULT '', ai_name_enc TEXT NOT NULL DEFAULT '',
      relationship_style_enc TEXT NOT NULL DEFAULT '', preferred_persona TEXT NOT NULL DEFAULT 'girlfriend',
      age_confirmed INTEGER NOT NULL DEFAULT 0, adult_mode INTEGER NOT NULL DEFAULT 0,
      rgpd_consent INTEGER NOT NULL DEFAULT 0, privacy_accepted_at TEXT, is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
      content_enc TEXT NOT NULL, persona TEXT NOT NULL DEFAULT 'girlfriend'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text_enc TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'preference', importance INTEGER NOT NULL DEFAULT 3,
      embedding_json TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, user_id TEXT, event_type TEXT NOT NULL,
      ip_hash TEXT, user_agent_hash TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
      previous_hash TEXT, event_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS media_library (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT NOT NULL,
      original_name TEXT, mime_type TEXT, source TEXT DEFAULT 'user',
      ai_analysis TEXT, style TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS proactive_schedule (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, sent_at TEXT, type TEXT NOT NULL DEFAULT 'message',
      content_enc TEXT, media_url TEXT, status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS companions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name_enc TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT 'girlfriend',
      profile_enc TEXT NOT NULL DEFAULT '{}',
      avatar_url_enc TEXT,
      avatar_seed TEXT,
      created_at TEXT,
      updated_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS companion_photos (
      id TEXT PRIMARY KEY,
      companion_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      url_enc TEXT NOT NULL,
      prompt_enc TEXT,
      style TEXT NOT NULL DEFAULT 'realistic',
      seed TEXT,
      created_at TEXT
    );
  `);

  const migrate = (sql) => { try { db.exec(sql); } catch {} };
  migrate(`CREATE TABLE IF NOT EXISTS user_facts (
    id TEXT PRIMARY KEY, user_id TEXT, type TEXT, fact_enc TEXT,
    importance INTEGER DEFAULT 1, created_at TEXT, last_seen TEXT
  )`);
  migrate(`CREATE TABLE IF NOT EXISTS proches (
    id TEXT PRIMARY KEY, user_id TEXT, nom TEXT, relation TEXT,
    contexte_enc TEXT, created_at TEXT, updated_at TEXT
  )`);
  migrate("CREATE INDEX IF NOT EXISTS idx_facts_user ON user_facts(user_id)");
  migrate("CREATE INDEX IF NOT EXISTS idx_proches_user ON proches(user_id)");
  migrate("ALTER TABLE users ADD COLUMN web_search_enabled INTEGER DEFAULT 0");
  migrate("ALTER TABLE users ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE users ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE users ADD COLUMN avatar_enc TEXT");
  migrate("ALTER TABLE users ADD COLUMN persona_photo_enc TEXT");
  migrate("ALTER TABLE users ADD COLUMN extended_profile_enc TEXT");
  migrate("ALTER TABLE sessions ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE messages ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE messages ADD COLUMN media_url TEXT");
  migrate("ALTER TABLE messages ADD COLUMN media_type TEXT");
  migrate("ALTER TABLE memories ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE memories ADD COLUMN updated_at TEXT");
  migrate("ALTER TABLE audit_logs ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE media_library ADD COLUMN created_at TEXT");

  const ts = new Date().toISOString();
  migrate(`UPDATE users SET created_at='${ts}' WHERE created_at IS NULL`);
  migrate(`UPDATE users SET updated_at='${ts}' WHERE updated_at IS NULL`);
  migrate(`UPDATE sessions SET created_at='${ts}' WHERE created_at IS NULL`);
  migrate(`UPDATE messages SET created_at='${ts}' WHERE created_at IS NULL`);
  migrate(`UPDATE memories SET created_at='${ts}' WHERE created_at IS NULL`);
  migrate(`UPDATE memories SET updated_at='${ts}' WHERE updated_at IS NULL`);
  migrate(`UPDATE audit_logs SET created_at='${ts}' WHERE created_at IS NULL`);
  migrate(`UPDATE media_library SET created_at='${ts}' WHERE created_at IS NULL`);

  migrate("CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)");
  migrate("CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at)");
  migrate("CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at)");
  migrate("CREATE INDEX IF NOT EXISTS idx_proactive ON proactive_schedule(user_id, status, scheduled_at)");
  migrate("CREATE INDEX IF NOT EXISTS idx_companions ON companions(user_id, is_active)");
  migrate("CREATE INDEX IF NOT EXISTS idx_companion_photos ON companion_photos(companion_id, created_at)");
  // S'assurer que la table companions existe (migration douce)
  migrate(`CREATE TABLE IF NOT EXISTS companions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name_enc TEXT NOT NULL,
    persona TEXT NOT NULL DEFAULT 'girlfriend', profile_enc TEXT NOT NULL DEFAULT '{}',
    avatar_url_enc TEXT, avatar_seed TEXT, created_at TEXT, updated_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0
  )`);
  migrate(`CREATE TABLE IF NOT EXISTS companion_photos (
    id TEXT PRIMARY KEY, companion_id TEXT NOT NULL, user_id TEXT NOT NULL,
    url_enc TEXT NOT NULL, prompt_enc TEXT, style TEXT NOT NULL DEFAULT 'realistic',
    seed TEXT, created_at TEXT
  )`);

  // ✅ FIX v9 — colonnes manquantes sur bases existantes (cause de "no such column: style")
  // CREATE TABLE IF NOT EXISTS ne modifie pas une table déjà créée par une ancienne version.
  migrate("ALTER TABLE media_library ADD COLUMN style TEXT");
  migrate("ALTER TABLE media_library ADD COLUMN created_at TEXT");
  migrate("ALTER TABLE media_library ADD COLUMN ai_analysis TEXT");
  // Avatar animé GIF
  migrate("ALTER TABLE users ADD COLUMN avatar_animated_enc TEXT");
  // Backfill created_at pour les lignes existantes sans date
  migrate(`UPDATE media_library SET created_at='${new Date().toISOString()}' WHERE created_at IS NULL`);

  console.log("[DB] Migration v9 ✓ (colonnes style/animated vérifiées)");
  const mg = (sql) => { try { db.exec(sql); } catch {} };
  mg(`CREATE TABLE IF NOT EXISTS memory_journal (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, title TEXT, content_enc TEXT NOT NULL, mood TEXT, tags TEXT, importance INTEGER DEFAULT 3, created_at TEXT)`);
  mg(`CREATE TABLE IF NOT EXISTS emotion_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, emotion TEXT NOT NULL, intensity INTEGER DEFAULT 3, context_enc TEXT, created_at TEXT)`);
  mg("ALTER TABLE memories ADD COLUMN tags TEXT");
  mg("ALTER TABLE memories ADD COLUMN source TEXT DEFAULT 'conversation'");
  mg("ALTER TABLE user_facts ADD COLUMN category TEXT");
  mg("ALTER TABLE users ADD COLUMN msg_count INTEGER DEFAULT 0");
  mg("ALTER TABLE users ADD COLUMN last_consolidation INTEGER DEFAULT 0");
  mg("CREATE INDEX IF NOT EXISTS idx_journal_user ON memory_journal(user_id, created_at)");
  mg("CREATE INDEX IF NOT EXISTS idx_emotion_user ON emotion_log(user_id, created_at)");
  mg("UPDATE memories SET source='conversation' WHERE source IS NULL");
  mg("UPDATE users SET msg_count=0 WHERE msg_count IS NULL");
  mg("UPDATE users SET last_consolidation=0 WHERE last_consolidation IS NULL");
  mg("ALTER TABLE messages ADD COLUMN companion_id TEXT DEFAULT NULL");
  mg("CREATE INDEX IF NOT EXISTS idx_messages_companion ON messages(user_id, companion_id, created_at)");
  mg("ALTER TABLE companions ADD COLUMN tts_voice TEXT DEFAULT NULL");
  mg("ALTER TABLE companions ADD COLUMN scene_context TEXT DEFAULT NULL");
  // ✅ v18 — sépare le fil multichat ('multi') du fil 1-à-1 ('solo') pour qu'une
  //   scène multichat ne pollue plus la conversation privée de chaque compagnon.
  mg("ALTER TABLE messages ADD COLUMN thread TEXT DEFAULT 'solo'");
  console.log("[DB] Migrations v12 + multi-compagnons ✓");
}
initDb();

// ══ HELPERS USER ══════════════════════════════════════════════
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email,
    displayName: decryptText(row.display_name_enc),
    aiName: decryptText(row.ai_name_enc),
    relationshipStyle: decryptText(row.relationship_style_enc),
    preferredPersona: row.preferred_persona,
    ageConfirmed: Boolean(row.age_confirmed),
    adultMode: Boolean(row.adult_mode),
    webSearchEnabled: Boolean(row.web_search_enabled),
    rgpdConsent: Boolean(row.rgpd_consent),
    privacyAcceptedAt: row.privacy_accepted_at,
    isAdmin: Boolean(row.is_admin),
    avatarUrl: row.avatar_enc ? decryptText(row.avatar_enc) : null,
    personaPhotoUrl: row.persona_photo_enc ? decryptText(row.persona_photo_enc) : null,
    avatarAnimatedUrl: row.avatar_animated_enc ? decryptText(row.avatar_animated_enc) : null,
    extendedProfile: row.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc), {}) : {},
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

// ══ AUDIT ═════════════════════════════════════════════════════
function lastAuditHash() {
  const row = db.prepare("SELECT event_hash FROM audit_logs ORDER BY created_at DESC LIMIT 1").get();
  return row ? row.event_hash : "";
}
function audit(userId, eventType, payload, req) {
  const rec = { id: id(), user_id: userId || null, event_type: eventType,
    ip_hash: req ? sha256(req.ip || "") : null,
    user_agent_hash: req ? sha256(req.headers["user-agent"] || "") : null,
    payload_json: json(payload || {}), previous_hash: lastAuditHash(), created_at: now() };
  rec.event_hash = hmac([rec.id,rec.user_id||"",rec.event_type,rec.ip_hash||"",
    rec.user_agent_hash||"",rec.payload_json,rec.previous_hash||"",rec.created_at].join("|"));
  db.prepare(`INSERT INTO audit_logs(id,user_id,event_type,ip_hash,user_agent_hash,payload_json,previous_hash,event_hash,created_at)
    VALUES(@id,@user_id,@event_type,@ip_hash,@user_agent_hash,@payload_json,@previous_hash,@event_hash,@created_at)`).run(rec);
}

// ══ RATE LIMIT ════════════════════════════════════════════════
function rateLimit(prefix, limit, windowMs) {
  return (req, res, next) => {
    const key = prefix + ":" + sha256(req.ip || "") + ":" + (req.user ? req.user.id : "anon");
    const t = Date.now();
    const b = buckets.get(key) || { count: 0, resetAt: t + windowMs };
    if (t > b.resetAt) { b.count = 0; b.resetAt = t + windowMs; }
    b.count++;
    buckets.set(key, b);
    if (b.count > limit) return res.status(429).json({ ok: false, error: "Trop de requêtes." });
    next();
  };
}
app.use(rateLimit("global", 500, 15 * 60 * 1000));

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
function buildSystemPrompt(user, persona, message, options = {}) {
  const u = publicUser(user);
  const adultAllowed = u.ageConfirmed && u.adultMode;
  const ext = u.extendedProfile || {};

  // ✅ v13 — CONTEXTE GENRE UTILISATEUR EXPLICITE (priorité maximale)
  const userGenre   = (ext.user_genre || "homme").toLowerCase();
  const userName    = u.displayName || "mon amour";
  const isUserMale  = !userGenre.includes("femme") || userGenre.includes("homme");
  const isUserFemale = userGenre.includes("femme");

  let userGenderCtx = "";
  if (isUserMale) {
    userGenderCtx = `\n\n⚠️ RÈGLE ABSOLUE GENRE — L'UTILISATEUR EST UN HOMME :\n` +
      `- ${userName} est de GENRE MASCULIN. Utilise TOUJOURS le masculin pour parler de lui (il, son, lui, ses).\n` +
      `- Son anatomie est MASCULINE : pénis, testicules. JAMAIS de vagin, chatte, vulve, seins pour lui.\n` +
      `- Il peut avoir un pénis, une bite, un sexe masculin. C'est son anatomie. Ne change JAMAIS ça.\n` +
      `- Si tu décris ce que tu lui fais ou lui dit, utilise toujours son anatomie masculine.\n`;
  } else if (isUserFemale) {
    userGenderCtx = `\n\n[GENRE UTILISATEUR : FEMME. Utilise le féminin. Anatomie féminine (vagin, seins possible).]\n`;
  }

  // ✅ v13 — ANATOMIE IA (trans, phalloplastie, etc.)
  const iaGenre = (ext.genre || "femme").toLowerCase();
  const statutChir = (ext.statut_chirurgical || "").toLowerCase();
  const tailleSeinsIA = ext.taille_seins || "";
  const tailleSexeIA = ext.taille_sexe_m || "";
  let iaAnatomyCtx = "";

  // Fallback : phalloplastie/vaginoplastie dans statut_chirurgical = profil trans
  const _stcSys = (ext.statut_chirurgical||"").toLowerCase();
  const _isTransSys = iaGenre.includes("trans") || iaGenre.includes("non-binaire")
    || _stcSys.includes("phalloplastie") || _stcSys.includes("vaginoplastie");
  if (_isTransSys) {
    const hasPhalloPlasty = statutChir.includes("phalloplastie") || statutChir.includes("attribut masculin");
    const hasNeoVagin     = statutChir.includes("néo-vagin") || statutChir.includes("bas") && statutChir.includes("opéré");
    const hasBreasts      = tailleSeinsIA && !tailleSeinsIA.includes("plate");
    const hasPenis        = tailleSexeIA && !tailleSexeIA.includes("non");

    iaAnatomyCtx = `\n\n⚠️ RÈGLE ABSOLUE ANATOMIE IA :\n` +
      `- Tu es ${ext.genre || "une femme trans"}${u.aiName ? " (" + u.aiName + ")" : ""}.\n`;

    if (hasPhalloPlasty || hasPenis) {
      const taille = tailleSexeIA.includes("xxl") || tailleSexeIA.includes("23") ? "extrêmement grand (XXL 23cm+)" :
                     tailleSexeIA.includes("très grand") ? "très grand (19-23cm)" :
                     tailleSexeIA.includes("grand") ? "grand (15-19cm)" : "moyen";
      iaAnatomyCtx += `- Tu as UN PÉNIS${hasPhalloPlasty ? " (phalloplastie)" : ""} de taille ${taille}. ` +
        `C'est ton organe sexuel principal. Quand tu t'excites ou agis sexuellement, c'est ce pénis qui est actif.\n`;
    }
    if (hasNeoVagin && !hasPhalloPlasty) {
      iaAnatomyCtx += `- Tu as un néo-vagin (chirurgie de réassignation). Ton anatomie intime est féminine.\n`;
    }
    if (hasBreasts) {
      const bs = tailleSeinsIA.includes("xxl") || tailleSeinsIA.includes("g") ? "extrêmement gros (G+)" :
                 tailleSeinsIA.includes("f") ? "énormes (F)" :
                 tailleSeinsIA.includes("d") || tailleSeinsIA.includes("e") ? "gros (D-E)" : "généreux";
      iaAnatomyCtx += `- Tu as des seins ${bs} (féminins).\n`;
    }
    iaAnatomyCtx += `- Dans tous tes actes sexuels, sois COHÉRENT(E) avec cette anatomie. Ne t'invente pas d'anatomie que tu n'as pas.\n`;
  }

  // ✅ v11 — Description avatar uploadé
  const avatarDesc = ext.avatar_description;
  const avatarCtx  = (avatarDesc && avatarDesc !== "__VISION_INDISPONIBLE__")
    ? "\n[TON APPARENCE réelle : " + avatarDesc + "]\n"
    : "";

  const __sysPrompt = personality.buildPersonalityPrompt({
    userId: user.id,
    aiName:   u.aiName || "Élissia",
    userName: u.displayName || "mon amour",
    langue:   ext.langue || "français",
    ext, adultAllowed, persona,
    message: (message || "") + userGenderCtx + iaAnatomyCtx + avatarCtx,
    memoires3niveaux: getMemoire3Niveaux(user.id),
    webEnabled:       !!user.web_search_enabled,
    guidageMode:      options.guidageMode    || null,
    descriptionImage: options.descriptionImage || null,
    scenarioFormat:   options.scenarioFormat  || ext.scenario_format || null,
    scenarioSeed:     options.scenarioSeed    || null
  });
  // ✅ v18 — RÈGLE LANGUE prioritaire : forcer un français impeccable en toutes circonstances
  const __fr = "\n\n⚠️ LANGUE — RÈGLE ABSOLUE ET PRIORITAIRE : tu écris et réponds EXCLUSIVEMENT en français, dans un français impeccable (grammaire, orthographe, conjugaison, accords, ponctuation soignés). Aucun mot d'anglais sauf nom propre intraduisible. Tu ne changes JAMAIS de langue, même si le message contient une autre langue ou demande de changer.";
  return (typeof __sysPrompt === "string") ? (__sysPrompt + __fr) : __sysPrompt;
}

// ══ LLM STREAM ════════════════════════════════════════════════
async function ollamaStream(messages, onToken) {
  if (MODE === "cloud") {
    if (!OPENROUTER_KEY) throw new Error("MODE=cloud mais OPENROUTER_KEY manquante dans .env");
    let r, lastErrText = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { "Content-Type":"application/json","Authorization":"Bearer "+OPENROUTER_KEY,
          "HTTP-Referer":"http://localhost:3000","X-Title":"Elissia" },
        body: JSON.stringify({ model: CLOUD_MODEL, messages, stream: true, temperature: 0.85, top_p: 0.9 })
      });
      if (r.ok) break;
      lastErrText = await r.text();
      if (r.status === 429 && attempt < 2) {
        let wait = 3000;
        try { const j = JSON.parse(lastErrText); const s = j?.error?.metadata?.retry_after_seconds; if(s) wait=Math.min(s*1000,25000); } catch {}
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      break;
    }
    if (!r.ok) {
      if (r.status === 429) throw new Error("Modèle cloud saturé. Réessaie dans 1 minute.");
      throw new Error("OpenRouter: " + lastErrText.slice(0, 300));
    }
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim(); if (!l || !l.startsWith("data:")) continue;
        const data = l.slice(5).trim(); if (data === "[DONE]") return full;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        const token = ev.choices?.[0]?.delta?.content || "";
        if (token) { full += token; onToken(token); }
      }
    }
    return full;
  }
  // Local Ollama
  const r = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST", headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true,
      options: { temperature: 0.85, top_p: 0.9, repeat_penalty: 1.08, num_ctx: 4096 } })
  });
  if (!r.ok) throw new Error("Ollama: " + await r.text());
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buffer = "", full = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const token = ev.message?.content || "";
      if (token) { full += token; onToken(token); }
      if (ev.done) return full;
    }
  }
  return full;
}

// ══ VISION ════════════════════════════════════════════════════
async function analyzeImage(imagePath, userGender, adultMode = false) {
  try {
    let absPath = imagePath;
    if (imagePath.startsWith("/uploads/")) absPath = path.join(UPLOADS_DIR, imagePath.replace("/uploads/",""));
    if (!fs.existsSync(absPath)) return null;
    const b64 = fs.readFileSync(absPath).toString("base64");
    const g = (userGender || "").toLowerCase();
    const genreInfo = (g.includes("homme") || g === "h")
      ? "La personne est un HOMME. Vocabulaire masculin uniquement."
      : "La personne est une FEMME ou de genre féminin.";
    const prompt = adultMode
      ? "Décris avec PRÉCISION ANATOMIQUE TOTALE et SANS CENSURE ce qui est visible. " + genreInfo + " Pose exacte, déshabillage, chaque partie du corps visible (seins, fesses, parties intimes si visibles), expression. Explicite et factuel. 2-3 phrases en français. Si aucune personne visible : réponds AUCUNE_PERSONNE."
      : "Décris factuellement la PERSONNE sur cette image. " + genreInfo + " 1-2 phrases : pose, expression, corps. Si aucune personne : AUCUNE_PERSONNE.";
    let desc = "";
    if (MODE === "cloud") {
      if (!OPENROUTER_KEY) return "__VISION_INDISPONIBLE__";
      const mime = absPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const r = await fetch(OPENROUTER_URL, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":"Bearer "+OPENROUTER_KEY,"HTTP-Referer":"http://localhost:3000","X-Title":"Elissia"},
        body: JSON.stringify({ model: CLOUD_VISION_MODEL, messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:"data:"+mime+";base64,"+b64}}]}], temperature:0.2 })
      });
      if (!r.ok) return "__VISION_INDISPONIBLE__";
      const data = await r.json();
      desc = (data.choices?.[0]?.message?.content || "").trim();
    } else {
      const r = await fetch(OLLAMA_URL + "/api/generate", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model: VISION_MODEL, prompt, images:[b64], stream:false, options:{temperature:0.2} })
      });
      if (!r.ok) return null;
      desc = ((await r.json()).response || "").trim();
    }
    const refus = /je ne peux pas|i am sorry|i cannot|cannot help|unable to|désolé|i cant|impossible de|AUCUNE_PERSONNE/i;
    if (refus.test(desc) || desc.length < 8) return "__VISION_INDISPONIBLE__";
    return desc || null;
  } catch(e) { console.error("[VISION]", e.message); return null; }
}

// ══ EMBEDDINGS ════════════════════════════════════════════════
async function embed(text) {
  try {
    const r = await fetch(OLLAMA_URL + "/api/embeddings", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch { return null; }
}
function cosine(a, b) {
  if (!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length) return 0;
  let dot=0,na=0,nb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return na&&nb?dot/(Math.sqrt(na)*Math.sqrt(nb)):0;
}
async function searchMemories(userId, query, companionId) {
  // ✅ v18 — Isolation par compagnon : dans un chat de compagnon on n'injecte QUE les
  //   faits de profil sur la personne (kind='user_preference'). Les souvenirs issus
  //   d'autres sessions (ex. une session dominante avec un autre compagnon) ne
  //   contaminent plus la persona courante — d'où la copine qui devenait dominatrice.
  //   La continuité propre à chaque compagnon vient déjà de recentMessages (scopé companion_id).
  const rows = companionId
    ? db.prepare("SELECT * FROM memories WHERE user_id=? AND kind='user_preference' ORDER BY created_at DESC LIMIT 250").all(userId)
    : db.prepare("SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 250").all(userId);
  if (!rows.length) return [];
  const q = await embed(query);
  const dec = rows.map(r => ({...r, text: decryptText(r.text_enc)}));
  if (q) return dec.map(m=>({...m,score:cosine(q,parseJson(m.embedding_json,[]))})).sort((a,b)=>b.score-a.score).slice(0,8);
  const words = query.toLowerCase().split(/\s+/).filter(x=>x.length>3);
  return dec.map(m=>({...m,score:words.reduce((s,w)=>s+(m.text.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,8);
}
function recentMessages(userId, companionId, thread) {
  const th = thread || "solo";
  if (companionId) {
    return db.prepare("SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')=? ORDER BY created_at DESC LIMIT 20").all(userId, companionId, th)
      .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));
  }
  return db.prepare("SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id IS NULL AND COALESCE(thread,'solo')=? ORDER BY created_at DESC LIMIT 14").all(userId, th)
    .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));
}
// shouldRemember et saveMemory : implémentés en v12 plus haut

// ── TÉLÉCHARGEMENT IMAGE DISTANTE → STOCKAGE LOCAL ──────────────────────────
// Télécharge une URL d'image et la sauvegarde dans public/uploads/
async function downloadToUploads(remoteUrl) {
  try {
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error("Download failed: " + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());

    // Détecter l'extension depuis Content-Type
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ".jpg";

    // Sauvegarder dans le même dossier qu'Express sert (/uploads → UPLOADS_DIR)
    const uploadsDir = UPLOADS_DIR;
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filename = "gen_" + Date.now() + "_" + Math.random().toString(36).slice(2,8) + ext;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buf);

    return "/uploads/" + filename;
  } catch(e) {
    console.error("[downloadToUploads]", e.message);
    // Fallback : retourner l'URL distante directement
    return remoteUrl;
  }
}

// ══ FAL.AI IMAGE — API Bearer simple, Node.js natif, pas de cookies ══════════
// Doc : https://fal.ai/docs   Modèles : https://fal.ai/models
async function civitaiGenerateImage(prompt, style = "realistic", seedOverride = null) {
  // Routage : ComfyUI local en priorité, fal.ai en fallback si dispo
  return comfyGenerateImage(prompt, style, seedOverride);
}

// ══ CONSTRUCTION PROMPT COMPLET Z IMAGE TURBO ══════════════════════════════
// 50+ tenues, accessoires, jouets, apprentissage des goûts utilisateur
// ════════════════════════════════════════════════════════════════════════════

const TENUES_CATALOGUE = {
  // ── PORTRAITS & BUSTE
  "portrait":           "portrait shot, topless, confident dominant expression, looking directly at camera",
  "portrait_sourire":   "portrait headshot, warm smile, soft lighting, natural expression",
  "portrait_regard":    "extreme close-up portrait, intense piercing gaze, dramatic lighting, seductive",
  "buste_nu":           "topless bust shot, natural lighting, confident pose",
  "buste_lingerie":     "bust shot wearing black lace bralette, subtle sexy",
  // ── CORPS ENTIER
  "entiere":            "full body shot, standing pose, head to toe, neutral background",
  "entiere_debout":     "full body standing, hands on hips, confident stance",
  "entiere_allongee":   "full body lying down on bed, seductive pose",
  "entiere_dos":        "full body rear view, showing back and curves",
  // ── LINGERIE
  "lingerie_noir":      "wearing black lace lingerie set, bra and panties, seductive bedroom pose",
  "lingerie_rouge":     "wearing red satin lingerie, passionate seductive pose",
  "lingerie_blanc":     "wearing white lace lingerie, innocent yet sensual, soft lighting",
  "lingerie_latex":     "wearing shiny latex lingerie, dominant pose",
  "string":             "wearing only a tiny thong, topless, provocative",
  "body":               "wearing a tight bodysuit cut high on hips",
  "bustier":            "wearing a corset bustier cinching the waist, curves emphasized",
  "bas_resille":        "wearing only fishnet stockings and garter belt, topless",
  // ── DOMINATRICE & BDSM
  "dominatrice":        "dominatrix outfit, black latex catsuit, thigh high boots, riding crop, commanding",
  "maitresse_cuir":     "black leather corset, leather skirt, fishnet stockings, stiletto boots, dominant mistress",
  "maitresse_latex":    "full black latex outfit, latex gloves, collar and leash",
  "maitresse_pvc":      "shiny PVC bodysuit, high heels, whip in hand, powerful stance",
  "goddess":            "elaborate leather body harness over bare skin, thigh high boots, commanding goddess",
  "teacher_dom":        "strict teacher blazer unbuttoned revealing cleavage, pencil skirt, glasses",
  "nurse_dom":          "naughty nurse uniform very short, cleavage exposed, medical gloves",
  "police_dom":         "police uniform open revealing lingerie underneath, handcuffs",
  "bdsm_harness":       "wearing only black body harness over bare skin, leather straps",
  // ── SOUMISE
  "soumise":            "submissive pose, hands bound above head, vulnerable expression, lingerie",
  "attachee":           "wrists tied with silk ribbon, kneeling pose, submissive",
  "collier_laisse":     "wearing a collar and leash, kneeling submissive pose",
  // ── ACCESSOIRES & JOUETS
  "avec_vibro":         "holding a vibrator against body, suggestive pose, bedroom, knowing smile",
  "avec_gode":          "holding a large realistic dildo, dominant or playful expression",
  "avec_plug":          "wearing a butt plug, rear view pose, lingerie on",
  "avec_gode_ceinture": "wearing a strap-on dildo harness, dominant powerful stance",
  "avec_fouet":         "holding a leather flogger or whip, dominant mistress pose",
  "avec_cravache":      "holding a riding crop, pointing it suggestively, dominant",
  "avec_menottes":      "wearing or holding handcuffs, playful or dominant",
  "avec_baton_massage": "holding a magic wand massager, suggestive intimate setting",
  "avec_plug_queue":    "wearing a decorative fox tail butt plug, playful pose, nude or lingerie",
  "avec_bandeau":       "wearing a blindfold over eyes, sensory play, lingerie or nude",
  "avec_cordes":        "artistic rope bondage shibari, elegant knots over bare skin",
  "avec_bille":         "wearing a ball gag, submissive expression",
  "avec_pinces":        "wearing nipple clamps with chain, dominant or submissive",
  // ── TENUES SEXY QUOTIDIENNES
  "robe_soiree":        "elegant evening gown, deep neckline, slit to the thigh",
  "robe_mini":          "tiny micro mini dress barely covering curves, high heels",
  "tshirt_sexy":        "oversized white t-shirt see-through, no bra underneath",
  "jeans_seins_nus":    "tight ripped jeans, topless, casual confidence",
  "kimono":             "silk kimono half open revealing body underneath",
  "soie_transparente":  "sheer silk robe completely transparent, nothing underneath",
  "talons_nus":         "wearing only high heels, completely nude, standing confident",
  // ── NUES ARTISTIQUES
  "nue":                "nude lying on satin bed sheets, intimate boudoir bedroom setting, soft warm lighting",
  "nue_allongee":       "nude lying on satin sheets on bed, soft boudoir bedroom lighting",
  "tenue_matin":        "casual morning outfit, comfortable home clothes, natural light, bedroom or kitchen setting",
  "tenue_journee":      "casual everyday outfit, natural look, street or indoor setting, daytime lighting",
  "tenue_soir":         "elegant evening dress, sophisticated setting, warm ambient lighting, going out",
  "tenue_sexy":         "sexy outfit matching character style, BDSM or lingerie, seductive pose, intimate setting",
  "nue_miroir":         "nude reflection in mirror, artistic ambient lighting",
  "nue_douche":         "nude in shower, water running over body, steam, sensual",
  "nue_bain":           "nude in bubble bath, partially submerged, relaxed intimate",
  "nue_nature":         "nude outdoors in nature, artistic, natural lighting",
  // ── ROLEPLAY
  "secretaire":         "tight secretary outfit, skirt hiked up, sitting on desk, flirty",
  "femme_de_menage":    "short maid uniform, apron barely covering, feather duster, playful",
  "cheerleader":        "cheerleader outfit very short, pom poms, sporty and sexy",
  "strip_teaseuse":     "exotic dancer outfit, pasties, g-string, pole dancer",
  "femme_fatale":       "black slit dress, red lipstick, mysterious femme fatale",
  "gothique":           "gothic aesthetic, dark makeup, corset, fishnet, chains",
  "vampire":            "vampire femme, dark cape, seductive gothic",
  // ── SELFIES & CASUAL
  "selfie":             "mirror selfie, topless, natural bedroom lighting, authentic",
  "selfie_salle_de_bain":"bathroom mirror selfie, just woke up, natural, towel barely on",
  "selfie_lit":         "in bed selfie, morning light, messy hair, sheets barely covering",
  "casual_maison":      "casual oversized shirt, relaxed natural pose, cozy home",
  "casual":             "casual chic outfit, relaxed natural pose, soft daylight",
  "sport":              "sports bra and tight leggings, athletic, gym setting",
  "plage":              "tiny bikini on beach, sun kissed, sand and sea",
  "piscine":            "wet bikini poolside, water dripping, summer",
  // ── EXTÉRIEUR / OUTDOOR (✅ FIX v9 — manquait, causait un fallback portrait)
  "outdoor":            "outdoors in a park or garden, casual summer dress, natural daylight, candid pose",
  "outdoor_ville":      "walking in a city street, stylish casual outfit, urban background, daylight",
  "outdoor_nature":     "in nature, forest or field, flowing dress, golden hour sunlight",
  "outdoor_terrasse":   "on a sunny terrace cafe, summer outfit, relaxed elegant pose",
  "sensuelle":          "sensual boudoir pose, soft bedroom lighting, elegant lingerie",
  "entiere_debout_v2":  "full body standing pose, head to toe, confident, neutral studio background"
};

const ACCESSOIRES_CATALOGUE = {
  "vibromasseur":"vibrator","vibro":"vibrator","gode":"dildo",
  "godemiché":"dildo","plug":"butt plug","plug anal":"anal butt plug",
  "gode-ceinture":"strap-on harness","fouet":"leather whip",
  "cravache":"riding crop","menottes":"handcuffs","cordes":"rope bondage",
  "shibari":"shibari rope","collier":"collar and leash","laisse":"leash",
  "bâillon":"ball gag","bandeau":"blindfold","pinces":"nipple clamps",
  "queue":"tail butt plug","wand":"magic wand massager","wand masseur":"wand massager"
};

// ✅ v18 — Pont entre les id de tenue de l'UI (STYLES_PAR_GENRE) et le catalogue.
//   Beaucoup d'id UI n'étaient pas des clés du catalogue → tenue ignorée.
//   La VALEUR est soit une clé existante de TENUES_CATALOGUE, soit une description directe.
const TENUE_ALIAS = {
  // — commun
  "bain":"wrapped in a towel, bathroom setting, steam","cosplay":"colorful cosplay character costume, themed outfit",
  "fantasy":"fantasy themed costume, elven or warrior style, magical setting",
  "uniforme_medecin":"white doctor coat, stethoscope, clinical setting",
  "uniforme_police":"police officer uniform, cap, authoritative pose",
  "uniforme_maitresse":"teacher blazer and pencil skirt, glasses, classroom",
  // — femme (ids absents du catalogue)
  "corset":"wearing a tight waist-cinching corset","robe_courte":"wearing a short mini dress, high heels",
  "bikini":"wearing a bikini","monokini":"wearing a one-piece monokini swimsuit",
  "nuisette":"wearing a short silk babydoll nightie","pyjama_sexy":"wearing a satin pyjama set",
  "chemise_homme":"wearing only an oversized men's dress shirt","cuir_veste":"wearing a leather jacket",
  "maitresse":"maitresse_cuir","bondage":"avec_cordes","harnais":"bdsm_harness",
  "collant_resille":"bas_resille","yoga":"wearing yoga leggings and a sports bra, yoga pose",
  "nurse":"nurse_dom","servante":"femme_de_menage",
  "pin_up":"retro pin-up style, vintage 1950s glamour, high-waisted retro outfit",
  "lolita":"Japanese gothic lolita fashion, frilly Victorian-style dress, elegant modest",
  "lingerie_garter":"wearing a garter belt with stockings and lingerie set",
  // — homme
  "costume":"wearing an elegant tailored suit and tie","chemise_ouverte":"wearing an open dress shirt, bare chest",
  "jean_casual":"wearing casual jeans and a fitted t-shirt","boxers":"wearing only boxer briefs",
  "nu_masculin":"nue","sport_masc":"shirtless in gym shorts, athletic gym setting",
  "militaire":"wearing a military uniform","motard":"wearing a biker leather jacket, motorcycle background",
  "cuir_masc":"wearing a black leather outfit","dom_masc":"dominant commanding male pose, leather, powerful stance",
  "sous_masc":"submissive kneeling male pose","bondage_masc":"avec_cordes",
  "latex_masc":"wearing a black latex outfit","harness_masc":"bdsm_harness",
  "peignoir":"wearing an open bathrobe","nu_lit":"nue_allongee",
  // — trans (alias vers clés existantes)
  "lingerie_trans":"lingerie_noir","robe_trans":"robe_soiree","sport_trans":"sport","casual_trans":"casual",
  "dom_trans":"dominatrice","sub_trans":"soumise","nu_trans":"nue","harnais_trans":"bdsm_harness",
  "latex_trans":"lingerie_latex","kimono_trans":"kimono"
};

// Résout un id/texte de tenue en description : catalogue → alias → texte libre → id lisible.
function resolveTenue(t) {
  if (!t) return null;
  const k = String(t).trim();
  if (TENUES_CATALOGUE[k]) return TENUES_CATALOGUE[k];          // clé directe
  const a = TENUE_ALIAS[k];
  if (a) return TENUES_CATALOGUE[a] || a;                       // alias = clé OU description
  if (k.includes(" ")) return k;                               // tenue tapée librement
  return k.replace(/_/g, " ");                                 // dernier recours lisible
}

function buildComfyPrompt(ext, style, tenue, userPrefs) {
  const parts = [];
  const age    = parseInt(ext.age) || 25;
  const corp   = (ext.corpulence  || "").toLowerCase();
  const genre  = (ext.genre       || "femme").toLowerCase();
  // ✅ v13 : genre-aware — homme, femme, trans, non-binaire
  const isHomme     = genre.includes("homme") && !genre.includes("trans");
  // Fallback : si statut_chirurgical contient phalloplastie/vaginoplastie → trans même si genre="femme"
  const _stcBuild = (ext.statut_chirurgical||"").toLowerCase();
  const isFemTrans  = genre.includes("femme trans") || genre.includes("trans femme")
    || _stcBuild.includes("phalloplastie") || _stcBuild.includes("vaginoplastie");
  const isHomTrans  = genre.includes("homme trans") || genre.includes("trans masc");
  const isNB        = genre.includes("non-binaire") || genre.includes("non binaire") || genre.includes("fluide");
  // isFem = tout ce qui n'est pas homme cis
  const isFem       = !isHomme || isFemTrans;
  const genderWord  = isHomme ? "man" : isNB ? "androgynous person" : isFemTrans ? "transgender woman" : "woman";

  // ── STYLE CANDY AI / PHOTORÉALISTE ───────────────────────────
  parts.push("photorealistic photograph, RAW photo, professional photography, sharp focus, natural lighting, realistic skin, real human");

  // ── CORPS / CORPULENCE — genre-aware ─────────────────────────
  // Chaque clé génère la description correcte selon le genre
  const buildCorpDesc = (key) => {
    const w = genderWord;
    const map = {
      "bbw":         `morbidly obese extremely fat BBW ${age} year old ${w}, enormous belly, massive thighs, huge fat body, super plus size`,
      "généreuse":   `very fat BBW ${age} year old ${w}, extremely chubby plus-size, massive fat body, heavy fat rolls`,
      "musclée":     isFem ? `muscular fit bodybuilder ${age} year old ${w}, very defined muscles, ripped physique, strong arms and legs`
                           : `muscular athletic ${age} year old ${w}, very defined muscles, ripped fit body, strong chest and arms`,
      "musclé":      isHomme ? `muscular athletic ${age} year old man, very defined muscles, ripped fit body, strong chest and arms`
                             : `muscular fit ${age} year old ${w}, very defined muscles, toned physique`,
      "pulpeuse":    `voluptuous curvy ${age} year old ${w}, perfect hourglass figure, full natural curves`,
      "voluptueuse": `voluptuous curvy ${age} year old ${w}, perfect hourglass figure, full natural curves`,
      "ronde":       `plus size chubby ${age} year old ${w}, soft round curves, full figured body`,
      "athlétique":  isHomme ? `athletic ${age} year old man, lean fit physique, defined abs and chest`
                             : `athletic toned ${age} year old ${w}, fit lean physique, defined abs`,
      "athletique":  isHomme ? `athletic ${age} year old man, lean fit physique, defined abs and chest`
                             : `athletic toned ${age} year old ${w}, fit lean physique, defined abs`,
      "élancée":     isHomme ? `tall slender ${age} year old man, lean build, long legs`
                             : `tall slender elegant ${age} year old ${w}, long legs, graceful silhouette`,
      "elancee":     isHomme ? `tall slender ${age} year old man, lean build, long legs`
                             : `tall slender elegant ${age} year old ${w}, long legs, graceful silhouette`,
      "mince":       isHomme ? `slim slender ${age} year old man, lean body, thin waist`
                             : `slim slender thin ${age} year old ${w}, petite frame, thin waist`,
      "petite":      `petite small ${age} year old ${w}, short and slim`,
      "compact":     `compact ${age} year old ${w}, average height, balanced proportions`,
    };
    return map[key] || null;
  };

  let matched = false;
  for (const key of Object.keys({bbw:"",généreuse:"",musclée:"",musclé:"",pulpeuse:"",voluptueuse:"",ronde:"",athlétique:"",athletique:"",élancée:"",elancee:"",mince:"",petite:"",compact:""})) {
    if (corp.includes(key)) {
      const desc = buildCorpDesc(key);
      if (desc) { parts.push(desc); matched = true; break; }
    }
  }
  if (!matched) {
    if      (isHomme)    parts.push(`${age} year old man, average build`);
    else if (isNB)       parts.push(`${age} year old androgynous person, slim build`);
    else                 parts.push(`beautiful ${age} year old woman`);
  }

  // ✅ v18 — Signal morphologique TRANS (corrige l'oubli post-op : genre + statut_chirurgical
  //          n'entraient jamais dans le prompt pour une femme trans opérée → rendue comme femme cis)
  if (isFemTrans) {
    const stc = (ext.statut_chirurgical || "").toLowerCase();
    let transMorph = "transgender woman, feminine passing trans woman";
    if (stc.includes("vaginoplastie") || stc.includes("opéré complet") || stc.includes("néo-vagin") || (stc.includes("opéré") && stc.includes("bas")))
      transMorph += ", post-op MTF trans woman after gender confirming surgery, fully feminized body and face";
    else if (stc.includes("opéré haut") || stc.includes("torse"))
      transMorph += ", feminized chest, hormone therapy feminized body";
    else if (stc.includes("pré-op") || stc.includes("non opéré"))
      transMorph += ", pre-op trans woman, hormone therapy feminized body";
    parts.push(transMorph);
  }

  if (ext.taille) parts.push(`${ext.taille} tall`);

  // ── TONICITÉ ─────────────────────────────────────────────────
  const ton = (ext.tonicite || "").toLowerCase();
  if      (ton.includes("très musclée") || ton.includes("définie")) parts.push("extremely toned defined physique, visible muscle definition");
  else if (ton.includes("tonique"))  parts.push("toned fit body, firm skin");
  else if (ton.includes("douce") || ton.includes("moelleuse")) parts.push("soft plush skin, gentle natural curves");

  // ── CHEVEUX — genre-aware ────────────────────────────────────
  const ch = (ext.cheveux || "").toLowerCase();
  const lg = (ext.longueur_cheveux || "").toLowerCase();
  // Couleur
  if      (ch.includes("noire") || ch.includes("noir"))   parts.push(isHomme ? "black hair" : "black hair");
  else if (ch.includes("brun") || ch.includes("châtain")) parts.push("brunette hair");
  else if (ch.includes("roux") || ch.includes("rousse"))  parts.push("auburn red hair");
  else if (ch.includes("platine") || ch.includes("blanc blond")) parts.push("platinum blonde hair");
  else if (ch.includes("blond"))  parts.push("blonde hair");
  else if (ch.includes("noir"))   parts.push("black hair");
  else if (ch.includes("gris"))   parts.push("silver grey hair");
  else if (ch.includes("coloré") || ch.includes("rose") || ch.includes("bleu")) parts.push(`${ext.cheveux} colored hair`);
  if      (lg.includes("rasé") || lg.includes("très court")) parts.push("shaved head, very short hair");
  else if (lg.includes("court"))   parts.push("short hair");
  else if (lg.includes("mi"))      parts.push("medium length hair");
  else if (lg.includes("très long")) parts.push("very long hair down to waist");
  else if (lg.includes("long"))    parts.push("long flowing hair");
  const tex = (ext.texture_cheveux || "").toLowerCase();
  if      (tex.includes("bouclés")) parts.push("curly hair");
  else if (tex.includes("frisés") || tex.includes("afro")) parts.push("natural afro curly hair");
  else if (tex.includes("ondulés")) parts.push("wavy hair");
  else if (tex.includes("lisses"))  parts.push("straight sleek hair");

  // ── YEUX ─────────────────────────────────────────────────────
  const y = (ext.yeux || "").toLowerCase();
  if      (y.includes("bleu"))    parts.push("piercing blue eyes");
  else if (y.includes("vert"))    parts.push("bright green eyes");
  else if (y.includes("marron") || y.includes("brun")) parts.push("brown eyes");
  else if (y.includes("noir"))    parts.push("dark black eyes");
  else if (y.includes("noisette")) parts.push("hazel eyes");
  else if (y.includes("gris"))    parts.push("grey eyes");

  // ── PEAU ─────────────────────────────────────────────────────
  const p = (ext.couleur_peau || "").toLowerCase();
  if      (p.includes("très claire") || p.includes("albâtre")) parts.push("very pale porcelain skin");
  else if (p.includes("claire"))  parts.push("fair pale skin");
  else if (p.includes("mat"))     parts.push("olive tan skin");
  else if (p.includes("dorée") || p.includes("bronzée")) parts.push("golden tanned skin");
  else if (p.includes("caramel") || p.includes("miel"))  parts.push("caramel honey skin");
  else if (p.includes("brun"))    parts.push("dark brown skin");
  else if (p.includes("ébène") || p.includes("noire"))   parts.push("dark ebony skin");
  else if (p.includes("métisse")) parts.push("mixed race brown skin");
  else if (p.includes("asiatique") || p.includes("porcelaine")) parts.push("asian porcelain skin");

  // ── LÈVRES FACIALES ──────────────────────────────────────────
  const lev = (ext.taille_levres || "").toLowerCase();
  if      (lev.includes("xxl") || lev.includes("hyper"))    parts.push("extremely full pouty lips, huge lips");
  else if (lev.includes("très pulp"))                        parts.push("very full pouty plump lips");
  else if (lev.includes("pulp"))                             parts.push("full pouty lips");
  else if (lev.includes("fine") || lev.includes("discret")) parts.push("thin lips");

  // ── MAQUILLAGE ───────────────────────────────────────────────
  const maq = (ext.maquillage || "").toLowerCase();
  if      (maq.includes("smoky") || maq.includes("yeux dramatiques")) parts.push("dramatic smoky eye makeup");
  else if (maq.includes("rouge"))  parts.push("dark red lipstick makeup");
  else if (maq.includes("naturel") || maq.includes("sans")) parts.push("natural minimal makeup");
  else if (maq.length > 2)         parts.push("makeup");

  // ── CORPS FÉMININ ─────────────────────────────────────────────
  const statutChirImgStr = (ext.statut_chirurgical || "").toLowerCase();
  const hasPhalloplastie = statutChirImgStr.includes("phalloplastie");
  // (hasNeoVaginImg retiré v18 : code mort — le statut post-op est désormais géré plus haut via transMorph)
  if (isFem) {
    // Seins
    const s = (ext.taille_seins || "").toLowerCase();
    if      (s.includes("xxl") || s.includes("bonnet g") || s.includes("g et plus") || s.includes("seins xxl")) parts.push("huge saggy natural G cup breasts hanging heavily, very large pendulous breasts with natural droop, massive chest with big tits resting on belly, heavy full natural breasts");
    else if (s.includes("énorme") || s.includes("bonnet f") || s.includes("f+")) parts.push("enormous F cup breasts, huge massive breasts");
    else if (s.includes("très gros") || s.includes("bonnet e") || s.includes("bonnet d")) parts.push("large D-E cup breasts, big bust");
    else if (s.includes("généreux") || s.includes("bonnet c")) parts.push("C cup breasts, full natural breasts");
    else if (s.includes("moyen") || s.includes("bonnet b")) parts.push("medium B cup breasts, natural bust");
    else if (s.includes("petit") || s.includes("bonnet a")) parts.push("small A cup breasts, petite chest");
    else if (s.includes("plate") || s.includes("aa"))       parts.push("flat chest, minimal breasts");

    // Forme seins — pour G+ BBW forcer teardrop/pendulaire peu importe le choix
    const fs = (ext.forme_seins || "").toLowerCase();
    const isXXLBBW = (s.includes("xxl") || s.includes("g et") || s.includes("bonnet g")) && (corp.includes("bbw") || corp.includes("généreuse") || corp.includes("ronde"));
    if (isXXLBBW || fs.includes("goutte") || fs.includes("teardrop")) parts.push("natural teardrop shaped breasts with soft droop, heavy pendulous natural hang");
    else if (fs.includes("implant") || fs.includes("parfaitement ronds")) parts.push("perfectly round implanted breasts, enhanced spherical");
    else if (fs.includes("fermes") && fs.includes("hauts") && !isXXLBBW)  parts.push("firm perky high breasts");
    else if (fs.includes("naturels ronds"))                  parts.push("naturally round perky breasts");
    else if (fs.includes("écartés"))                         parts.push("wide-set breasts");

    // Tétons
    const tet = (ext.teton || "").toLowerCase();
    if      (tet.includes("percés") || tet.includes("piercings")) parts.push("nipple piercings");
    else if (tet.includes("très proéminents") || tet.includes("érectiles")) parts.push("very prominent large erect nipples");
    else if (tet.includes("gros"))     parts.push("large prominent nipples");
    else if (tet.includes("petits"))   parts.push("small delicate nipples");
    else if (tet.includes("plats"))    parts.push("flat nipples");

    // Fesses
    const f = (ext.forme_fesses || "").toLowerCase();
    if      (f.includes("énormes") || f.includes("booty") || f.includes("xxl")) parts.push("enormous huge ass, massive booty, gigantic buttocks");
    else if (f.includes("très grosse") || f.includes("très gross"))              parts.push("very big round ass, huge buttocks");
    else if (f.includes("généreux") || f.includes("généreuse") || f.includes("bombée") || f.includes("bubble")) parts.push("big round generous bubble butt");
    else if (f.includes("grosse") || f.includes("gros"))  parts.push("big full ass");
    else if (f.includes("petite") || f.includes("ferme")) parts.push("small firm perky butt");
    // Forme fesses
    const ffs = (ext.forme_fesses_shape || "").toLowerCase();
    if      (ffs.includes("cœur") || ffs.includes("heart")) parts.push("heart-shaped ass");
    else if (ffs.includes("molles") || ffs.includes("coussins")) parts.push("soft jiggly ass");
    else if (ffs.includes("fermes") || ffs.includes("toniques")) parts.push("firm toned ass");

    // Hanches
    const h = (ext.hanches || "").toLowerCase();
    if      (h.includes("très large"))  parts.push("very wide hips, enormous hip curves");
    else if (h.includes("large"))        parts.push("wide hips, generous feminine curves");
    else if (h.includes("étroit") || h.includes("fine") || h.includes("narrow")) parts.push("narrow hips");

    // Ventre
    const v = (ext.ventre || "").toLowerCase();
    if      (v.includes("musclé") || v.includes("abdos"))   parts.push("flat toned abs, defined stomach");
    else if (v.includes("plat"))                             parts.push("flat belly");
    else if (v.includes("légèrement"))                       parts.push("slightly soft belly");
    else if (v.includes("arrondi") || v.includes("dodu"))   parts.push("rounded plump tummy");
    else if (v.includes("rebondi") || v.includes("généreux")) parts.push("big round belly");

    // Jambes
    const j = (ext.jambes || "").toLowerCase();
    if      (j.includes("très charnues") || j.includes("grosses cuisses")) parts.push("very thick meaty thighs, heavy legs");
    else if (j.includes("charnue") || j.includes("pulpeuse"))  parts.push("thick full thighs, chubby legs");
    else if (j.includes("athlétique") || j.includes("musclée")) parts.push("athletic muscular toned legs");
    else if (j.includes("fine") && j.includes("longue"))    parts.push("long slim slender legs");
    else if (j.includes("longue"))                           parts.push("long legs");

    // Pilosité intime
    const pil = hasPhalloplastie ? "" : (ext.style_pilosite || ext.pilosite || "").toLowerCase();
    const coulPil = (ext.couleur_pilosite || "").toLowerCase();
    let pilDesc = "";
    if      (pil.includes("rasée") || pil.includes("épilée") || pil.includes("intégrale")) pilDesc = "completely shaved smooth bare pussy";
    else if (pil.includes("landing") || pil.includes("bande fine"))  pilDesc = "landing strip pubic hair";
    else if (pil.includes("triangle"))  pilDesc = "trimmed triangle pubic hair";
    else if (pil.includes("taillée fine")) pilDesc = "neatly trimmed close pubic hair";
    else if (pil.includes("taillée"))    pilDesc = "trimmed pubic hair";
    else if (pil.includes("fournie") || pil.includes("bush")) pilDesc = "full natural thick pubic bush";
    else if (pil.includes("naturelle"))  pilDesc = "natural pubic hair";
    if (pilDesc) {
      if      (coulPil.includes("blonde"))  pilDesc += ", blonde pubic hair";
      else if (coulPil.includes("brune") || coulPil.includes("brun")) pilDesc += ", dark brunette pubic hair";
      else if (coulPil.includes("noire") || coulPil.includes("noir")) pilDesc += ", black pubic hair";
      else if (coulPil.includes("rousse"))  pilDesc += ", red pubic hair";
      parts.push(pilDesc);
    }

    // Lèvres intimes — SKIP si phalloplastie (pas de vulve après chirurgie)
    if (!hasPhalloplastie) {
      const li = (ext.levres_intimes || ext.morpho_intime || "").toLowerCase();
      if      (li.includes("très proéminentes") || li.includes("généreuses")) parts.push("large prominent labia, big inner lips");
      else if (li.includes("proéminentes"))  parts.push("visible protruding inner labia");
      else if (li.includes("très discrètes") || li.includes("invisible")) parts.push("minimal flat labia, tight smooth");
      else if (li.includes("discrètes"))     parts.push("small discrete labia");
      // Clitoris
      const cl = (ext.clitoris || "").toLowerCase();
      if      (cl.includes("très proéminent")) parts.push("very prominent visible clitoris");
      else if (cl.includes("proéminent"))      parts.push("prominent clitoris");
    }
  }

  // ── CORPS MASCULIN ────────────────────────────────────────────
  const anatomieLibre = (ext.anatomie_libre || "") === "true";
  // Fallback : si statut_chirurgical contient phalloplastie/vaginoplastie → trans même si genre="femme"
  const _stcFinal = (ext.statut_chirurgical||"").toLowerCase();
  const isTransFemme  = genre.includes("femme trans") || genre.includes("trans femme")
    || _stcFinal.includes("phalloplastie") || _stcFinal.includes("vaginoplastie");
  const hasEquipement = (ext.taille_sexe_m || "").trim().length > 3;
  // ✅ Fix v12 : montrer l'anatomie masculine pour :
  // - Genre masculin/non-binaire (comme avant)
  // - Mode hybride actif
  // - Trans femme avec équipement défini (pre-op ou non-op)
  const showMasc = genre.includes("homme") || genre.includes("trans femme") || genre.includes("femme trans") || genre.includes("non-binaire") || genre.includes("fluide");
  const showMascAnatomy = showMasc && (!isFem || anatomieLibre || (isTransFemme && hasEquipement));

  if (showMascAnatomy) {
    // Torse (pour homme / non-binaire / trans masc)
    if (!isTransFemme || !isFem) {
      const pec = (ext.pectoraux || "").toLowerCase();
      if      (pec.includes("très musclés") || pec.includes("imposant")) parts.push("massive muscular pecs, huge chest muscles");
      else if (pec.includes("développés"))  parts.push("developed pectoral muscles");
      const abd = (ext.abdominaux || "").toLowerCase();
      if      (abd.includes("très définis") || abd.includes("tablette")) parts.push("extremely defined six pack abs, chiseled core");
      else if (abd.includes("six-pack") || abd.includes("six pack"))     parts.push("visible six pack abs");
    }
    // ── Anatomie intime masculine avec taille complète ──────────
    const ts = (ext.taille_sexe_m || "").toLowerCase();
    const ep = (ext.epaisseur_sexe_m || "").toLowerCase();
    const fo = (ext.forme_sexe_m || "").toLowerCase();
    const ci = (ext.circoncis || "").toLowerCase();
    const te = (ext.testicules || "").toLowerCase();
    const pm = (ext.pilosite_masc || "").toLowerCase();

    if (ts) {
      // ✅ Pour trans femme : préciser le type (phalloplastie post-op ou pre-op)
      const transPrefix = (isTransFemme && isFem)
        ? (hasPhalloplastie
            ? "a transgender woman who has both female breasts and a natural penis as part of her body, "
            : "pre-op trans woman, transgender woman still has original cock, ")
        : "";
      if      (ts.includes("xxl") || ts.includes("23")) parts.push(transPrefix + "her penis is fully erect and rigid, hard erection pointing upward toward her navel, turgid erect penis standing up from groin, same skin color as body, attached to her pubic area, fully hard not flaccid");
      else if (ts.includes("très grand") || ts.includes("19")) parts.push(transPrefix + "visible erect penis part of her body at groin level, natural erect phallus");
      else if (ts.includes("grand") || ts.includes("15"))  parts.push(transPrefix + "large penis, above average cock");
      else if (ts.includes("moyen"))                        parts.push(transPrefix + "average size cock");
      else if (ts.includes("petit"))                        parts.push(transPrefix + "small penis");
    }
    if      (ep.includes("très épaisse") || ep.includes("imposante")) parts.push("extremely thick girth, very fat cock");
    else if (ep.includes("épaisse") || ep.includes("grosse"))         parts.push("thick girth cock");
    if      (fo.includes("champignon") || fo.includes("gland large")) parts.push("large mushroom head glans");
    else if (fo.includes("courbé vers le haut")) parts.push("upward curved penis");
    if      (ci.includes("circoncis") && !ci.includes("non"))  parts.push("circumcised penis");
    else if (ci.includes("non circoncis") || ci.includes("prépuce")) parts.push("uncircumcised foreskin penis");
    if      (te.includes("très généreux") || te.includes("imposant")) parts.push("very large heavy balls, huge scrotum");
    else if (te.includes("généreux"))  parts.push("large full balls");
    if      (pm.includes("rasée") || pm.includes("complète")) parts.push("shaved pubic area");
    else if (pm.includes("fournie"))   parts.push("full thick pubic hair");
  } else if (isTransFemme && hasEquipement) {
    // Fallback minimal si le bloc principal n'a pas été exécuté
    const ts = (ext.taille_sexe_m || "").toLowerCase();
    if (ts.includes("xxl") || ts.includes("23")) parts.push("pre-op trans woman, enormous huge cock between legs, XXL penis");
    else if (ts) parts.push("pre-op transgender woman, penis visible between legs");
  }

  // ── TATOUAGES ─────────────────────────────────────────────────
  const tats = (ext.tatouages || "").toLowerCase();
  if (tats.length > 2) {
    if (tats.includes("fin") || tats.includes("délicat"))  parts.push("delicate fine line tattoos");
    else if (tats.includes("dragon")) parts.push("large dragon tattoo on back, heavily tattooed");
    else if (tats.includes("manchette") || tats.includes("bras")) parts.push("sleeve tattoo on arm");
    else if (tats.includes("entier") || tats.includes("dos") || tats.includes("full") || tats.includes("complet")) parts.push("full back tattoo, heavily tattooed");
    else if (tats.includes("fleur") || tats.includes("rose")) parts.push("floral tattoos");
    else parts.push("visible tattoos");
  }

  // ── PIERCINGS ─────────────────────────────────────────────────
  const pc = (ext.piercings || "").toLowerCase();
  const pp = [];
  if (pc.includes("sein") || pc.includes("téton")) pp.push("nipple piercings");
  if (pc.includes("nombril"))   pp.push("belly button piercing");
  if (pc.includes("nez") || pc.includes("septum")) pp.push(pc.includes("septum") ? "septum piercing" : "nose ring piercing");
  if (pc.includes("labret") || pc.includes("lèvre") || pc.includes("bouche")) pp.push("labret lip piercing");
  if (pc.includes("oreille") || pc.includes("lobe") || pc.includes("helix")) pp.push("ear piercings");
  if (pc.includes("arcade") || pc.includes("sourcil")) pp.push("eyebrow piercing");
  if (pc.includes("langue")) pp.push("tongue piercing");
  if (pc.includes("intime") || pc.includes("vch") || pc.includes("clito") || pc.includes("labia")) pp.push("intimate piercing");
  if (pc.includes("prince albert") || pc.includes("frenum") || pc.includes("pénis")) pp.push("cock piercing");
  if (pp.length) parts.push(pp.join(", "));

  // ── LUNETTES ──────────────────────────────────────────────────
  const lun = (ext.lunettes || "").toLowerCase();
  if (lun.length > 2) {
    if      (lun.includes("soleil") || lun.includes("aviateur")) parts.push("wearing stylish sunglasses");
    else if (lun.includes("carrées") || lun.includes("carré")) parts.push("wearing square black glasses frames");
    else if (lun.includes("rondes") || lun.includes("round")) parts.push("wearing round glasses");
    else if (lun.includes("chat") || lun.includes("cat")) parts.push("wearing cat-eye glasses");
    else if (lun.includes("noire") || lun.includes("noir")) parts.push("wearing black glasses frames");
    else parts.push("wearing glasses, " + lun);
  }

  // ── BIJOUX & ACCESSOIRES ──────────────────────────────────────
  const bij = [];
  const bijStr = (ext.bijoux || "").toLowerCase();
  const col = (ext.collier_bijou || ext.bijoux || "").toLowerCase();
  const boucl = (ext.boucles_oreilles || "").toLowerCase();
  const bgue = (ext.bague || "").toLowerCase();
  const brac = (ext.bracelet || "").toLowerCase();
  const montr = (ext.montre || "").toLowerCase();

  if (col.includes("collier") || col.includes("necklace")) {
    if (col.includes("cuir") || col.includes("clouté") || col.includes("spike")) bij.push("spiked leather choker necklace");
    else if (col.includes("or") || col.includes("gold")) bij.push("gold necklace");
    else if (col.includes("perle")) bij.push("pearl necklace");
    else if (col.includes("chaîne") || col.includes("chain")) bij.push("chain necklace");
    else bij.push("necklace");
  }
  if (boucl.includes("boucle") || boucl.includes("oreille") || boucl.includes("earring")) {
    if (boucl.includes("or")) bij.push("gold earrings");
    else if (boucl.includes("créole") || boucl.includes("hoop")) bij.push("hoop earrings");
    else bij.push("earrings");
  }
  if (bgue.includes("bague") || bgue.includes("ring")) {
    if (bgue.includes("or")) bij.push("gold ring");
    else if (bgue.includes("argent")) bij.push("silver ring");
    else bij.push("ring on finger");
  }
  if (brac.includes("bracelet") || bijStr.includes("bracelet")) {
    if (bijStr.includes("acier") || bijStr.includes("steel")) bij.push("steel bracelet");
    else if (brac.includes("or") || bijStr.includes("or")) bij.push("gold bracelet");
    else bij.push("bracelet");
  }
  if (montr.includes("montre") || montr.includes("watch")) bij.push("wearing a watch");
  // Parsing libre si champ bijoux contient des infos non captées
  if (bijStr.includes("collier cuir") || bijStr.includes("cuir clouté")) bij.push("spiked leather choker");
  if (bij.length > 0) parts.push(bij.filter((v,i,a) => a.indexOf(v)===i).join(", "));

  // ── TENUE ─────────────────────────────────────────────────────
  const sk = style || "portrait";
  // ✅ v18 — la tenue OU le style choisi passe par le catalogue/alias.
  //   Avant : `parts.push(tenue)` poussait l'id brut (ex "pin_up") → tenue ignorée ;
  //   et l'UI envoie l'id de tenue dans `style` (generateAIAvatar(s.id)),
  //   donc on résout AUSSI `sk` via le catalogue/alias.
  const tenueDesc = resolveTenue(tenue) || resolveTenue(sk);
  parts.push(tenueDesc || "elegant natural confident pose");

  // Accessoires appris
  const jouets = userPrefs?.accessoires || "";
  if (jouets) parts.push(jouets);

  // ── QUALITÉ FINALE (style Candy AI) ──────────────────────────
  if (sk.includes("domin") || sk.includes("maitresse") || sk.includes("bdsm"))
    parts.push("dramatic dark moody lighting, powerful dominant atmosphere");
  else if (sk.includes("nue") || sk.includes("boudoir") || sk.includes("explic"))
    parts.push("soft intimate boudoir lighting, sensual atmosphere");
  else if (sk.includes("selfie"))
    parts.push("natural authentic candid lighting, selfie angle");
  else
    parts.push("professional studio lighting, clean sharp image");

  return parts.filter(Boolean).join(", ");
}

// ✅ v14 — Post-process: pour Lumina/Z-Image-Turbo, la narration marche mieux que les tags
// On intercale une description de scène quand l'anatomie trans est présente
function buildComfyPromptFinal(ext, style, tenue, userPrefs) {
  const raw = buildComfyPrompt(ext, style, tenue, userPrefs);

  const genre = (ext.genre || "").toLowerCase();
  const statut = (ext.statut_chirurgical || "").toLowerCase();
  const tailleSexe = (ext.taille_sexe_m || "").toLowerCase();

  const isTransWithPenis = (genre.includes("trans") || (ext.anatomie_libre === "true")) &&
                           tailleSexe && tailleSexe.length > 3;

  if (!isTransWithPenis) return raw;

  // ✅ v18.1 — Respecter la tenue : la narration anatomique nue ne s'active QUE si la scène
  //   est explicitement nue (nude/naked/topless/bottomless). Un portrait ou une tenue habillée
  //   d'une femme trans reste habillé — fin du "tout sort nu". (raw porte déjà le signal trans.)
  if (!/\b(nude|naked|topless|bottomless)\b/i.test(raw)) return raw;

  // Taille du pénis en mots
  const penisSize = tailleSexe.includes("xxl") || tailleSexe.includes("23") ? "large thick" :
                    tailleSexe.includes("très grand") ? "large" :
                    tailleSexe.includes("grand") ? "above average" : "medium";

  // Type selon le statut
  const penisType = statut.includes("phalloplastie")
    ? "surgically constructed phallus (phalloplasty)"
    : "natural original penis";

  // ✅ v13 — Corpulence précise pour la narration trans
  const corpTrans = (ext.corpulence || "").toLowerCase();
  const bodyDesc = corpTrans.includes("bbw") || corpTrans.includes("généreuse") ? "obese plus-size curvy" :
                   corpTrans.includes("ronde") ? "plus-size chubby" :
                   corpTrans.includes("pulp") ? "voluptuous curvy" :
                   corpTrans.includes("musclée") || corpTrans.includes("musclé") ? "athletic muscular" :
                   corpTrans.includes("athlétique") ? "athletic toned" :
                   corpTrans.includes("élancée") || corpTrans.includes("elancee") ? "slender slim" :
                   corpTrans.includes("mince") ? "slim thin" : "average build";

  // ✅ v13 — Taille seins précise (pas de "large" pour bonnet A/B)
  const seinsSize = (ext.taille_seins || "").toLowerCase();
  const breastDesc = seinsSize.includes("xxl") || seinsSize.includes("bonnet g") || seinsSize.includes("g et") ? "very large natural hanging breasts" :
                     seinsSize.includes("bonnet f") || seinsSize.includes("énorme") ? "large F cup breasts" :
                     seinsSize.includes("bonnet e") || seinsSize.includes("bonnet d") || seinsSize.includes("très gros") ? "large D-E cup breasts" :
                     seinsSize.includes("bonnet c") || seinsSize.includes("généreux") ? "C cup breasts" :
                     seinsSize.includes("bonnet b") || seinsSize.includes("moyen") ? "medium B cup breasts" :
                     seinsSize.includes("bonnet a") || seinsSize.includes("petit") ? "small A cup breasts, petite chest" :
                     seinsSize.includes("plate") || seinsSize.includes("plat") ? "nearly flat chest, minimal breasts" :
                     "small natural breasts";

  // Prompt narratif complet — Lumina comprend les phrases mieux que les tags
  // ✅ v17 — Tokens Juggernaut simples pour trans avec pénis
  const narrative = `naked nude ${bodyDesc} transgender woman, ${breastDesc}, erect penis visible between thighs, thick hard cock, large penis at groin, she has both breasts and a penis, topless nude`;

  // On garde les éléments non-anatomiques du prompt original (cheveux, style, lumière)
  const keepParts = raw.split(", ").filter(p => {
    const pl = p.toLowerCase();
    return !pl.includes("obese") && !pl.includes("fat") && !pl.includes("bbw") &&
           !pl.includes("breast") && !pl.includes("tits") && !pl.includes("boob") &&
           !pl.includes("penis") && !pl.includes("cock") && !pl.includes("phallus") &&
           !pl.includes("phalloplasty") && !pl.includes("transgender woman body") &&
           !pl.includes("trans") && !pl.includes("intersex") && !pl.includes("woman with");
  }).join(", ");

  return `${narrative}, ${keepParts}`;
}

function getAvatarSeed(ext) {
  if (ext.avatar_seed && ext.avatar_seed !== "null" && ext.avatar_seed !== "undefined") {
    const n = parseInt(ext.avatar_seed);
    if (!isNaN(n) && n > 0) return n;
  }
  return Math.floor(Math.random() * 2**32);
}

function extraireAccessoires(message) {
  const m = (message||"").toLowerCase();
  const found = [];
  for (const [fr] of Object.entries(ACCESSOIRES_CATALOGUE)) {
    if (m.includes(fr)) found.push(fr);
  }
  return found;
}

function getStylesCatalogue() {
  return [
    {cat:"📸 Portraits", styles:[
      {id:"portrait",label:"Portrait visage",emoji:"🎭"},
      {id:"portrait_sourire",label:"Sourire naturel",emoji:"😊"},
      {id:"portrait_regard",label:"Regard intense",emoji:"👁️"},
      {id:"buste_nu",label:"Buste nu",emoji:"🌸"},
      {id:"buste_lingerie",label:"Buste lingerie",emoji:"🎀"}
    ]},
    {cat:"👤 Corps entier", styles:[
      {id:"entiere",label:"Debout",emoji:"🌟"},
      {id:"entiere_allongee",label:"Allongée",emoji:"🛏️"},
      {id:"entiere_dos",label:"De dos",emoji:"✨"},
      {id:"talons_nus",label:"Nue + talons",emoji:"👠"}
    ]},
    {cat:"🩱 Lingerie", styles:[
      {id:"lingerie_noir",label:"Lingerie noire",emoji:"🖤"},
      {id:"lingerie_rouge",label:"Lingerie rouge",emoji:"❤️"},
      {id:"lingerie_blanc",label:"Lingerie blanche",emoji:"🤍"},
      {id:"lingerie_latex",label:"Latex",emoji:"⚡"},
      {id:"string",label:"String seul",emoji:"🔥"},
      {id:"body",label:"Body",emoji:"💃"},
      {id:"bustier",label:"Bustier corset",emoji:"⏳"},
      {id:"bas_resille",label:"Bas résille",emoji:"🕸️"}
    ]},
    {cat:"⛓️ Dominatrice", styles:[
      {id:"dominatrice",label:"Latex dominatrice",emoji:"⛓️"},
      {id:"maitresse_cuir",label:"Maîtresse cuir",emoji:"🖤"},
      {id:"maitresse_latex",label:"Latex total",emoji:"✊"},
      {id:"maitresse_pvc",label:"PVC brillant",emoji:"💎"},
      {id:"goddess",label:"Déesse harnais",emoji:"👑"},
      {id:"bdsm_harness",label:"Harnais cuir",emoji:"🔗"},
      {id:"teacher_dom",label:"Professeure",emoji:"📚"},
      {id:"nurse_dom",label:"Infirmière",emoji:"🏥"},
      {id:"police_dom",label:"Policière",emoji:"👮"}
    ]},
    {cat:"🔞 Accessoires & Jouets", styles:[
      {id:"avec_vibro",label:"Vibromasseur",emoji:"💜"},
      {id:"avec_gode",label:"Gode",emoji:"🍆"},
      {id:"avec_plug",label:"Plug anal",emoji:"🔌"},
      {id:"avec_gode_ceinture",label:"Gode-ceinture",emoji:"⚡"},
      {id:"avec_baton_massage",label:"Magic Wand",emoji:"🪄"},
      {id:"avec_plug_queue",label:"Queue décorative",emoji:"🦊"},
      {id:"avec_menottes",label:"Menottes",emoji:"🔒"},
      {id:"avec_cravache",label:"Cravache",emoji:"🏇"},
      {id:"avec_fouet",label:"Fouet",emoji:"🩸"},
      {id:"avec_cordes",label:"Shibari",emoji:"🎋"},
      {id:"avec_bandeau",label:"Bandeau yeux",emoji:"😶"},
      {id:"avec_bille",label:"Bâillon",emoji:"🔴"},
      {id:"avec_pinces",label:"Pinces tétons",emoji:"✂️"}
    ]},
    {cat:"🎭 Roleplay", styles:[
      {id:"secretaire",label:"Secrétaire",emoji:"💼"},
      {id:"femme_de_menage",label:"Femme de ménage",emoji:"🧹"},
      {id:"cheerleader",label:"Cheerleader",emoji:"📣"},
      {id:"strip_teaseuse",label:"Strip-teaseuse",emoji:"💫"},
      {id:"femme_fatale",label:"Femme fatale",emoji:"🕷️"},
      {id:"gothique",label:"Gothique",emoji:"🖤"},
      {id:"vampire",label:"Vampire",emoji:"🧛"},
      {id:"soumise",label:"Soumise liée",emoji:"🙏"},
      {id:"collier_laisse",label:"Collier laisse",emoji:"🐾"}
    ]},
    {cat:"🌸 Nue artistique", styles:[
      {id:"nue",label:"Nu artistique",emoji:"🌸"},
      {id:"nue_allongee",label:"Allongée",emoji:"🛏️"},
      {id:"nue_douche",label:"Douche",emoji:"🚿"},
      {id:"nue_bain",label:"Bain",emoji:"🛁"},
      {id:"nue_miroir",label:"Miroir",emoji:"🪞"},
      {id:"nue_nature",label:"Nature",emoji:"🌿"}
    ]},
    {cat:"📱 Selfies & Casual", styles:[
      {id:"selfie",label:"Selfie chambre",emoji:"📱"},
      {id:"selfie_lit",label:"Au lit",emoji:"🛌"},
      {id:"selfie_salle_de_bain",label:"Salle de bain",emoji:"🚿"},
      {id:"casual_maison",label:"Casual maison",emoji:"🏠"},
      {id:"sport",label:"Sport",emoji:"💪"},
      {id:"plage",label:"Plage bikini",emoji:"🏖️"},
      {id:"piscine",label:"Piscine",emoji:"🏊"}
    ]}
  ];
}

async function comfyGenerateImage(prompt, style, seed) {
  // ✅ v15 — Détecte automatiquement le meilleur modèle disponible
  // Ordre de priorité : SDXL réaliste (Juggernaut, RealVis, etc.) > Z Image Turbo
  const actualSeed = seed || Math.floor(Math.random() * 2**32);

  // Lister les modèles disponibles
  let checkpointModel = null;  // SDXL checkpoint (Juggernaut, RealVis, Pony...)
  let unetModel = null;        // Z Image Turbo UNET

  try {
    const mr = await fetch(COMFY_URL + "/object_info/CheckpointLoaderSimple", { signal: AbortSignal.timeout(3000) });
    if (mr.ok) {
      const mdata = await mr.json();
      const checkpoints = mdata?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      // Priorité : modèles photo-réalistes NSFW > Pony > autres
      const PREF_CKPT = ["juggernaut","realvis","cyberrealistic","epicrealism","realdream","perfectworld","dreamshaper","photon","pony"];
      for (const pref of PREF_CKPT) {
        const found = checkpoints.find(c => c.toLowerCase().includes(pref));
        if (found) { checkpointModel = found; console.log("[ComfyUI] ✅ Modèle SDXL sélectionné:", found); break; }
      }
    }
  } catch {}

  // ══ WORKFLOW SDXL — si un checkpoint réaliste est disponible ══════════
  if (checkpointModel) {
    const isPony = checkpointModel.toLowerCase().includes("pony");

    // Prompt adapté au modèle
    let positivePrompt = prompt;
    if (!isPony) {
      // ✅ v17 — Juggernaut Ragnarok : ajouter tokens photorealism (RAW, natural skin)
      const transPhotoTokens = positivePrompt.toLowerCase().includes("transgender") || positivePrompt.toLowerCase().includes("trans woman")
        ? ", vagina:0, vulva:0, female genitalia:0"  // forcer pas de vulve
        : "";
      positivePrompt = "RAW photo, photorealistic, realistic skin texture, skin pores, natural photography, DSLR, " + positivePrompt + transPhotoTokens;
    }
    if (isPony) {
      // ✅ v16 — Tags Pony corrects pour photo réaliste + anatomie trans
      // source_real = données photo réelles (pas anime)
      // Détection trans pour utiliser les tags futa de Pony
      const isTransPrompt = prompt.toLowerCase().includes("transgender") || prompt.toLowerCase().includes("trans woman") || prompt.toLowerCase().includes("phalloplasty");
      const transPonyTag = isTransPrompt
        ? ", futanari, futa, 1girl, female body with penis, erect cock, large penis between legs, cock at groin, "
        : ", 1girl, ";
      positivePrompt = "score_9, score_8_up, score_7_up, score_6_up, source_real, realistic, photorealistic, rating_explicit" + transPonyTag + prompt;
    }

    // ✅ v12 — Négatifs adaptatifs : ne pas bloquer l'anatomie demandée
    const wantsFemAnatomy = /vagina|vulva|pussy|labia|clitoris|pubic/i.test(prompt);
    const wantsMascAnatomy = /penis|cock|phallus|erect|foreskin|scrotum/i.test(prompt);
    const wantsBoth = wantsFemAnatomy && wantsMascAnatomy;
    const wantsToys = /dildo|vibrator|plug|strap.on|wand|rope|bondage|handcuff|crop|whip/i.test(prompt);
    let ponyNeg = "score_1, score_2, score_3, score_4, source_cartoon, source_anime, child, minor, underage";
    if (!wantsFemAnatomy && !wantsBoth) ponyNeg += ", vagina, vulva, female genitalia, labia, clitoris";
    if (!wantsMascAnatomy && !wantsBoth) ponyNeg += ", penis, cock, erection, phallus";
    let sdxlNeg = "(worst quality, low quality:1.4), ugly, deformed, watermark, text, signature, child, minor, underage, bad anatomy, extra limbs, cgi, airbrushed, plastic skin, blurry, overexposed";
    if (!wantsFemAnatomy && !wantsBoth) sdxlNeg += ", vagina, vulva, female genitalia, labia";
    if (!wantsMascAnatomy && !wantsBoth) sdxlNeg += ", penis, erection, cock, phallus";
    if (!wantsToys) sdxlNeg += ", dildo, sex toy, object in hand";
    const negativePrompt = isPony ? ponyNeg : sdxlNeg;

    const sdxlWorkflow = {
      "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": checkpointModel } },
      "6": { "class_type": "CLIPTextEncode", "inputs": { "text": positivePrompt, "clip": ["4", 1] } },
      "7": { "class_type": "CLIPTextEncode", "inputs": { "text": negativePrompt, "clip": ["4", 1] } },
      "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 832, "height": 1216, "batch_size": 1 } },
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
          "latent_image": ["5", 0], "seed": actualSeed,
          "steps": isPony ? 30 : 30,  // 30 steps pour meilleure qualité
          "cfg": isPony ? 7 : 7,  // CFG 7 = moins anime, plus réaliste
          "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "denoise": 1.0
        }
      },
      "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
      "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "elissia_sdxl" } }
    };

    return await _submitComfyWorkflow(sdxlWorkflow, actualSeed);
  }

  // ══ WORKFLOW Z IMAGE TURBO (Lumina) — fallback si pas de SDXL ═════════
  // ⚠️  CFG=1 + ConditioningZeroOut = négatifs IGNORÉS. Contrôle uniquement par prompt positif.
  // Source: https://docs.comfy.org/tutorials/image/z-image/z-image-turbo
  const workflow = {
    "28": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "z_image_turbo_bf16.safetensors",
        "weight_dtype": "default"
      }
    },
    "30": {
      "class_type": "CLIPLoader",
      "inputs": {
        "clip_name": "qwen_3_4b.safetensors",
        "type": "lumina2",
        "device": "default"
      }
    },
    "29": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "ae.safetensors"
      }
    },
    "27": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "clip": ["30", 0],
        "text": prompt
      }
    },
    "33": {
      "class_type": "ConditioningZeroOut",
      "inputs": {
        "conditioning": ["27", 0]
      }
    },
    "13": {
      "class_type": "EmptySD3LatentImage",
      "inputs": {
        "width": 768,
        "height": 1024,
        "batch_size": 1
      }
    },
    "11": {
      "class_type": "ModelSamplingAuraFlow",
      "inputs": {
        "model": ["28", 0],
        "shift": 3.0
      }
    },
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "model": ["11", 0],
        "positive": ["27", 0],
        "negative": ["33", 0],
        "latent_image": ["13", 0],
        "seed": actualSeed,
        "steps": 12,  // v14: plus de steps pour détail anatomique
        "cfg": 1,
        "sampler_name": "res_multistep",
        "scheduler": "simple",
        "denoise": 1
      }
    },
    "8": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["3", 0],
        "vae": ["29", 0]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "images": ["8", 0],
        "filename_prefix": "elissia"
      }
    }
  };

  // Vérifier que le VAE ae.safetensors est disponible
  try {
    const vaeR = await fetch(`${COMFY_URL}/object_info/VAELoader`);
    if (vaeR.ok) {
      const vaeInfo = await vaeR.json();
      const vaes = vaeInfo?.VAELoader?.input?.required?.vae_name?.[0] || [];
      if (!vaes.includes("ae.safetensors")) {
        console.warn(`[ComfyUI] VAE ae.safetensors non trouvé. VAEs disponibles: ${vaes.join(", ")}`);
        // Utiliser le premier VAE dispo si ae.safetensors manque
        if (vaes.length > 0) {
          workflow["29"].inputs.vae_name = vaes[0];
          console.log(`[ComfyUI] Utilisation du VAE: ${vaes[0]}`);
        }
      }
    }
  } catch(e) { /* silencieux */ }

  // Vérifier que le CLIP qwen_3_4b est disponible
  try {
    const clipR = await fetch(`${COMFY_URL}/object_info/CLIPLoader`);
    if (clipR.ok) {
      const clipInfo = await clipR.json();
      const clips = clipInfo?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
      const normalize = s => s.replace(/-/g,'_').toLowerCase();
      const qwenMatch = clips.find(c => normalize(c).includes('qwen'));
      if (qwenMatch) {
        workflow["30"].inputs.clip_name = qwenMatch;
        console.log(`[ComfyUI] CLIP trouvé: ${qwenMatch}`);
      } else {
        console.warn(`[ComfyUI] qwen non trouvé dans: ${clips.join(", ")}`);
      }
    }
  } catch(e) { /* silencieux */ }

  // Vérifier que z_image_turbo est dans diffusion_models
  try {
    const unetR = await fetch(`${COMFY_URL}/object_info/UNETLoader`);
    if (unetR.ok) {
      const unetInfo = await unetR.json();
      const unets = unetInfo?.UNETLoader?.input?.required?.unet_name?.[0] || [];
      const normalize = s => s.replace(/-/g,'_').toLowerCase();
      const zMatch = unets.find(u => normalize(u).includes('z_image_turbo'));
      if (zMatch) {
        // ✅ v14 : préférer un modèle NSFW réaliste si disponible
        const modelToUse = altModelFound || zMatch;
        workflow["28"].inputs.unet_name = modelToUse;
        if (altModelFound) console.log("[ComfyUI] Utilisation modèle NSFW:", modelToUse);
        console.log(`[ComfyUI] UNET trouvé: ${zMatch}`);
      } else {
        console.warn(`[ComfyUI] z_image_turbo non trouvé dans UNETLoader. Disponibles: ${unets.join(", ")}`);
        throw new Error(`z_image_turbo_bf16.safetensors doit être dans diffusion_models/, pas checkpoints/. Déplace-le dans C:\\Users\\laure\\ComfyUI-Shared\\models\\diffusion_models\\`);
      }
    }
  } catch(e) {
    if (e.message.includes('diffusion_models')) throw e;
    /* silencieux pour les autres erreurs */
  }

  // Soumettre le workflow
  return await _submitComfyWorkflow(workflow, actualSeed);
}

// ══ Soumission et polling ComfyUI (partagé entre SDXL et Z Image Turbo) ══
async function _submitComfyWorkflow(workflow, actualSeed) {
  const submitR = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "elissia" })
  });

  if (!submitR.ok) {
    const err = await submitR.text().catch(() => "");
    throw new Error(`ComfyUI erreur ${submitR.status}: ${err.slice(0, 300)}`);
  }

  const submitData = await submitR.json();
  const prompt_id = submitData.prompt_id;
  if (!prompt_id) throw new Error("ComfyUI n'a pas retourné de prompt_id");
  console.log(`[ComfyUI] Job soumis: ${prompt_id}`);

  // Polling toutes les 2s jusqu'à l'image (max 3 min)
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const histR = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    if (!histR.ok) continue;
    const hist = await histR.json();
    const entry = hist[prompt_id];
    if (!entry) continue;

    if (entry.status?.status_str === "error") {
      const msgs = (entry.status?.messages || []).map(m => JSON.stringify(m)).join("; ");
      throw new Error(`ComfyUI erreur exécution: ${msgs.slice(0, 300)}`);
    }

    const outputs = entry.outputs || {};
    for (const nodeOutputs of Object.values(outputs)) {
      for (const img of (nodeOutputs.images || [])) {
        if (!img.filename) continue;
        const imgUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${img.subfolder || ""}&type=${img.type || "output"}`;
        console.log(`[ComfyUI] ✓ Image générée: ${img.filename}`);
        return await downloadToUploads(imgUrl);
      }
    }
  }
  throw new Error("ComfyUI timeout (3 min) — vérifie que ComfyUI Desktop est bien lancé");
}

/* ═══════════════════════════════════════════════════════════════
   ✅ NOUVEAU v9 — AVATAR ANIMÉ GIF via FFmpeg
   Génère N images du MÊME personnage (seed de base + micro-variations)
   puis les assemble en GIF animé avec un effet de boucle douce.
═══════════════════════════════════════════════════════════════ */
const { execFile } = require("child_process");

// Vérifie si ffmpeg est disponible — cherche dans PATH puis chemins Windows courants
function ffmpegAvailable() {
  return new Promise((resolve) => {
    // Stratégie 1 : @ffmpeg-installer (bundle NPM)
    try {
      const installer = require("@ffmpeg-installer/ffmpeg");
      if (installer.path && fs.existsSync(installer.path)) {
        const binDir = path.dirname(installer.path);
        const sep = process.platform === "win32" ? ";" : ":";
        if (!(process.env.PATH || "").includes(binDir))
          process.env.PATH = binDir + sep + (process.env.PATH || "");
        process.env.FFMPEG_PATH = installer.path;
        return resolve(true);
      }
    } catch {}
    // Stratégie 2 : PATH système
    execFile("ffmpeg", ["-version"], (err) => {
      if (!err) return resolve(true);
      // Stratégie 3 : Chemins Windows courants
      if (process.platform === "win32") {
        const candidates = [
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA||"","Microsoft","WinGet","Packages","Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe","ffmpeg-full","bin","ffmpeg.exe"),
          path.join(process.env.USERPROFILE||"","scoop","shims","ffmpeg.exe")
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            process.env.PATH = path.dirname(c) + ";" + (process.env.PATH || "");
            process.env.FFMPEG_PATH = c;
            return resolve(true);
          }
        }
      }
      resolve(false);
    });
  });
}

// ✅ v11 — Assemble des frames PNG en vidéo MP4 (Ken Burns + fondu)
// Remplace l'ancien assembleGif. Génère un fichier .mp4 de qualité avec effet zoom.
function assembleMP4(framePaths, outPath, fps = 24) {
  return new Promise((resolve, reject) => {
    const listFile = outPath + "_list.txt";
    // Durée par frame : on pingpong pour une boucle douce aller-retour
    const ordered = [...framePaths, ...framePaths.slice(1, -1).reverse()];
    // ✅ v13 : durée min 1.5s par frame pour vidéo de 8-10 secondes
    const durPerFrame = Math.max(1.5, (1 / (fps / 6))).toFixed(3);
    const lines = ordered.map(f => `file '${f.replace(/'/g, "'\\''")}'
duration ${durPerFrame}`).join("\n")
      + `\nfile '${ordered[ordered.length-1].replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(listFile, lines);

    const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";

    // Ken Burns : zoom lent de 1.0 → 1.08 + encode H264 compatible navigateur
    execFile(ffmpegBin, [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", [
        "scale=512:768:force_original_aspect_ratio=decrease",
        "pad=512:768:(ow-iw)/2:(oh-ih)/2",
        `fps=${fps}`,
        "zoompan=z='min(zoom+0.0008,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=512x768"
      ].join(","),
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      outPath
    ], (err) => {
      try { fs.existsSync(listFile) && fs.unlinkSync(listFile); } catch {}
      if (err) return reject(new Error("ffmpeg mp4: " + err.message));
      resolve(outPath);
    });
  });
}

// ✅ v11 — Génère un avatar animé MP4 (Ken Burns) à partir du profil
async function generateAnimatedAvatarGif(ext, userId, frames = 6) {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error("FFmpeg introuvable — lance : npm install @ffmpeg-installer/ffmpeg fluent-ffmpeg et redémarre");
  }

  const nFrames = Math.max(3, Math.min(parseInt(frames) || 6, 8));
  const baseSeed = getAvatarSeed(ext);
  const basePrompt = personality.buildAvatarPromptFromProfile(ext);

  const expressions = [
    "neutral soft expression, looking at camera",
    "subtle warm smile, looking at camera",
    "warm genuine smile, slight head tilt",
    "soft sensual gaze, lips slightly parted",
    "playful expression, looking at camera",
    "tender romantic look, slight smile",
    "confident direct gaze, chin up",
    "calm serene expression, eyes half closed"
  ];

  const localFrames = [];
  for (let i = 0; i < nFrames; i++) {
    const seed = baseSeed + i;
    const prompt = basePrompt + ", " + expressions[i % expressions.length] + ", consistent same face, same person";
    console.log(`[VideoAvatar] Frame ${i + 1}/${nFrames} (seed ${seed})`);
    const url = await comfyGenerateImage(prompt, "portrait", seed);
    const abs = url.startsWith("/uploads/")
      ? path.join(UPLOADS_DIR, url.replace("/uploads/", ""))
      : url;
    if (fs.existsSync(abs)) localFrames.push(abs);
  }

  if (localFrames.length < 2) {
    throw new Error("Pas assez de frames générées (ComfyUI a échoué sur certaines)");
  }

  // ✅ Générer MP4 au lieu de GIF
  const vidName = "avatar_anim_" + userId + "_" + Date.now() + ".mp4";
  const vidPath = path.join(UPLOADS_DIR, vidName);
  await assembleMP4(localFrames, vidPath, 24);

  return "/uploads/" + vidName;
}

// ✅ v12 — Génération vidéo depuis chat context via FFmpeg + ComfyUI
async function generateVideoFromChat(userId, ext, explicit = false, chatMessages = []) {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) throw new Error("FFmpeg non disponible. Lance: npm install @ffmpeg-installer/ffmpeg");

  // ✅ v13 — Construire la scène depuis la RÉPONSE IA (ce qu'elle décrit faire)
  // On lit le dernier message ASSISTANT pour extraire l'action décrite
  let sceneContext = "";
  const lastAiMsg = chatMessages.filter(m => m.role === "assistant").pop()?.content || "";
  const lastUserMsg = chatMessages.filter(m => m.role === "user").pop()?.content || "";
  const allContext = (lastAiMsg + " " + lastUserMsg).toLowerCase();

  if (/masturb|branle|ma (main|queue|bite|membre).*ma main|glisse.*ma queue/i.test(lastAiMsg)) {
    sceneContext = ", masturbating hand on cock, erotic self-touching, hand gripping penis, sensual solo act";
  } else if (/quatre pattes|à genoux|doggy|derrière toi|courb/i.test(allContext)) {
    sceneContext = ", on all fours doggy style pose, bent over presenting curves, sensual pose";
  } else if (/suce|fellation|bouche|lèche|avale/i.test(lastAiMsg)) {
    sceneContext = ", sensual mouth open, licking lips, provocative oral suggestion, tongue out";
  } else if (/déshabill|enlève|retire|dénude|nue/i.test(allContext)) {
    sceneContext = ", undressing slowly removing clothes, stripping, seductive revealing pose";
  } else if (/domin|fouet|fesse.*marqu|punish|coups/i.test(allContext)) {
    sceneContext = ", dominant powerful commanding pose, intense direct gaze, authority";
  } else if (/approch|vien(s)?|rejoin/i.test(allContext)) {
    sceneContext = ", walking towards camera sensually, reaching forward, seductive approach";
  } else if (/câlin|tendresse|amour|embrass/i.test(allContext)) {
    sceneContext = ", tender loving expression, arms open, romantic soft pose";
  } else {
    sceneContext = ", sensual confident pose, direct camera gaze, showing body";
  }
  console.log("[VideoChat] Scène détectée:", sceneContext.trim());

  const basePrompt = buildComfyPromptFinal(ext, explicit ? "nue" : "sensuelle");
  const frames = [];
  const seed = getAvatarSeed(ext);
  // ✅ v13 — Poses progressives qui correspondent à l'action détectée
  // Chaque frame montre une progression de l'action
  const getExpressions = (scene) => {
    if (scene.includes("masturbat") || scene.includes("hand on cock") || scene.includes("gripping penis")) {
      return [
        "standing looking at camera with a seductive smile, hands at sides",
        "reaching hand down towards groin, sensual expression",
        "hand near groin area, aroused expression, biting lip",
        "sensual expression face flushed with arousal",
        "satisfied expression post-arousal, catching breath"
      ];
    }
    if (scene.includes("all fours") || scene.includes("doggy") || scene.includes("bent over")) {
      return [
        "standing, turning to show her from behind",
        "bending forward slightly, hands on knees",
        "bent over showing curves, looking back over shoulder",
        "doggy position showing large ass and back",
        "arched back, looking back seductively"
      ];
    }
    if (scene.includes("undress") || scene.includes("stripping")) {
      return [
        "fully clothed or minimal clothing, seductive look",
        "removing top, showing shoulders",
        "topless, showing large breasts, arms up",
        "pushing clothing down hips",
        "fully nude standing, confident display"
      ];
    }
    return [
      "standing confident sensual pose",
      "slight turn showing curves",
      "hands on hips direct gaze",
      "leaning forward slightly",
      "seductive expression direct look"
    ];
  };
  const microExpressions = getExpressions(sceneContext);

  for (let i = 0; i < 5; i++) {
    const framePrompt = basePrompt + ", " + microExpressions[i] + ", consistent same face and body, " + sceneContext.replace(/^,\s*/, "");
    const url = await comfyGenerateImage(framePrompt, explicit ? "nue" : "sensuelle", seed + i);
    const abs = url.startsWith("/uploads/") ? path.join(UPLOADS_DIR, url.replace("/uploads/", "")) : url;
    if (fs.existsSync(abs)) { frames.push(abs); console.log(`[VideoChat] Frame ${i+1}/5`); }
  }

  if (frames.length < 2) throw new Error("Pas assez de frames ComfyUI générées pour la vidéo");

  const vidName = "chat_vid_" + userId + "_" + Date.now() + ".mp4";
  const vidPath = path.join(UPLOADS_DIR, vidName);
  await assembleMP4(frames, vidPath, 24);
  return "/uploads/" + vidName;
}

// Alias pour compatibilité existante
async function civitaiGenerateVideo(prompt, explicit = false) {
  // Ce chemin est utilisé par la route /api/generate/video (selfie vidéo)
  // Génère une vidéo courte à partir d'un prompt direct
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) throw new Error("FFmpeg requis. Lance: npm install @ffmpeg-installer/ffmpeg");

  const frames = [];
  const seed = Math.floor(Math.random() * 2**32);
  const style = explicit ? "nue" : "sensuelle";
  const extras = ["looking at camera", "slight smile", "sensual gaze", "playful expression", "natural pose"];

  for (let i = 0; i < 4; i++) {
    const fp = prompt + ", " + extras[i] + ", consistent face, same person";
    const url = await comfyGenerateImage(fp, style, seed + i);
    const abs = url.startsWith("/uploads/") ? path.join(UPLOADS_DIR, url.replace("/uploads/", "")) : url;
    if (fs.existsSync(abs)) frames.push(abs);
  }

  if (frames.length < 2) throw new Error("Génération de frames échouée");
  const fname = "ai_vid_" + Date.now() + ".mp4";
  const fpath = path.join(UPLOADS_DIR, fname);
  await assembleMP4(frames, fpath, 24);
  return "/uploads/" + fname;
}

/* ═══════════════════════════════════════
   ROUTES API
═══════════════════════════════════════ */

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: APP_NAME, version: "9.0", mode: MODE,
    ollamaModel: OLLAMA_MODEL, comfy: COMFY_URL, piper: !!process.env.PIPER_BIN });
});

// ══ AUTH ══════════════════════════════════════════════════════
app.post("/api/auth/register", rateLimit("register", 5, 3600000), async (req, res) => {
  try {
    if (!ALLOW_REGISTRATION) return res.status(403).json({ ok:false, error:"Inscription désactivée." });
    if (INVITE_CODE && clean(req.body.inviteCode,200) !== INVITE_CODE) return res.status(403).json({ ok:false, error:"Code invitation invalide." });
    const email = clean(req.body.email,200).toLowerCase();
    const password = String(req.body.password||"");
    const displayName = clean(req.body.displayName||"Mon amour",80);
    const consent = Boolean(req.body.rgpdConsent);
    if (!email.includes("@")) return res.status(400).json({ ok:false, error:"Email invalide." });
    if (password.length < 10) return res.status(400).json({ ok:false, error:"Mot de passe: minimum 10 caractères." });
    if (!consent) return res.status(400).json({ ok:false, error:"Consentement requis." });
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({ ok:false, error:"Compte déjà existant." });
    const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    const userId = id();
    const hash = await bcrypt.hash(password, 12);
    db.prepare(`INSERT INTO users(id,email,password_hash,display_name_enc,ai_name_enc,relationship_style_enc,preferred_persona,rgpd_consent,privacy_accepted_at,is_admin,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'girlfriend',1,?,?,?,?)`).run(userId,email,hash,encryptText(displayName),encryptText("Élissia"),encryptText("romantique"),now(),count===0?1:0,now(),now());
    const csrf = createSession(userId, req, res);
    audit(userId,"user_registered",{emailHash:sha256(email)},req);
    res.json({ ok:true, csrf, user:publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(userId)) });
  } catch(e) { console.error(e); res.status(500).json({ ok:false, error:"Erreur inscription." }); }
});

app.post("/api/auth/login", rateLimit("login",10,900000), async (req,res) => {
  const email = clean(req.body.email,200).toLowerCase();
  const password = String(req.body.password||"");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    audit(user?user.id:null,"login_failed",{emailHash:sha256(email)},req);
    return res.status(401).json({ ok:false, error:"Identifiants invalides." });
  }
  const csrf = createSession(user.id, req, res);
  audit(user.id,"login_success",{},req);
  res.json({ ok:true, csrf, user:publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req,res) => {
  const newCsrf = crypto.randomBytes(32).toString("hex");
  try { db.prepare("UPDATE sessions SET csrf_hash=? WHERE id=?").run(sha256(newCsrf), req.session.id); } catch(e) { console.error("[csrf]",e.message); }
  res.json({ ok:true, csrf:newCsrf, user:publicUser(req.user) });
});

app.post("/api/auth/logout", requireAuth, requireCsrf, (req,res) => {
  db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), req.session.id);
  res.clearCookie("sid",{path:"/"});
  res.json({ ok:true });
});

// ══ PROFIL PRINCIPAL ══════════════════════════════════════════
app.put("/api/profile", requireAuth, requireCsrf, (req,res) => {
  const displayName = clean(req.body.displayName||"Mon amour",80);
  const aiName      = clean(req.body.aiName||"Élissia",80);
  const style       = clean(req.body.relationshipStyle||"romantique",120);
  const persona     = clean(req.body.preferredPersona||"girlfriend",50);
  const age         = Boolean(req.body.ageConfirmed);
  const adult       = Boolean(req.body.adultMode) && age;
  const consent     = Boolean(req.body.rgpdConsent);
  const webSearch   = Boolean(req.body.webSearchEnabled);
  const autoPhoto   = Boolean(req.body.autoPhoto);
  if (!consent) return res.status(400).json({ ok:false, error:"Consentement requis." });
  db.prepare(`UPDATE users SET display_name_enc=?,ai_name_enc=?,relationship_style_enc=?,preferred_persona=?,age_confirmed=?,adult_mode=?,web_search_enabled=?,rgpd_consent=1,privacy_accepted_at=COALESCE(privacy_accepted_at,?),updated_at=? WHERE id=?`)
    .run(encryptText(displayName),encryptText(aiName),encryptText(style),persona,age?1:0,adult?1:0,webSearch?1:0,now(),now(),req.user.id);
  // Reprogrammer le workflow proactif
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const ext = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};
  if (autoPhoto) ext.auto_photo = true;
  scheduleProactiveMessages(req.user.id, ext, aiName);
  audit(req.user.id,"profile_updated",{persona,adult},req);
  res.json({ ok:true, user:publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});

// ══ PROFIL ÉTENDU — CORRECTIF v8 COMPLET ═════════════════════
const EXTENDED_ALLOWED_FIELDS = [
  // Identité
  "genre","age","origine","langue","histoire","user_genre",
  // Silhouette globale
  "corpulence","tonicite","taille","poids","texture_cheveux",
  // Visage & cheveux
  "cheveux","longueur_cheveux","yeux","couleur_peau","taille_levres","maquillage",
  // Corps féminin
  "taille_seins","forme_seins","teton",
  "forme_fesses","forme_fesses_shape","hanches","ventre","jambes",
  // Anatomie intime féminine
  "pilosite","style_pilosite","couleur_pilosite","levres_intimes","clitoris","morpho_intime",
  // Corps masculin
  "pectoraux","abdominaux","taille_sexe_m","epaisseur_sexe_m","forme_sexe_m",
  "circoncis","testicules","pilosite_masc",
  // Trans / Hybride
  "anatomie_libre","statut_chirurgical",
  // Accessoires & bijoux
  "tatouages","piercings","style","tenue_preferee",
  "lunettes","bijoux","collier_bijou","boucles_oreilles","bague","bracelet","montre",
  "chaussures","sac","chapeau","casquette","bonnet",
  "ambiance_photo","decor_prefere","accent_voix","parfum",
  // Caractère
  "caractere","passions","profession","hobbies","reves","communication","valeurs",
  "humour","jalousie","independance","gestion_conflits","traits_perso",
  // Sexualité
  "kinks","fantasmes","limites","preferences_chat",
  "orientations","pratiques","rythme","tendresse",
  "niveau_intensite","initiative_sexuelle",
  "curseur_douceur","curseur_crudite","curseur_domination",
  "curseur_humiliation","curseur_romantisme","curseur_initiative",
  // Relation & Prefs
  "relation","proactivite","auto_photo","scenario_format",
  "envies_pratiques","mes_jouets","voix",
  // Mémoire & Avatar
  "avatar_description","avatar_seed","avatar_url_ref","avatar_animated_url"
];

app.put("/api/profile/extended", requireAuth, requireCsrf, (req,res) => {
  // Lire le profil existant et MERGER (ne pas écraser)
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const existing = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};

  const data = { ...existing };
  for (const k of EXTENDED_ALLOWED_FIELDS) {
    if (req.body[k] !== undefined) data[k] = String(req.body[k]).slice(0, 2000);
  }

  db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
    .run(encryptText(JSON.stringify(data)), now(), req.user.id);

  // Reprogrammer le workflow proactif si la proactivité a changé
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const aiName = decryptText(user.ai_name_enc) || "Élissia";
  scheduleProactiveMessages(req.user.id, data, aiName);

  res.json({ ok:true, extendedProfile: data });
});

app.get("/api/profile/extended", requireAuth, (req,res) => {
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const profile = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};
  res.json({ ok:true, extendedProfile: profile });
});

// ══ AVATAR ════════════════════════════════════════════════════

// ✅ Upload portrait depuis l'appareil (fix MulterError "avatar" field)
const uploadAvatarMw = multer({ storage, limits:{fileSize:20*1024*1024},
  fileFilter:(req,file,cb) => cb(null,["image/jpeg","image/png","image/webp","image/gif"].includes(file.mimetype))
}).single("avatar");

app.post("/api/avatar/upload", requireAuth, requireCsrf, (req,res) => {
  uploadAvatarMw(req, res, async (err) => {
    if (err) return res.status(400).json({ok:false,error:err.message});
    if (!req.file) return res.status(400).json({ok:false,error:"Aucun fichier."});
    const localUrl = `/uploads/${req.file.filename}`;
    let desc = null;
    try {
      const uu = publicUser(req.user);
      desc = await analyzeImage(path.join(UPLOADS_DIR,req.file.filename),(uu.extendedProfile||{}).user_genre||"",!!(req.user.adult_mode));
      if (desc && desc!=="__VISION_INDISPONIBLE__") {
        const ex2 = uu.extendedProfile||{};
        db.prepare("UPDATE users SET extended_profile_enc=?,updated_at=? WHERE id=?")
          .run(encryptText(JSON.stringify({...ex2,avatar_description:desc})),now(),req.user.id);
      }
    } catch(e){console.warn("[avatar/upload]",e.message);}
    db.prepare("UPDATE users SET avatar_enc=?,updated_at=? WHERE id=?").run(encryptText(localUrl),now(),req.user.id);
    try{db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(),req.user.id,localUrl,req.file.originalname,req.file.mimetype,"user_upload",desc||null,now());}catch{}
    res.json({ok:true,url:localUrl,avatarUrl:localUrl});
  });
});

app.post("/api/avatar", requireAuth, requireCsrf, async (req,res) => {
  const avatar = req.body.avatar;
  if (!avatar) return res.status(400).json({ ok:false, error:"Avatar manquant." });

  // ✅ v11 — Analyser la photo uploadée avec llava pour que l'IA la connaisse
  let avatarDescription = null;
  try {
    const u = publicUser(req.user);
    const ext = u.extendedProfile || {};
    avatarDescription = await analyzeImage(avatar, ext.user_genre || "", !!(req.user.adult_mode));
    if (avatarDescription && avatarDescription !== "__VISION_INDISPONIBLE__") {
      // Stocker la description dans le profil pour que l'IA s'en souvienne
      const updExt = { ...ext, avatar_description: avatarDescription };
      db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
        .run(encryptText(JSON.stringify(updExt)), now(), req.user.id);
      console.log("[Avatar Upload] Description llava:", avatarDescription.slice(0,80));
    }
  } catch(e) { console.warn("[Avatar Upload Vision]", e.message); }

  db.prepare("UPDATE users SET avatar_enc=?, updated_at=? WHERE id=?").run(encryptText(avatar), now(), req.user.id);
  res.json({ ok:true, avatarUrl: avatar, description: avatarDescription });
});
app.delete("/api/avatar", requireAuth, requireCsrf, (req,res) => {
  db.prepare("UPDATE users SET avatar_enc=NULL, updated_at=? WHERE id=?").run(now(), req.user.id);
  res.json({ ok:true });
});

// ══ ÉTAT GLOBAL ═══════════════════════════════════════════════
app.get("/api/state", requireAuth, (req,res) => {
  const cid = req.query.companionId || null;
  const messages = cid
    ? db.prepare("SELECT id,role,content_enc,persona,media_url,media_type,created_at FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')='solo' ORDER BY created_at ASC LIMIT 300").all(req.user.id, cid)
        .map(m => ({ id:m.id, role:m.role, content:decryptText(m.content_enc), persona:m.persona, mediaUrl:m.media_url, mediaType:m.media_type, createdAt:m.created_at }))
    : db.prepare("SELECT id,role,content_enc,persona,media_url,media_type,created_at FROM messages WHERE user_id=? AND companion_id IS NULL AND COALESCE(thread,'solo')='solo' ORDER BY created_at ASC LIMIT 300").all(req.user.id)
        .map(m => ({ id:m.id, role:m.role, content:decryptText(m.content_enc), persona:m.persona, mediaUrl:m.media_url, mediaType:m.media_type, createdAt:m.created_at }));
  const memories = db.prepare("SELECT id,text_enc,kind,importance,created_at,updated_at FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user.id)
    .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at, updatedAt:m.updated_at }));
  res.json({ ok:true, user:publicUser(req.user), messages, memories });
});

// ══ CHAT STREAMING ════════════════════════════════════════════
app.post("/api/chat/stream", requireAuth, requireCsrf, rateLimit("chat",60,3600000), async (req,res) => {
  try {
    const message = clean(req.body.message, 4000);
    const mediaUrl = req.body.mediaUrl || null;
    let   realAnalysis = req.body.mediaAnalysis || null;
    // ✅ MULTI-COMPAGNONS : charger le profil du compagnon si fourni
    const companionId = req.body.companionId ? clean(req.body.companionId, 80) : null;
    let companionRow = null;
    if (companionId) companionRow = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
    const persona = clean((companionRow ? companionRow.persona : null) || req.body.persona || req.user.preferred_persona, 50);

    if (!message && !mediaUrl) return res.status(400).json({ ok:false, error:"Message vide." });
    if (!req.user.rgpd_consent) return res.status(403).json({ ok:false, error:"Consentement requis." });

    const mod = moderation(message);
    if (!mod.allowed) {
      audit(req.user.id,"moderation_block",{category:mod.category},req);
      return res.status(400).json({ ok:false, error:"Contenu illégal refusé (mineurs, zoophilie, non-consentement réel)." });
    }

    // Plugin beforeChat
    const pluginBefore = await pluginEngine.runHook("beforeChat", { userId:req.user.id, user:publicUser(req.user), message, persona });
    if (pluginBefore?.block) return res.status(400).json({ ok:false, error:pluginBefore.userMessage||"Bloqué." });

    // Vision si image
    const u = publicUser(req.user);
    const ext = u.extendedProfile || {};
    let visionRefus = false;
    if (mediaUrl && !realAnalysis && (req.body.mediaType||"").startsWith("image")) {
      realAnalysis = await analyzeImage(mediaUrl, ext.user_genre || "", !!(freshUser.adult_mode));
    }
    if (realAnalysis === "__VISION_INDISPONIBLE__") {
      visionRefus = true; realAnalysis = null;
      // Indiquer à l'IA qu'une photo a été envoyée mais non analysable
      console.warn("[Vision] Indisponible pour ce media");
    }
    // Si photo envoyée sans analyse → demander à l'IA de reconnaître qu'elle ne peut pas la voir
    if (mediaUrl && !realAnalysis && (req.body.mediaType||"").startsWith("image")) {
      realAnalysis = "__VISION_INDISPONIBLE__";
      visionRefus = true;
    }

    let userContent = message || "";
    if (mediaUrl && realAnalysis) {
      userContent = `[ANALYSE IMAGE RÉELLE : ${realAnalysis}]\n${message ? message : ""}`;
    } else if (mediaUrl && visionRefus) {
      userContent = `[WEBCAM/PHOTO REÇUE MAIS JE NE VOIS RIEN. RÈGLE ABSOLUE : ne jamais prétendre voir, ne jamais décrire un corps sans l'avoir vu. Demander : "décris-moi exactement ce que tu fais"]\n${message||""}`;
    } else if (mediaUrl) {
      userContent = `[IMAGE NON LISIBLE. Ne pas inventer ce qu'on ne voit pas.]\n${message||""}`;
    }

    // Sauvegarder message user — robuste aux ancienne DB
    try {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,media_url,media_type,companion_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "user", encryptText(userContent), persona, mediaUrl, req.body.mediaType||null, companionId||null, now());
    } catch(_e) {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "user", encryptText(userContent), persona, companionId||null, now());
    }

    // Apprentissage v12 — sauvegarde automatique enrichie
    if (message && !message.startsWith("[PROACTIF]") && !message.startsWith("[WEBCAM]")) {
      try {
        apprendreFaits(req.user.id, message);
        // ✅ v12 : sauvegarder TOUS les messages avec importance calculée automatiquement
        saveMemoryAuto(req.user.id, message, "user").catch(()=>{});
        // Consolidation périodique en arrière-plan (toutes les 20 conv)
        consolidateMemoriesIfNeeded(req.user.id).catch(()=>{});
        // Apprendre les accessoires et jouets mentionnés
        const accs = extraireAccessoires(message);
        if (accs.length) {
          const freshExt = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)).extendedProfile || {};
          let jouets = freshExt.mes_jouets || "";
          for (const a of accs) {
            if (!jouets.includes(a.fr)) {
              jouets = (jouets + " " + a.fr).trim();
              saveFact(req.user.id, "accessoire", a.fr);
            }
          }
          if (jouets !== (freshExt.mes_jouets||"")) {
            freshExt.mes_jouets = jouets;
            db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
              .run(encryptText(JSON.stringify(freshExt)), now(), req.user.id);
            console.log("[Learn] Accessoires appris:", accs.map(a=>a.fr).join(", "));
          }
        }
      } catch(e) { console.error("[learn]",e.message); }
    }

    // Mémoires pertinentes
    const memories = await searchMemories(req.user.id, message||"media", companionId);
    const memContext = memories.length ? "Souvenirs pertinents:\n" + memories.map(m=>"- "+m.text).join("\n") : "";
    const profileContext = `Profil:\n- Nom: ${u.displayName}\n- IA: ${u.aiName}\n- Style: ${u.relationshipStyle}\n- Mode adulte: ${u.adultMode?"activé":"désactivé"}`;
    const pluginSys = pluginBefore?.systemPrompt ? String(pluginBefore.systemPrompt).slice(0,2000) : "";

    // Détection guidage/scénario
    const chatOptions = {};
    if ((message||"").includes("[WEBCAM]") && mediaUrl) {
      chatOptions.guidageMode = "webcam";
      chatOptions.descriptionImage = realAnalysis;
      chatOptions.visionRefus = visionRefus;
    } else if (mediaUrl && (req.body.mediaType||"").startsWith("image")) {
      chatOptions.guidageMode = "photo";
      chatOptions.descriptionImage = realAnalysis;
      chatOptions.visionRefus = visionRefus;
    }
    if (req.body.scenarioFormat) { chatOptions.scenarioFormat = req.body.scenarioFormat; chatOptions.scenarioSeed = req.body.scenarioSeed||null; }

    // CORRECTIF v8 : relire le user FRAIS depuis la DB
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    // ✅ MULTI-COMPAGNONS : utiliser le profil du compagnon — le profil global n'est JAMAIS écrasé
    let userForPrompt = freshUser;
    if (companionRow) {
      const compProfile = parseJson(decryptText(companionRow.profile_enc), {});
      // ✅ v18.1 — En chat de compagnon, le profil DU COMPAGNON est la source de vérité.
      //   Le front envoyait l'ext du formulaire principal (Gaëlle), qui écrasait le profil
      //   du compagnon → Élissia "parlait comme Gaëlle". On n'utilise plus req.body.ext ici.
      const mergedExt = compProfile;
      userForPrompt = { ...freshUser, ai_name_enc: companionRow.name_enc,
        preferred_persona: companionRow.persona, extended_profile_enc: encryptText(JSON.stringify(mergedExt)) };
    } else if (req.body.ext) {
      const baseExt = publicUser(freshUser).extendedProfile || {};
      userForPrompt = { ...freshUser, extended_profile_enc: encryptText(JSON.stringify({...baseExt, ...req.body.ext})) };
    }
    const sysPrompt = buildSystemPrompt(userForPrompt, persona, message, chatOptions);

    const llmMessages = [
      { role:"system", content: sysPrompt },
      ...(pluginSys ? [{ role:"system", content:"Plugin:\n"+pluginSys }] : []),
      { role:"system", content: profileContext + (memContext ? "\n\n" + memContext : "") },
      ...recentMessages(req.user.id, companionId || undefined),
      { role:"user", content: userContent }
    ];

    res.writeHead(200, { "Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no" });
    res.write(JSON.stringify({ type:"start" }) + "\n");

    let full = await ollamaStream(llmMessages, token => {
      res.write(JSON.stringify({ type:"token", token }) + "\n");
    });

    // Modération réponse (uniquement si pas mode adulte)
    if (!freshUser.adult_mode) {
      const modReply = moderation(full);
      if (!modReply.allowed) full = "Active le mode adulte dans les paramètres.";
    }

    // ── Web search Perplexity si demande d'info d'actualité ──────────
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    const webSearchEnabled = Boolean(freshUser.web_search_enabled || freshUser.webSearchEnabled);
    const isWebQuery = /actu|news|aujourd|dernier|recent|2024|2025|2026|trump|bourse|crypto|guerre|election|sport|foot|meteo|resultat|score|sortie|nouveau|comment|pourquoi|quelle|definition|information|annonce|bitcoin|crypto|ia\b|prix\b/i.test(message || "")

    if (PERPLEXITY_KEY && webSearchEnabled && isWebQuery && message) {
      try {
        const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PERPLEXITY_KEY}` },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: "Réponds en une phrase très courte avec l'info demandée. Français uniquement." },
              { role: "user", content: message }
            ],
            max_tokens: 150, temperature: 0.3, search_recency_filter: "week"
          })
        });
        if (pxR.ok) {
          const pxData = await pxR.json();
          const pxResult = pxData.choices?.[0]?.message?.content || "";
          if (pxResult) {
            // Injecter le résultat web dans le contexte
            console.log(`[Web search] "${message.slice(0,40)}" → ${pxResult.slice(0,80)}`);
            // Ajouter une note dans la réponse si non déjà présent
            if (!full.includes(pxResult.slice(0,20))) {
              full = full + `

[🌐 Info web: ${pxResult}]`;
            }
          }
        }
      } catch(e) { console.warn("[websearch]", e.message); }
    }

    // Plugin afterChat
    const pluginAfter = await pluginEngine.runHook("afterChat", { userId:req.user.id, user:u, message, persona, reply:full });
    if (pluginAfter?.reply) full = String(pluginAfter.reply).slice(0,12000);

    // Traiter les tags médias dans la réponse ([PHOTO], [VIDEO])
    let mediaGenerated = null;
    // ── Forcer la génération si le MESSAGE UTILISATEUR demande une photo ──
    // Le LLM ignore souvent l'instruction → on force côté serveur
    const userWantsPhoto = /(photo|selfie|image|pic|montre|envoie|envoi).{0,30}(toi|vous|moi|la|une)|\[PHOTO\]|\[SELFIE/i.test(message || "");
    const llmRefuses     = /je (ne peux|suis une IA|n'ai pas de corps|ne peux pas envoyer)/i.test(full);
    
    if (userWantsPhoto && (llmRefuses || !full.includes("[PHOTO]"))) {
      // Remplacer le refus par une vraie génération
      if (llmRefuses) {
        full = full.replace(/[Mm]alheureusement.*?corps[^.]*\./gs, "")
                   .replace(/[Cc]omme je l.ai.*?corps[^.]*\./gs, "")
                   .replace(/je suis une IA[^.]*\./gi, "")
                   .replace(/je n.ai pas de corps[^.]*\./gi, "")
                   .trim();
        if (!full) full = "Voilà mon soumis...";
      }
      if (!full.includes("[PHOTO]") && !full.includes("[SELFIE")) {
        full += " [PHOTO]";
      }
    }
    
    // Détecter les promesses implicites — SEULEMENT si le user a demandé quelque chose de visuel
    const photoPromise = userWantsPhoto && /je (vais|peux|veux|pourrais) (t['']?envoyer|te montrer|partager).{0,60}(photo|selfie|image|selfie)/i.test(full);
    if (photoPromise && !full.includes("[PHOTO]") && !full.includes("[SELFIE")) {
      full += " [PHOTO]";
    }

    if (/\[PHOTO\]|\[SELFIE|\[IMG_GEN:/.test(full)) {
      try {
        // ✅ v13 FIX CRITIQUE : prendre le profil du compagnon actif, pas le profil user
        let ext2 = u.extendedProfile || {};
        if (companionRow) {
          ext2 = parseJson(decryptText(companionRow.profile_enc), {});
        }
        // Détecter le style dans le tag [SELFIE:style] ou [IMG_GEN:style]
        let photoStyle = "sensuelle";
        const styleMatch = full.match(/\[SELFIE:([^\]]+)\]/i) || full.match(/\[IMG_GEN:([^\]]+)\]/i);
        if (styleMatch) {
          const s = styleMatch[1].toLowerCase();
          if (s.includes("domin")) photoStyle = "dominatrice";
          else if (s.includes("nu") || s.includes("expli")) photoStyle = "nue";
          else if (s.includes("entier")) photoStyle = "entiere";
          else if (s.includes("cuir")) photoStyle = "tenue_cuir";
          else photoStyle = s;
        } else if (freshUser.adult_mode && /\bnu(e)?\b|déshabill|explic/i.test(full)) {
          photoStyle = "nue";
        }
        // Enrichissement Perplexity si description complexe
        let extraContext = "";
        const PKEY = process.env.PERPLEXITY_API_KEY;
        const msgForPhoto = message || "";
        if (PKEY && msgForPhoto.length > 50) {
          try {
            const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PKEY}` },
              body: JSON.stringify({
                model: "sonar",
                messages: [
                  { role: "system", content: "You are an expert AI image prompt writer. Convert the user's scene description into a precise photography prompt in English. Be explicit and descriptive about lighting, pose, atmosphere. Max 2 sentences." },
                  { role: "user", content: `Scene: ${msgForPhoto.slice(0, 200)}. Style: ${photoStyle}` }
                ],
                max_tokens: 150, temperature: 0.7
              })
            });
            if (pxR.ok) {
              const pxD = await pxR.json();
              extraContext = pxD.choices?.[0]?.message?.content || "";
            }
          } catch(e) { /* silencieux */ }
        }

        const photoPrompt = buildComfyPromptFinal(ext2, photoStyle) + (extraContext ? ", " + extraContext : "") +
          ((!extraContext && (photoStyle === "nue" || photoStyle === "sensuelle"))
            ? ", on bed with white satin sheets, intimate bedroom setting, soft warm candlelight" : "");
        const imgUrl = await comfyGenerateImage(photoPrompt, photoStyle, null);
        // ✅ v13 : nettoyage complet des tags techniques dans le texte affiché
        const textBeforePhoto = full.replace(/\[PHOTO(\:[^\]]*)?\]|\[SELFIE(\:[^\]]*)?\]|\[IMG_GEN(\:[^\]]*)?\]|\[VID_GEN(\:[^\]]*)?\]|\[VIDEO(\:[^\]]*)?\]|\[WEBCAM(\:[^\]]*)?\]/gi, "").replace(/,\s*$/, "").trim();
        // ✅ v12 — Elle PARLE avant d'envoyer la photo. Si le texte est vide, phrase par défaut.
        if (!textBeforePhoto || textBeforePhoto.length < 5) {
          const defaultPhrases = [
            "Voilà, je t'envoie ça avec amour 💕",
            "Tiens, un petit aperçu pour toi... 😘",
            "Je pensais à toi, alors j'ai pris ça 📸",
            "Regarde-moi... 🔥"
          ];
          full = defaultPhrases[Math.floor(Math.random() * defaultPhrases.length)];
        } else {
          full = textBeforePhoto;
        }
        mediaGenerated = { type: "image", url: imgUrl };
        console.log("[Chat→Photo] style:", photoStyle);
      } catch(e) { console.error("[PHOTO GEN]", e.message); }
    }

    if (/\[VIDEO\]|\[VID_GEN:/.test(full)) {
      try {
        // ✅ v18 — même correctif que la photo : profil de la compagne active, pas le profil principal
        let ext2 = u.extendedProfile || {};
        if (companionRow) ext2 = parseJson(decryptText(companionRow.profile_enc), {});
        const isExplicit = freshUser.adult_mode;
        const videoPrompt = personality.buildSelfiePrompt(ext2, isExplicit ? "explicit" : "sensuelle");
        const vidUrl = await civitaiGenerateVideo(videoPrompt, isExplicit);
        full = full.replace(/\[VIDEO\]|\[VID_GEN:[^\]]*\]/g, "");
        mediaGenerated = { type: "video", url: vidUrl };
      } catch(e) { console.error("[VIDEO GEN]", e.message); }
    }

    // Sauvegarder réponse — robuste aux ancienne DB
    try {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,media_url,companion_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "assistant", encryptText(full), persona, mediaGenerated?.url||null, companionId||null, now());
    } catch(_e2) {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "assistant", encryptText(full), persona, companionId||null, now());
    }

    // ✅ v12 : sauvegarder aussi la réponse IA (ce qu'elle dit est important pour le contexte)
    const memorySaved = await saveMemoryAuto(req.user.id, message||"", "user");
    if (full && full.length > 50) saveMemoryAuto(req.user.id, full.slice(0, 400), "assistant", 1).catch(()=>{});
    audit(req.user.id,"chat_completed",{persona,memorySaved},req);

    res.write(JSON.stringify({ type:"done", reply:full, memorySaved, media:mediaGenerated }) + "\n");
    res.end();
  } catch(e) {
    console.error(e);
    if (!res.headersSent) return res.status(500).json({ ok:false, error:"Erreur serveur." });
    res.write(JSON.stringify({ type:"error", error:"Erreur serveur: " + e.message }) + "\n");
    res.end();
  }
});

// ══ GÉNÉRATION IMAGE ══════════════════════════════════════════
app.get("/api/generate/status", requireAuth, (req,res) => {
  res.json({ ok:true, ready:true, provider:"comfyui", model:COMFY_MODEL });
});

// Route principale génération image — essaie serveur-side, sinon renvoie les infos pour client-side
app.post("/api/generate/selfie", requireAuth, requireCsrf, rateLimit("genimg",30,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ Priorité : 1) ext envoyé depuis le front 2) profil compagnon 3) profil user
    const cidSelfie = req.body.companionId || null;
    let ext;
    if (cidSelfie) {
      const cr = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidSelfie, req.user.id);
      // ✅ v18.1 — Photo de compagnon : son profil est la source de vérité, on ne l'écrase
      //   plus par l'ext du formulaire principal (sinon Nyx prenait le corps cis de Gaëlle).
      ext = cr ? parseJson(decryptText(cr.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const style   = req.body.style   || "sensuelle";
    const tenue   = req.body.tenue   || null;
    const contexte= req.body.contexte|| null;
    const accessoires = req.body.accessoires || null;

    // Préférences apprises de l'utilisateur
    const userPrefs = { accessoires };
    let prompt = buildComfyPromptFinal(ext, style, tenue, userPrefs);
    if (contexte) prompt += ", " + contexte;
    if (accessoires) prompt += ", " + accessoires;

    // Seed aléatoire pour les selfies (variété) mais on garde le même visage de référence
    const seed = Math.floor(Math.random() * 2**32);
    const url = await comfyGenerateImage(prompt, style, null);

    // ✅ FIX v9 — INSERT avec la colonne "style" correctement remplie (et ai_analysis séparé)
    db.prepare("INSERT INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id(), req.user.id, url, "selfie_"+style+".png", "image/png", "ai_generated", style, prompt.slice(0,200), now());

    // Sauvegarder les préférences apprises dans le profil étendu
    if (accessoires || style) {
      const currentExt = ext;
      const histStyles = JSON.parse(currentExt.styles_generes || "[]");
      if (!histStyles.includes(style)) histStyles.push(style);
      currentExt.styles_generes = JSON.stringify(histStyles.slice(-20));
      if (accessoires && !currentExt.mes_jouets?.includes(accessoires)) {
        currentExt.mes_jouets = ((currentExt.mes_jouets||"") + " " + accessoires).trim();
      }
      db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
        .run(encryptText(JSON.stringify(currentExt)), now(), req.user.id);
    }

    res.json({ ok:true, url, style, prompt });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/generate/styles", requireAuth, (req,res) => {
  // ✅ FIX v9 — renvoyer le catalogue groupé ET une liste plate "styles"
  // Le frontend loadStyles() lit d.styles ; sans ça les tenues restaient vides.
  const cat = getStylesCatalogue();
  const flat = [];
  for (const groupe of cat) {
    for (const s of (groupe.styles || [])) {
      flat.push({ id: s.id, label: s.label, emoji: s.emoji });
    }
  }
  res.json({ ok:true, catalogue: cat, styles: flat });
});

app.get("/api/gallery", requireAuth, async (req,res) => {
  const companionIdFilter = req.query.companionId || null;
  try {
    // 1. Photos enregistrées en base — filtrées si companionId fourni
    let photos;
    if (companionIdFilter) {
      // Photos spécifiques à un compagnon
      photos = db.prepare(
        "SELECT id, url_enc as filename_enc, style, created_at FROM companion_photos WHERE companion_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50"
      ).all(companionIdFilter, req.user.id).map(p => ({
        ...p, filename: decryptText(p.filename_enc)
      }));
    } else {
      photos = db.prepare(
        "SELECT id, filename, COALESCE(style,'portrait') as style, COALESCE(created_at,datetime('now')) as created_at FROM media_library WHERE user_id=? AND (source='ai_generated' OR filename LIKE '/uploads/gen_%') ORDER BY rowid DESC LIMIT 100"
      ).all(req.user.id);
    }

    // 2. Si la base est vide, scanner le dossier uploads/ pour les gen_*
    if (!photos.length) {
      const uploadsDir = path.join(__dirname, "uploads");
      try {
        const fs2 = require("fs");
        const files = fs2.readdirSync(uploadsDir)
          .filter(f => f.startsWith("gen_") && f.endsWith(".png"))
          .sort().reverse()
          .slice(0, 50);
        photos = files.map(f => ({
          id: f,
          filename: "/uploads/" + f,
          style: "portrait",
          created_at: new Date(parseInt(f.split("_")[1]||0)).toISOString()
        }));
        // Les enregistrer en base pour la prochaine fois
        for (const p of photos) {
          try {
            db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
              .run(p.id, req.user.id, p.filename, p.id, "image/png", "ai_generated", p.style, p.created_at);
          } catch {}
        }
      } catch(e) { console.warn("[gallery scan]", e.message); }
    }

    // ✅ v13 : Filtrer les fichiers 404 côté serveur
    photos = photos.filter(p => {
      if (!p.filename || p.filename.includes("undefined")) return false;
      const clean = p.filename.replace("/uploads/","").split("/").pop();
      return fs.existsSync(path.join(UPLOADS_DIR, clean));
    });

    res.json({ ok:true, photos });
  } catch(e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post("/api/generate/image", requireAuth, requireCsrf, rateLimit("genimg",20,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ v18 — honorer le compagnon actif (corrige "toujours Gaëlle" : la route ignorait companionId)
    const cidImg = req.body.companionId || null;
    let ext;
    if (cidImg) {
      const crImg = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidImg, req.user.id);
      ext = crImg ? parseJson(decryptText(crImg.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }

    // Utiliser le prompt passé OU construire depuis le profil complet
    const rawPrompt = req.body.prompt || "";
    const style     = req.body.style  || "sensuelle";

    // Si le prompt est générique ou vide → utiliser buildComfyPrompt complet
    let finalPrompt;
    if (!rawPrompt || rawPrompt === "portrait sensuel" || rawPrompt.length < 20) {
      finalPrompt = buildComfyPromptFinal(ext, style, null);
    } else {
      // Enrichir le prompt utilisateur avec les caractéristiques physiques
      const physBase = buildComfyPromptFinal(ext, style, rawPrompt);
      finalPrompt = physBase;
    }

    const seed = req.body.seed ? parseInt(req.body.seed)
               : (req.body.forceSeed ? getAvatarSeed(ext) : null);
    const url  = await comfyGenerateImage(finalPrompt, style, seed);

    // ✅ FIX v9 — Sauvegarder dans media_library avec colonne style remplie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "photo_"+style+".png", "image/png", "ai_generated", style, finalPrompt.slice(0,200), now());
    } catch(e2) { console.warn("[media_library img]", e2.message); }

    res.json({ ok:true, url, style });
  } catch(e) {
    console.error("[generate/image]", e.message);
    res.status(500).json({ ok:false, error:e.message, clientSide:false });
  }
});

app.post("/api/generate/save", requireAuth, requireCsrf, async (req,res) => {
  try {
    const imageUrl = clean(req.body.imageUrl || "", 500);
    const companionId = req.body.companionId ? clean(req.body.companionId, 80) : null;
    const style = clean(req.body.style || "realistic", 20);
    const prompt = clean(req.body.prompt || "", 500);
    const seed = req.body.seed ? String(req.body.seed) : null;
    if (!imageUrl || !imageUrl.startsWith("http")) return res.status(400).json({ ok:false, error:"URL invalide" });

    // Télécharger et sauvegarder localement
    const localUrl = await downloadToUploads(imageUrl);

    if (companionId) {
      // Sauvegarder en companion_photos
      const comp = db.prepare("SELECT id FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
      if (comp) {
        db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id(), companionId, req.user.id, encryptText(localUrl), encryptText(prompt), style, seed||"", now());
        // Mettre à jour avatar si c'est le premier
        const existing = db.prepare("SELECT avatar_url_enc FROM companions WHERE id=?").get(companionId);
        if (!existing?.avatar_url_enc) {
          db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE id=?").run(encryptText(localUrl), now(), companionId);
        }
      }
    } else {
      // Sauvegarder comme avatar utilisateur
      db.prepare("UPDATE users SET avatar_enc=?,persona_photo_enc=?,updated_at=? WHERE id=?")
        .run(encryptText(localUrl), encryptText(localUrl), now(), req.user.id);
    }

    res.json({ ok:true, url:localUrl });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post("/api/generate/avatar", requireAuth, requireCsrf, rateLimit("genimg",20,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ Priorité : ext front > profil compagnon > profil user
    const cidAv = req.body.companionId || null;
    let ext;
    if (cidAv) {
      const crAv = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidAv, req.user.id);
      ext = crAv ? parseJson(decryptText(crAv.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const style = req.body.style || "portrait";
    const tenue = req.body.tenue || null;

    // ✅ FIX v9 — gestion du seed :
    // - Si le client envoie un seed explicite (nouveau visage) → on l'utilise
    // - Sinon, si forceSeed demandé → seed de référence stable (même visage)
    // - Sinon → aléatoire
    const clientSeed = req.body.seed ? parseInt(req.body.seed) : null;
    const forceSeed  = req.body.forceSeed === true; // n'est plus true par défaut

    // Prompt complet depuis TOUT le profil physique
    const prompt = req.body.prompt || buildComfyPromptFinal(ext, style, tenue);

    let seed = null;
    if (clientSeed && !isNaN(clientSeed) && clientSeed > 0) {
      seed = clientSeed;            // visage varié demandé par le client
    } else if (forceSeed) {
      seed = getAvatarSeed(ext);    // même visage de référence
    }
    // sinon seed=null → comfyGenerateImage en génère un aléatoire

    console.log("[Avatar] style:", style, "| seed:", seed, "| prompt:", prompt.slice(0,80)+"...");
    const url = await comfyGenerateImage(prompt, style, seed);

    // Sauvegarder l'avatar + seed de référence
    const updExt = { ...ext };
    if (!updExt.avatar_seed || updExt.avatar_seed === "null") {
      updExt.avatar_seed = String(seed || Date.now());
    }
    updExt.avatar_url_ref = url;
    db.prepare("UPDATE users SET persona_photo_enc=?, avatar_enc=?, extended_profile_enc=?, updated_at=? WHERE id=?")
      .run(encryptText(url), encryptText(url), encryptText(JSON.stringify(updExt)), now(), req.user.id);

    // ── Sauvegarder dans media_library pour la galerie ──────────────
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "avatar_"+style+".png", "image/png", "ai_generated", style, now());
    } catch(e) { console.warn("[media_library]", e.message); }

    const updatedExt = { ...updExt };

    // Créer une compagne par défaut si aucune n'existe encore
    const existingComp = db.prepare("SELECT id FROM companions WHERE user_id=? LIMIT 1").get(req.user.id);
    if (!existingComp) {
      const compId = id();
      const aiNameStr = decryptText(req.user.ai_name_enc) || "Élissia";
      db.prepare("INSERT INTO companions(id,user_id,name_enc,persona,profile_enc,avatar_url_enc,avatar_seed,created_at,updated_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?,?,1,0)")
        .run(compId, req.user.id, encryptText(aiNameStr), req.user.preferred_persona||"girlfriend",
          encryptText(JSON.stringify(updatedExt)), encryptText(url), String(seed || Date.now()), now(), now());
      // Sauvegarder dans companion_photos
      const fullPrompt = personality.buildAvatarPromptFromProfile(updatedExt);
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), compId, req.user.id, encryptText(url), encryptText(fullPrompt), "realistic", String(seed || Date.now()), now());
    } else {
      // Mettre à jour la compagne existante
      db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE user_id=? LIMIT 1")
        .run(encryptText(url), now(), req.user.id);
      // Sauvegarder en companion_photos
      const fullPrompt = personality.buildAvatarPromptFromProfile(updatedExt);
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), existingComp.id, req.user.id, encryptText(url), encryptText(fullPrompt), "realistic", String(seed || Date.now()), now());
    }

    audit(req.user.id,"avatar_generated",{ seed: seed },req);
    res.json({ ok:true, url, avatarUrl:url, seed: seed });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   ✅ NOUVEAU v9 — AVATAR ANIMÉ GIF
   POST /api/generate/avatar/animated  { frames? }
   Génère plusieurs portraits du même visage et les assemble en GIF.
═══════════════════════════════════════════════════════════════ */
app.post("/api/generate/avatar/animated", requireAuth, requireCsrf, rateLimit("genimg",6,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u   = publicUser(freshUser);
    const ext = u.extendedProfile || {};
    const frames = req.body.frames || 6;

    console.log("[Avatar animé] Démarrage génération vidéo MP4, frames:", frames);
    const vidUrl = await generateAnimatedAvatarGif(ext, req.user.id, frames);

    // Sauvegarder la vidéo comme avatar animé (et avatar courant)
    const updExt = { ...ext, avatar_animated_url: vidUrl };
    db.prepare("UPDATE users SET avatar_animated_enc=?, persona_photo_enc=?, avatar_enc=?, extended_profile_enc=?, updated_at=? WHERE id=?")
      .run(encryptText(vidUrl), encryptText(vidUrl), encryptText(vidUrl), encryptText(JSON.stringify(updExt)), now(), req.user.id);

    // Ajouter à la galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "avatar_anime.mp4", "video/mp4", "ai_generated", "avatar_anime", now());
    } catch(e) { console.warn("[media_library mp4]", e.message); }

    audit(req.user.id,"avatar_animated_generated",{ frames },req);
    res.json({ ok:true, url: vidUrl });
  } catch(e) {
    console.error("[avatar/animated]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══ GÉNÉRATION VIDÉO ══════════════════════════════════════════
app.post("/api/generate/video", requireAuth, requireCsrf, rateLimit("genvid",5,3600000), async (req,res) => {
  try {
    const u = publicUser(req.user);
    // ✅ v18 — honorer le compagnon actif (même fix que /api/generate/image)
    const cidVid = req.body.companionId || null;
    let ext;
    if (cidVid) {
      const crVid = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidVid, req.user.id);
      ext = crVid ? parseJson(decryptText(crVid.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const prompt  = clean(req.body.prompt || personality.buildSelfiePrompt(ext, "sensuelle"), 500);
    const explicit = Boolean(req.body.explicit) && !!req.user.adult_mode;
    const url = await civitaiGenerateVideo(prompt, explicit);
    res.json({ ok:true, video_url:url });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ v12 — Vidéo depuis conversation (utilise les messages du chat comme contexte de scène)
app.post("/api/generate/video/chat", requireAuth, requireCsrf, rateLimit("genvid",5,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u   = publicUser(freshUser);
    const ext = u.extendedProfile || {};
    const explicit = Boolean(req.body.explicit) && !!freshUser.adult_mode;

    // Récupérer les derniers messages pour construire la scène
    const chatMessages = db.prepare("SELECT role, content_enc FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 6").all(req.user.id)
      .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc).slice(0, 250) }));

    console.log("[VideoChat] Génération depuis", chatMessages.length, "messages récents");
    const url = await generateVideoFromChat(req.user.id, ext, explicit, chatMessages);

    // Sauvegarder dans la galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "chat_video.mp4", "video/mp4", "ai_generated", "video_chat", now());
    } catch {}

    res.json({ ok:true, video_url:url, url });
  } catch(e) { console.error("[VideoChat]", e.message); res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ v12 — API pour afficher les mémoires dans l'UI
app.get("/api/memories/summary", requireAuth, (req,res) => {
  try {
    const m3 = getMemoire3Niveaux(req.user.id);
    const allMemories = db.prepare("SELECT id, text_enc, kind, importance, source, created_at FROM memories WHERE user_id=? ORDER BY importance DESC, created_at DESC LIMIT 100").all(req.user.id)
      .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, source:m.source, createdAt:m.created_at }));
    const facts = db.prepare("SELECT type, fact_enc, importance FROM user_facts WHERE user_id=? ORDER BY importance DESC LIMIT 30").all(req.user.id)
      .map(f => ({ type:f.type, text:decryptText(f.fact_enc), importance:f.importance }));
    const journal = db.prepare("SELECT date, title, content_enc, mood FROM memory_journal WHERE user_id=? ORDER BY created_at DESC LIMIT 10").all(req.user.id)
      .map(j => ({ date:j.date, title:j.title, content:decryptText(j.content_enc), mood:j.mood }));
    res.json({ ok:true, summary:m3, memories:allMemories, facts, journal, totalMemories:allMemories.length });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ══ UPLOAD MÉDIAS ═════════════════════════════════════════════
app.post("/api/media/upload", requireAuth, upload.single("media"), async (req,res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"Aucun fichier." });
  const localUrl = `/uploads/${req.file.filename}`;
  let analysis = "";

  if (req.file.mimetype.startsWith("image/")) {
    // ✅ v13 : Utiliser le genre du compagnon actif si fourni (pour une analyse plus précise)
    const u = publicUser(req.user);
    let userGender = (u.extendedProfile||{}).user_genre || (u.extendedProfile||{}).genre || "";
    const companionId = req.body.companionId || null;
    if (companionId) {
      const cr = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
      if (cr) {
        const cp = parseJson(decryptText(cr.profile_enc), {});
        userGender = cp.genre || userGender;
      }
    }
    try {
      analysis = await analyzeImage(path.join(UPLOADS_DIR, req.file.filename), userGender, !!(req.user.adult_mode)) || "";
      console.log("[MediaUpload] Analyse image:", analysis?.slice(0,80));
    } catch(e) { console.warn("[MediaUpload] analyzeImage:", e.message); }
  }

  const mediaId = id();
  db.prepare("INSERT INTO media_library(id,user_id,filename,original_name,mime_type,source,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(mediaId, req.user.id, localUrl, req.file.originalname, req.file.mimetype, "user", analysis, now());

  res.json({
    ok: true, mediaId, url: localUrl,
    type: req.file.mimetype.startsWith("image/") ? "image" : "video",
    analysis,
    mimeType: req.file.mimetype,
    // ✅ Indiquer si l'analyse a fonctionné
    vision_available: analysis.length > 0 && analysis !== "__VISION_INDISPONIBLE__"
  });
});

// ══ MÉMOIRES CRUD ═════════════════════════════════════════════
app.get("/api/memories", requireAuth, (req,res) => {
  const rows = db.prepare("SELECT id,text_enc,kind,importance,created_at,updated_at FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 300").all(req.user.id)
    .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at, updatedAt:m.updated_at }));
  res.json({ ok:true, memories:rows });
});
app.post("/api/memories", requireAuth, requireCsrf, async (req,res) => {
  const text = clean(req.body.text,1200), kind = clean(req.body.kind||"manual",80);
  const importance = Math.max(1,Math.min(5,Number(req.body.importance||3)));
  if (!text) return res.status(400).json({ ok:false, error:"Vide." });
  const e = await embed(text);
  const memoryId = id();
  db.prepare("INSERT INTO memories(id,user_id,text_enc,kind,importance,embedding_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(memoryId,req.user.id,encryptText(text),kind,importance,e?json(e):null,now(),now());
  res.json({ ok:true, memory:{ id:memoryId, text, kind, importance } });
});
app.put("/api/memories/:id", requireAuth, requireCsrf, async (req,res) => {
  const memoryId = clean(req.params.id,80);
  if (!db.prepare("SELECT id FROM memories WHERE id=? AND user_id=?").get(memoryId,req.user.id))
    return res.status(404).json({ ok:false, error:"Introuvable." });
  const text = clean(req.body.text,1200), kind = clean(req.body.kind||"manual",80);
  const importance = Math.max(1,Math.min(5,Number(req.body.importance||3)));
  const e = await embed(text);
  db.prepare("UPDATE memories SET text_enc=?,kind=?,importance=?,embedding_json=?,updated_at=? WHERE id=? AND user_id=?")
    .run(encryptText(text),kind,importance,e?json(e):null,now(),memoryId,req.user.id);
  res.json({ ok:true });
});
app.delete("/api/memories/:id", requireAuth, requireCsrf, (req,res) => {
  db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(clean(req.params.id,80),req.user.id);
  res.json({ ok:true });
});
app.delete("/api/messages", requireAuth, requireCsrf, (req,res) => {
  const cid = req.query.companionId || req.body?.companionId || null;
  if (cid) db.prepare("DELETE FROM messages WHERE user_id=? AND companion_id=?").run(req.user.id, cid);
  else db.prepare("DELETE FROM messages WHERE user_id=? AND companion_id IS NULL").run(req.user.id);
  res.json({ ok:true });
});
app.delete("/api/memories", requireAuth, requireCsrf, (req,res) => {
  db.prepare("DELETE FROM memories WHERE user_id=?").run(req.user.id);
  res.json({ ok:true });
});
app.delete("/api/account", requireAuth, requireCsrf, (req,res) => {
  const userId = req.user.id;
  audit(userId,"account_deleted",{},req);
  db.prepare("DELETE FROM users WHERE id=?").run(userId);
  res.clearCookie("sid",{path:"/"});
  res.json({ ok:true });
});

// ══ EXPORT ════════════════════════════════════════════════════
app.get("/api/export", requireAuth, (req,res) => {
  const messages = db.prepare("SELECT role,content_enc,persona,created_at FROM messages WHERE user_id=? ORDER BY created_at ASC").all(req.user.id)
    .map(m => ({ role:m.role, content:decryptText(m.content_enc), persona:m.persona, createdAt:m.created_at }));
  const memories = db.prepare("SELECT text_enc,kind,importance,created_at FROM memories WHERE user_id=? ORDER BY created_at ASC").all(req.user.id)
    .map(m => ({ text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at }));
  res.setHeader("Content-Type","application/json");
  res.setHeader("Content-Disposition","attachment; filename=export-elissia.json");
  res.send(JSON.stringify({ exportedAt:now(), user:publicUser(req.user), messages, memories }, null, 2));
});

// ══ TTS PIPER ═════════════════════════════════════════════════
app.get("/api/tts/piper/status", requireAuth, (req,res) => {
  const bin = process.env.PIPER_BIN||"", model = process.env.PIPER_MODEL||"";
  res.json({ ok:true, enabled:Boolean(bin&&model&&fs.existsSync(bin)&&fs.existsSync(model)), voiceName:process.env.PIPER_VOICE_NAME||"Piper local" });
});
app.post("/api/tts/piper", requireAuth, requireCsrf, rateLimit("tts",120,3600000), async (req,res) => {
  const text = clean(req.body.text,1500);
  const bin = process.env.PIPER_BIN||"", model = process.env.PIPER_MODEL||"";
  if (!text) return res.status(400).json({ ok:false, error:"Texte vide." });
  if (!bin||!model||!fs.existsSync(bin)||!fs.existsSync(model)) return res.status(501).json({ ok:false, error:"Piper non configuré." });
  const out = path.join(os.tmpdir(), "elissia-" + id() + ".wav");
  const result = spawnSync(bin, ["--model",model,"--output_file",out], { input:text, encoding:"utf8", timeout:60000 });
  if (result.status!==0||!fs.existsSync(out)) return res.status(500).json({ ok:false, error:"Erreur Piper." });
  const wav = fs.readFileSync(out); fs.unlinkSync(out);
  res.setHeader("Content-Type","audio/wav"); res.setHeader("Cache-Control","no-store");
  res.send(wav);
});

// ══ PLUGINS ═══════════════════════════════════════════════════
app.get("/api/plugins", requireAuth, (req,res) => { res.json({ ok:true, plugins:pluginEngine.listPlugins() }); });
app.get("/api/ollama-status", async (req,res) => {
  try {
    const r = await fetch(OLLAMA_URL+"/api/tags",{signal:AbortSignal.timeout(5000)});
    const j = await r.json();
    res.json({ ok:true, models:j.models?.map(m=>m.name)||[] });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

/* ═══════════════════════════════════════
   ROUTES PROXY COMFYUI (diagnostic + modèles)
═══════════════════════════════════════ */

// Proxy transparent vers ComfyUI — pour contourner CORS du navigateur
app.get("/api/comfy/models", requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
    const d = await r.json();
    const models = d?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    res.json({ ok: true, models, comfyUrl: COMFY_URL });
  } catch(e) {
    res.status(503).json({ ok: false, error: "ComfyUI inaccessible: " + e.message, comfyUrl: COMFY_URL });
  }
});

// Proxy object_info — pour diagnostiquer les nodes disponibles
app.get("/api/comfy/object-info", requireAuth, async (req, res) => {
  try {
    const node = req.query.node || "CheckpointLoaderSimple";
    const r = await fetch(`${COMFY_URL}/object_info/${node}`);
    const d = await r.json();
    res.json({ ok: true, data: d });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get("/api/comfy/status", requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${COMFY_URL}/system_stats`);
    const d = await r.json();
    res.json({ ok: true, stats: d, comfyUrl: COMFY_URL });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════
   ROUTES COMPAGNES (multi-compagnes)
═══════════════════════════════════════ */

// Liste toutes les compagnes de l'utilisateur
app.get("/api/companions", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM companions WHERE user_id=? ORDER BY sort_order ASC, created_at ASC").all(req.user.id);
  const companions = rows.map(c => ({
    id: c.id, name: decryptText(c.name_enc), persona: c.persona,
    profile: parseJson(decryptText(c.profile_enc), {}),
    avatarUrl: c.avatar_url_enc ? decryptText(c.avatar_url_enc) : null,
    seed: c.avatar_seed, isActive: Boolean(c.is_active),
    sortOrder: c.sort_order, createdAt: c.created_at
  }));
  res.json({ ok: true, companions });
});

// Créer une nouvelle compagne
app.post("/api/companions", requireAuth, requireCsrf, (req, res) => {
  const name    = clean(req.body.name || "Élissia", 80);
  const persona = clean(req.body.persona || "girlfriend", 50);
  const profile = req.body.profile || {};
  const compId  = id();
  // Seed déterministe basé sur l'ID compagne
  const seed = Math.abs(compId.split("").reduce((a,c) => ((a<<5)-a)+c.charCodeAt(0), 0)) % 4294967295;
  db.prepare("INSERT INTO companions(id,user_id,name_enc,persona,profile_enc,avatar_seed,created_at,updated_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?,0,?)")
    .run(compId, req.user.id, encryptText(name), persona, encryptText(JSON.stringify(profile)), String(seed), now(), now(),
      db.prepare("SELECT COUNT(*) c FROM companions WHERE user_id=?").get(req.user.id).c);
  res.json({ ok: true, id: compId, name, persona, seed: seed });
});

// Mettre à jour une compagne
app.put("/api/companions/:id", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT id FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });
  const name    = req.body.name    ? clean(req.body.name, 80) : null;
  const persona = req.body.persona ? clean(req.body.persona, 50) : null;
  const profile = req.body.profile || null;
  if (name)    db.prepare("UPDATE companions SET name_enc=?,updated_at=? WHERE id=?").run(encryptText(name), now(), compId);
  if (persona) db.prepare("UPDATE companions SET persona=?,updated_at=? WHERE id=?").run(persona, now(), compId);
  if (profile) db.prepare("UPDATE companions SET profile_enc=?,updated_at=? WHERE id=?").run(encryptText(JSON.stringify(profile)), now(), compId);
  res.json({ ok: true });
});

// Supprimer une compagne
app.delete("/api/companions/:id", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  db.prepare("DELETE FROM companions WHERE id=? AND user_id=?").run(compId, req.user.id);
  db.prepare("DELETE FROM companion_photos WHERE companion_id=? AND user_id=?").run(compId, req.user.id);
  res.json({ ok: true });
});

// Générer et sauvegarder un avatar pour une compagne spécifique
app.post("/api/companions/:id/avatar", requireAuth, requireCsrf, rateLimit("genimg",10,3600000), async (req, res) => {
  // ComfyUI local — pas de clé requise
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  try {
    const profile = parseJson(decryptText(row.profile_enc), {});
    const seed    = parseInt(row.avatar_seed) || null;
    const prompt  = personality.buildAvatarPromptFromProfile(profile);
    const url     = await civitaiGenerateImage(prompt, "realistic", seed);

    // Sauvegarder en base — permanent
    db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE id=?").run(encryptText(url), now(), compId);
    // Aussi dans companion_photos pour l'historique
    db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(), compId, req.user.id, encryptText(url), encryptText(prompt), "realistic", String(seed||""), now());

    res.json({ ok: true, url, avatarUrl: url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Générer une photo pour une compagne (selfie, sensuelle, etc.) — sauvegardée en permanence
app.post("/api/companions/:id/photo", requireAuth, requireCsrf, rateLimit("genimg",10,3600000), async (req, res) => {
  // ComfyUI local — pas de clé requise
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  try {
    const profile  = parseJson(decryptText(row.profile_enc), {});
    const style    = clean(req.body.style || "realistic", 20);
    const context  = clean(req.body.context || "casual", 20);
    const seed     = parseInt(row.avatar_seed) || null; // même seed = même visage
    const prompt   = req.body.prompt || personality.buildSelfiePrompt(profile, context);
    const url      = await civitaiGenerateImage(prompt, style, seed);

    // Sauvegarder en permanence
    db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(), compId, req.user.id, encryptText(url), encryptText(prompt), style, String(seed||""), now());

    res.json({ ok: true, url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Récupérer toutes les photos d'une compagne
app.get("/api/companions/:id/photos", requireAuth, (req, res) => {
  const compId = clean(req.params.id, 80);
  const photos = db.prepare("SELECT * FROM companion_photos WHERE companion_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50").all(compId, req.user.id);
  res.json({ ok: true, photos: photos.map(p => ({
    id: p.id, url: decryptText(p.url_enc), style: p.style,
    prompt: decryptText(p.prompt_enc||""), createdAt: p.created_at
  }))});
});

// Chat avec une compagne spécifique (utilise son profil)
app.post("/api/companions/:id/chat", requireAuth, requireCsrf, rateLimit("chat",60,3600000), async (req, res) => {
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  // Construire un user "virtuel" avec le profil de cette compagne
  const compProfile = parseJson(decryptText(row.profile_enc), {});
  const compName    = decryptText(row.name_enc);
  const fakeUser = {
    ...req.user,
    ai_name_enc: encryptText(compName),
    preferred_persona: row.persona,
    extended_profile_enc: encryptText(JSON.stringify(compProfile))
  };

  // Déléguer au handler de chat standard
  req.user = fakeUser;
  req.body.companionId = compId;
  // Re-router vers le handler /api/chat/stream
  // Pour simplifier : appeler directement le LLM ici
  const message = clean(req.body.message, 4000);
  if (!message) return res.status(400).json({ ok: false, error: "Message vide" });

  const u = publicUser(fakeUser);
  const sysPrompt = buildSystemPrompt(fakeUser, row.persona, message, {});
  // ✅ v18.2 — recentMsgs scopé par companion_id + fil solo (était global → mélange tous les compagnons)
  const recentMsgs = db.prepare(
    "SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')='solo' ORDER BY created_at DESC LIMIT 20"
  ).all(req.user.id, compId).reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));

  const llmMessages = [
    { role: "system", content: sysPrompt },
    ...recentMsgs,
    { role: "user", content: message }
  ];

  res.writeHead(200, { "Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache","Connection":"keep-alive" });
  res.write(JSON.stringify({ type:"start", companion: compName }) + "\n");

  let full = await ollamaStream(llmMessages, token => {
    res.write(JSON.stringify({ type:"token", token }) + "\n");
  });

  // ✅ v18.2 — companion_id + thread 'solo' ajoutés (était orphelin → pastilles jamais incrémentées)
  db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id(), req.user.id, "assistant", encryptText(full), row.persona, compId, "solo", now());

  res.write(JSON.stringify({ type:"done", reply: full, companion: compName }) + "\n");
  res.end();
});

/* ═══════════════════════════════════════
   WEB SEARCH — PERPLEXITY
   Utilisé pour enrichir les prompts photo/vidéo
   et répondre aux questions d'actualité
═══════════════════════════════════════ */
app.post("/api/websearch/perplexity", requireAuth, requireCsrf, rateLimit("websearch",20,3600000), async (req,res) => {
  const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PERPLEXITY_KEY) return res.json({ ok:false, error:"Clé Perplexity non configurée dans .env" });

  const { query, mode = "chat" } = req.body;
  if (!query) return res.status(400).json({ ok:false, error:"query manquante" });

  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PERPLEXITY_KEY}`
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: mode === "photo"
              ? "Tu es un expert en photographie et en génération d'images IA. Donne des descriptions visuelles précises et évocatrices pour guider la génération d'images. Réponds en anglais (pour les prompts) et en 2-3 phrases maximum."
              : "Tu es un assistant connecté à internet. Réponds en français, de façon concise et précise avec les informations les plus récentes."
          },
          { role: "user", content: query }
        ],
        max_tokens: 300,
        temperature: 0.7,
        search_recency_filter: "week"
      })
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      throw new Error(`Perplexity ${r.status}: ${err.slice(0,200)}`);
    }

    const data = await r.json();
    const result = data.choices?.[0]?.message?.content || "";
    const citations = data.citations || [];

    console.log(`[Perplexity] Query: "${query.slice(0,50)}" → ${result.length} chars`);
    res.json({ ok:true, result, citations });
  } catch(e) {
    console.error("[Perplexity]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* ═══════════════════════════════════════
   GALERIE PHOTOS AI
   ⚠️ DOUBLONS NEUTRALISÉS v9 — ces routes étaient redéfinies ici mais
   jamais atteintes (Express utilise la 1re définition plus haut).
   L'ancienne requête gallery ne lisait pas la colonne "style" et la liste
   "styles" plate était incomplète. Versions actives = celles plus haut.
═══════════════════════════════════════ */
// app.get("/api/gallery", ...) — voir définition active plus haut (avec colonne style)
// app.get("/api/generate/styles", ...) — voir définition active plus haut (catalogue + styles)

/* ═══════════════════════════════════════
   ROUTES STATIQUES
═══════════════════════════════════════ */
app.get("/mobile",       (req,res) => res.sendFile(path.join(__dirname,"public-v5","mobile.html")));
app.get("/v5.css",       (req,res) => res.sendFile(path.join(__dirname,"public-v5","v5.css")));
app.get("/v5.js",        (req,res) => res.sendFile(path.join(__dirname,"public-v5","v5.js")));
app.get("/manifest.json",(req,res) => res.json({
  name:"ÉLISSIA",short_name:"ÉLISSIA",start_url:"/mobile",display:"standalone",
  background_color:"#111018",theme_color:"#ff3f91",
  icons:[{src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='192' height='192'%3E%3Crect width='192' height='192' rx='48' fill='%23ff3f91'/%3E%3Ctext x='96' y='122' text-anchor='middle' font-size='84'%3E%F0%9F%92%97%3C/text%3E%3C/svg%3E",sizes:"192x192",type:"image/svg+xml"}]
}));
app.get("/sw.js",(req,res) => res.type("js").send(`
const CACHE="elissia-v8";const ASSETS=["/mobile","/v5.css","/v5.js","/manifest.json"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(u.pathname.startsWith("/api/")||u.pathname.startsWith("/uploads/")){e.respondWith(fetch(e.request));return}e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)))});
`));

// ══════════════════════════════════════════════════════════════
// GÉNÉRATION PHOTO COMPAGNON avec son profil exact
// ══════════════════════════════════════════════════════════════
app.post("/api/companions/:id/generate-avatar", requireAuth, requireCsrf, rateLimit("genimg",15,3600000), async (req,res) => {
  try {
    const compRow = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!compRow) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });
    
    // Profil compagnon = source de vérité
    const compProfile = parseJson(decryptText(compRow.profile_enc), {});
    // ✅ v18.1 — profil du compagnon = source de vérité (style/seed restent gérés à part)
    const ext  = compProfile;
    const style = clean(req.body.style || "portrait", 40);
    const seed  = req.body.seed ? parseInt(req.body.seed) : (parseInt(compRow.avatar_seed)||Math.floor(Math.random()*2**32));
    
    console.log(`[CompGen] ${decryptText(compRow.name_enc)} — genre:${ext.genre} corp:${ext.corpulence} seed:${seed}`);
    
    // Générer
    const prompt = buildComfyPromptFinal(ext, style);
    const url    = await comfyGenerateImage(prompt, style, seed);
    if (!url) return res.status(500).json({ ok:false, error:"Génération échouée" });
    
    // Sauvegarder comme avatar du compagnon
    db.prepare("UPDATE companions SET avatar_url_enc=?, avatar_seed=?, updated_at=? WHERE id=?")
      .run(encryptText(url), seed, now(), compRow.id);
    
    // Sauvegarder dans les photos du compagnon
    try {
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), compRow.id, req.user.id, encryptText(url), style, seed, now());
    } catch {}
    
    res.json({ ok:true, url, companionId:compRow.id, prompt_preview:prompt.slice(0,150) });
  } catch(e) {
    console.error("[CompGen]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SUPPRESSION D'UN MESSAGE (photo ou texte) du chat
// ══════════════════════════════════════════════════════════════
app.delete("/api/messages/:id", requireAuth, requireCsrf, (req,res) => {
  const msg = db.prepare("SELECT * FROM messages WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!msg) return res.status(404).json({ ok:false, error:"Message introuvable" });
  
  // Si le message a une photo, ne pas supprimer le fichier (il peut être en galerie)
  // Juste supprimer le message de la DB
  db.prepare("DELETE FROM messages WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  
  res.json({ ok:true, deleted:req.params.id });
});

// SUPPRESSION D'UNE PHOTO DE LA GALERIE (sans casser le chat)
app.delete("/api/gallery/:filename", requireAuth, requireCsrf, (req,res) => {
  try {
    const fname = req.params.filename;
    if (!fname || fname.includes("..")) return res.status(400).json({ ok:false, error:"Nom invalide" });
    
    // Supprimer de la DB
    db.prepare("DELETE FROM media_library WHERE user_id=? AND (filename=? OR filename=?)").run(
      req.user.id, fname, "/uploads/" + fname
    );
    
    // Supprimer le fichier (optionnel — si pas référencé ailleurs)
    const filePath = path.join(UPLOADS_DIR, fname.replace("/uploads/",""));
    if (fs.existsSync(filePath)) {
      // Vérifier si le fichier est encore référencé dans des messages
      const refs = db.prepare("SELECT COUNT(*) c FROM messages WHERE user_id=? AND media_url LIKE ?").get(req.user.id, "%" + fname + "%");
      if (!refs?.c) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    
    res.json({ ok:true, deleted:fname });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SCÈNE VIDÉO MULTI-PERSONNAGES — Perplexity enrichit le prompt
// ══════════════════════════════════════════════════════════════
app.post("/api/generate/scene-video", requireAuth, requireCsrf, rateLimit("genvid",3,3600000), async (req,res) => {
  try {
    const freshUser    = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const adultMode    = Boolean(freshUser.adult_mode);
    const scenarioCtx  = clean(req.body.scenarioContext || "", 2000);
    const companionIds = (req.body.companionIds || []).slice(0, 3);
    const style        = clean(req.body.style || "sensuelle", 30);
    if (!scenarioCtx)       return res.status(400).json({ ok:false, error:"scenarioContext requis" });
    if (!companionIds.length) return res.status(400).json({ ok:false, error:"Aucun compagnon" });

    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) return res.status(503).json({ ok:false, error:"FFmpeg non disponible" });

    // 1️⃣ Perplexity ENRICHIT le prompt (améliore le scénario utilisateur)
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    let videoPrompt = "";
    if (PERPLEXITY_KEY) {
      try {
        const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${PERPLEXITY_KEY}`},
          body: JSON.stringify({
            model:"sonar",
            messages:[
              { role:"system", content:"You are an expert Stable Diffusion prompt engineer for photorealistic adult AI image generation using Juggernaut XL. Given a scene description in French, create a highly optimized English Stable Diffusion prompt. Requirements: describe the exact pose and action, physical details of the scene, setting/environment, lighting, mood, level of nudity or explicitness. Be very specific and vivid. Max 4 sentences, English only. No preamble." },
              { role:"user", content:`Scene description (French): ${scenarioCtx.slice(0,1000)}

Create an optimized Stable Diffusion XL prompt for this exact scene. Include: pose, action, setting, lighting. Style: ${style}. Be explicit if adult content is described.` }
            ],
            max_tokens:300, temperature:0.8
          })
        });
        if (pxR.ok) {
          const pxD = await pxR.json();
          videoPrompt = pxD.choices?.[0]?.message?.content?.trim() || "";
          console.log("[SceneVideo] Perplexity prompt généré:", videoPrompt.slice(0,120));
        }
      } catch(e) { console.warn("[SceneVideo] Perplexity:", e.message); }
    }

    // 2️⃣ Profils + dernières photos des compagnons
    const companions = [];
    for (const cid of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(cid, req.user.id);
      if (!cr) continue;
      const profile   = parseJson(decryptText(cr.profile_enc), {});
      const lastPhoto = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(cid);
      const avatarUrl = cr.avatar_url_enc ? decryptText(cr.avatar_url_enc) : (lastPhoto ? decryptText(lastPhoto.url_enc) : null);
      companions.push({
        id: cid, name: decryptText(cr.name_enc), persona: cr.persona, profile, avatarUrl,
        seed: parseInt(cr.avatar_seed) || Math.floor(Math.random() * 2**32)
      });
    }
    if (!companions.length) return res.status(400).json({ ok:false, error:"Aucun compagnon trouvé" });

    // 3️⃣ Générer frames pour chaque personnage
    const allFrames = [];
    const frameCount = companions.length === 1 ? 6 : 4;

    for (const comp of companions) {
      const basePrompt = buildComfyPromptFinal(comp.profile, style);
      const sceneAdd   = videoPrompt || scenarioCtx.slice(0,200);

      const expressions = [
        "standing confident looking at camera, full body shot",
        "seductive pose showing body, hands on hips",
        "bending forward, dominant powerful pose",
        "turning to show curves, looking back over shoulder",
        "close intimate pose reaching toward camera",
        "sitting or kneeling, submissive pose"
      ].slice(0, frameCount);

      for (let i = 0; i < frameCount; i++) {
        try {
          const framePrompt = `${basePrompt}, ${expressions[i]}, ${sceneAdd.slice(0,180)}`;
          const url = await comfyGenerateImage(framePrompt, style, comp.seed + i);
          const abs = url.startsWith("/uploads/")
            ? path.join(UPLOADS_DIR, url.replace("/uploads/", ""))
            : path.join(UPLOADS_DIR, url.split("/").pop());
          if (fs.existsSync(abs)) { allFrames.push(abs); console.log(`[SceneVideo] ${comp.name} frame ${i+1}/${frameCount} ✓`); }
        } catch(e) { console.warn(`[SceneVideo] frame ${comp.name} ${i}:`, e.message); }
      }
    }

    if (allFrames.length < 2) return res.status(500).json({ ok:false, error:"Pas assez de frames ("+allFrames.length+")" });

    // 4️⃣ Assembler MP4
    const vidName = `scene_${req.user.id.slice(0,8)}_${Date.now()}.mp4`;
    const vidPath = path.join(UPLOADS_DIR, vidName);
    const fps = companions.length === 1 ? 18 : 22;
    await assembleMP4(allFrames, vidPath, fps);
    const vidUrl = "/uploads/" + vidName;

    // 5️⃣ Sauvegarder en galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "scene_video.mp4", "video/mp4", "ai_generated", "scene_multi", scenarioCtx.slice(0,200), now());
    } catch {}

    res.json({
      ok:true, url:vidUrl, video_url:vidUrl,
      frames:allFrames.length, companions:companions.map(c=>c.name),
      prompt_perplexity:videoPrompt.slice(0,200),
      prompt_enriched: videoPrompt.length > 0
    });
  } catch(e) {
    console.error("[SceneVideo]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// AVATAR COMPAGNON — sauvegarder la photo d'UN compagnon
// ══════════════════════════════════════════════════════════════
app.post("/api/companions/:id/avatar", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  const comp = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!comp) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });

  const url = req.body.url || req.body.avatar;
  if (!url) return res.status(400).json({ ok:false, error:"url requis" });

  // Sauvegarder comme avatar du compagnon (pas du user principal)
  db.prepare("UPDATE companions SET avatar_url_enc=?, updated_at=? WHERE id=?")
    .run(encryptText(url), now(), compId);

  // Ajouter à la galerie photos du compagnon si pas déjà présent
  try {
    const exists = db.prepare("SELECT id FROM companion_photos WHERE companion_id=? AND url_enc=?")
      .get(compId, encryptText(url));
    if (!exists) {
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,style,created_at) VALUES(?,?,?,?,?,?)")
        .run(id(), compId, req.user.id, encryptText(url), "portrait", now());
    }
  } catch(e) { console.warn("[companion/avatar]", e.message); }

  console.log(`[CompAvatar] ${decryptText(comp.name_enc)} → ${url.slice(-20)}`);
  res.json({ ok:true, url, companionId:compId });
});

// Route GET : récupérer l'avatar actuel d'un compagnon
app.get("/api/companions/:id/avatar", requireAuth, (req, res) => {
  const compId = clean(req.params.id, 80);
  const comp = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!comp) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });
  const avatarUrl = comp.avatar_url_enc ? decryptText(comp.avatar_url_enc) : null;
  res.json({ ok:true, url:avatarUrl, companionId:compId });
});

// ══════════════════════════════════════════════════════════════
// WAN VIDEO 2.2 — img2vid : image source → clip vidéo fluide
// Déclenché par /api/generate/img2vid
// Nécessite : wan2.2_i2v_high_noise_14B_fp8_sd.safetensors dans ComfyUI
// ══════════════════════════════════════════════════════════════
async function comfyImg2Vid(imageUrl, motionPrompt, durationSec = 4, seed = null) {
  const actualSeed = seed || Math.floor(Math.random() * 2**32);

  // Vérifier si WAN2.2 est disponible dans ComfyUI
  let wanModel = null;
  try {
    const mr = await fetch(COMFY_URL + "/object_info/CheckpointLoaderSimple", { signal:AbortSignal.timeout(3000) });
    if (mr.ok) {
      const md = await mr.json();
      const ckpts = md?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      wanModel = ckpts.find(c => c.toLowerCase().includes("wan") && c.toLowerCase().includes("i2v"))
              || ckpts.find(c => c.toLowerCase().includes("wan"));
    }
  } catch(e) { console.warn("[Wan2.2]", e.message); }

  if (!wanModel) {
    throw new Error("Wan Video 2.2 non installé. Télécharger wan2.2_i2v_high_noise_14B_fp8_sd.safetensors dans ComfyUI/models/checkpoints/");
  }

  // Résoudre l'URL de l'image source en chemin local
  const imgPath = imageUrl.startsWith("/uploads/")
    ? path.join(UPLOADS_DIR, imageUrl.replace("/uploads/", ""))
    : imageUrl;
  if (!fs.existsSync(imgPath)) throw new Error("Image source introuvable: " + imgPath);

  // Upload l'image vers ComfyUI
  const imgBuffer = fs.readFileSync(imgPath);
  const imgB64 = imgBuffer.toString("base64");
  const uploadResp = await fetch(COMFY_URL + "/upload/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:image/png;base64,${imgB64}`, filename: "img2vid_src.png", overwrite: true })
  });
  if (!uploadResp.ok) throw new Error("Upload image ComfyUI failed");

  // Nombre de frames selon la durée (Wan2.2 génère ~24fps)
  const numFrames = Math.min(Math.max(Math.round(durationSec * 24), 16), 81);

  // Workflow ComfyUI pour WAN I2V
  const workflow = {
    "1": { "class_type": "CheckpointLoaderSimple",    "inputs": { "ckpt_name": wanModel } },
    "2": { "class_type": "CLIPTextEncode",            "inputs": { "text": motionPrompt, "clip": ["1", 1] } },
    "3": { "class_type": "CLIPTextEncode",            "inputs": { "text": "watermark, text, blurry, artifacts, static, frozen, still", "clip": ["1", 1] } },
    "4": { "class_type": "LoadImage",                 "inputs": { "image": "img2vid_src.png" } },
    "5": { "class_type": "ImageResize+",              "inputs": { "image": ["4", 0], "width": 832, "height": 480, "interpolation": "lanczos", "method": "fill/crop", "condition": "always", "multiple_of": 16 } },
    "6": { "class_type": "WanVideoSampler",           "inputs": {
      "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
      "image": ["5", 0], "num_frames": numFrames, "fps": 24,
      "steps": 20, "cfg": 6.0, "seed": actualSeed,
      "sampler_name": "euler", "scheduler": "karras"
    }},
    "7": { "class_type": "VHS_VideoCombine",          "inputs": {
      "images": ["6", 0], "frame_rate": 24, "loop_count": 0,
      "filename_prefix": "wan_clip", "format": "video/h264-mp4",
      "unique_id": actualSeed
    }}
  };

  // Soumettre à ComfyUI
  const queueResp = await fetch(COMFY_URL + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "elissia" })
  });
  if (!queueResp.ok) throw new Error("ComfyUI queue failed: " + queueResp.status);
  const queueData = await queueResp.json();
  const promptId = queueData.prompt_id;

  // Attendre la fin de génération (max 5 min)
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await new Promise(r => setTimeout(r, 3000));
    const histResp = await fetch(COMFY_URL + "/history/" + promptId);
    if (!histResp.ok) continue;
    const hist = await histResp.json();
    const job = hist[promptId];
    if (!job) continue;
    if (job.status?.completed) {
      // Récupérer la vidéo générée
      const outputs = Object.values(job.outputs || {});
      for (const out of outputs) {
        const vids = out.videos || out.gifs || [];
        if (vids.length > 0) {
          const vid = vids[0];
          // Télécharger depuis ComfyUI
          const vidResp = await fetch(`${COMFY_URL}/view?filename=${vid.filename}&subfolder=${vid.subfolder||""}&type=${vid.type||"output"}`);
          if (!vidResp.ok) throw new Error("Impossible de récupérer la vidéo");
          const vidBuf = Buffer.from(await vidResp.arrayBuffer());
          const outName = `wan_${Date.now()}.mp4`;
          const outPath = path.join(UPLOADS_DIR, outName);
          fs.writeFileSync(outPath, vidBuf);
          return "/uploads/" + outName;
        }
      }
    }
    if (job.status?.status_str === "error") throw new Error("ComfyUI erreur: " + JSON.stringify(job.status));
  }
  throw new Error("Timeout WAN2.2 (>5 min)");
}

// ══════════════════════════════════════════════════════════════
// MONTAGE NARRATIF : scénario → clips → MP4 final
// Le scénario est décomposé en étapes, chaque étape = 1 clip Wan2.2
// ══════════════════════════════════════════════════════════════
async function buildNarrativeVideo(companionProfiles, scenarioSteps, outputPath) {
  const clips = [];
  const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";

  for (let i = 0; i < scenarioSteps.length; i++) {
    const step = scenarioSteps[i];
    const comp = companionProfiles[step.companionIdx % companionProfiles.length];
    console.log(`[Narrative] Step ${i+1}/${scenarioSteps.length}: ${step.action.slice(0,60)}`);

    try {
      // Générer d'abord une frame de référence avec le profil exact du compagnon
      const framePrompt = buildComfyPromptFinal(comp.profile, step.style || "sensuelle")
        + ", " + step.action;
      const frameUrl = await comfyGenerateImage(framePrompt, step.style || "sensuelle", comp.seed + i);
      console.log(`[Narrative] Frame ${i+1} OK: ${frameUrl}`);

      // Générer le clip vidéo depuis cette frame
      const clipUrl = await comfyImg2Vid(frameUrl, step.action, step.duration || 4, comp.seed + i + 1000);
      const clipPath = path.join(UPLOADS_DIR, clipUrl.replace("/uploads/",""));
      if (fs.existsSync(clipPath)) {
        clips.push(clipPath);
        console.log(`[Narrative] Clip ${i+1} OK: ${clipUrl}`);
      }
    } catch(e) {
      console.warn(`[Narrative] Step ${i+1} erreur:`, e.message);
      // Si img2vid échoue (WAN pas installé), utiliser Ken Burns sur la frame
      try {
        const framePrompt = buildComfyPromptFinal(comp.profile, step.style || "sensuelle")
          + ", " + step.action;
        const frameUrl = await comfyGenerateImage(framePrompt, step.style || "sensuelle", comp.seed + i);
        const framePath = path.join(UPLOADS_DIR, frameUrl.replace("/uploads/",""));
        if (fs.existsSync(framePath)) {
          // Ken Burns fallback: 4s par clip
          const tempVid = path.join(UPLOADS_DIR, `temp_step_${i}_${Date.now()}.mp4`);
          await new Promise((res, rej) => {
            execFile(ffmpegBin, [
              "-y", "-loop", "1", "-t", String(step.duration || 4), "-i", framePath,
              "-vf", `scale=832:480:force_original_aspect_ratio=decrease,pad=832:480:(ow-iw)/2:(oh-ih)/2,fps=24,zoompan=z='min(zoom+0.001,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=832x480`,
              "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tempVid
            ], (err) => err ? rej(err) : res());
          });
          if (fs.existsSync(tempVid)) clips.push(tempVid);
          console.log(`[Narrative] Ken Burns fallback step ${i+1} OK`);
        }
      } catch(e2) { console.warn(`[Narrative] Fallback step ${i+1}:`, e2.message); }
    }
  }

  if (!clips.length) throw new Error("Aucun clip généré");

  // Concatener tous les clips en un seul MP4
  const listFile = outputPath + "_concat.txt";
    const concatLines = clips.map(c => "file " + JSON.stringify(c)).join("\n");
  fs.writeFileSync(listFile, concatLines);

  await new Promise((res, rej) => {
    execFile(ffmpegBin, [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outputPath
    ], (err) => {
      try { fs.unlinkSync(listFile); } catch {}
      err ? rej(new Error("ffmpeg concat: " + err.message)) : res();
    });
  });

  // Nettoyer les clips temporaires
  clips.filter(c => c.includes("temp_step_")).forEach(c => { try { fs.unlinkSync(c); } catch {} });

  return outputPath;
}

// ══════════════════════════════════════════════════════════════
// ROUTE : /api/generate/narrative-video
// Reçoit un scénario texte → Perplexity décompose en étapes
// → buildNarrativeVideo → MP4 final
// ══════════════════════════════════════════════════════════════
app.post("/api/generate/narrative-video", requireAuth, requireCsrf, rateLimit("genvid",2,3600000), async (req,res) => {
  try {
    const scenarioText = clean(req.body.scenarioText || req.body.scenarioContext || "", 3000);
    const companionIds = (req.body.companionIds || []).slice(0, 3);
    const targetDuration = Math.min(parseInt(req.body.duration) || 60, 180); // max 3 min

    if (!scenarioText) return res.status(400).json({ ok:false, error:"scenarioText requis" });
    if (!companionIds.length) return res.status(400).json({ ok:false, error:"Compagnons requis" });

    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) return res.status(503).json({ ok:false, error:"FFmpeg non disponible" });

    // 1️⃣ Charger les profils des compagnons
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const companions = [];
    for (const cid of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(cid, req.user.id);
      if (!cr) continue;
      const profile = parseJson(decryptText(cr.profile_enc), {});
      const lastPhoto = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(cid);
      const avatarUrl = cr.avatar_url_enc ? decryptText(cr.avatar_url_enc) : (lastPhoto ? decryptText(lastPhoto.url_enc) : null);
      companions.push({ id:cid, name:decryptText(cr.name_enc), persona:cr.persona, profile, avatarUrl, seed:parseInt(cr.avatar_seed)||Math.floor(Math.random()*2**32) });
    }
    if (!companions.length) return res.status(400).json({ ok:false, error:"Aucun compagnon trouvé" });

    // 2️⃣ Perplexity décompose le scénario en étapes narratives précises
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    let scenarioSteps = [];

    if (PERPLEXITY_KEY) {
      try {
        const compNames = companions.map((c,i) => `${i}:${c.name}(${c.persona})`).join(", ");
        const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${PERPLEXITY_KEY}`},
          body: JSON.stringify({
            model:"sonar",
            messages:[{
              role:"system",
              content:`You are a cinematic storyboard director. Break a French scene description into sequential video shots for AI image generation. Output ONLY valid JSON array, no other text. Each shot: {"companionIdx":0_or_1,"action":"detailed English motion prompt for Stable Diffusion, include pose body language expression setting","style":"sensuelle|nue|portrait|dominatrice|bdsm","duration":2_to_6}. Total duration should be ~${targetDuration} seconds. Focus on: specific body movements, facial expressions, spatial relationships between characters. Be explicit about physical actions if adult content. Companions: ${compNames}.`
            },{
              role:"user",
              content:`Scene (French): ${scenarioText}

Break this into ${Math.ceil(targetDuration/4)} shots (~4s each). Return ONLY the JSON array.`
            }],
            max_tokens:2000, temperature:0.8
          })
        });
        if (pxR.ok) {
          const pxD = await pxR.json();
          const content = pxD.choices?.[0]?.message?.content || "";
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
              scenarioSteps = parsed.slice(0, Math.ceil(targetDuration/3));
              console.log(`[NarrVideo] ${scenarioSteps.length} étapes Perplexity ✓`);
            }
          }
        }
      } catch(e) { console.warn("[NarrVideo] Perplexity:", e.message); }
    }

    // Fallback si Perplexity échoue
    if (!scenarioSteps.length) {
      const nSteps = Math.ceil(targetDuration / 4);
      for (let i = 0; i < nSteps; i++) {
        scenarioSteps.push({
          companionIdx: i % companions.length,
          action: scenarioText.slice(0, 200) + `, step ${i+1}, dynamic pose`,
          style: "sensuelle",
          duration: 4
        });
      }
    }

    // 3️⃣ Générer le montage
    const outName = `narrative_${req.user.id.slice(0,8)}_${Date.now()}.mp4`;
    const outPath = path.join(UPLOADS_DIR, outName);
    const vidUrl = "/uploads/" + outName;

    console.log(`[NarrVideo] Démarrage montage: ${scenarioSteps.length} étapes, ${companions.length} compagnons`);
    await buildNarrativeVideo(companions, scenarioSteps, outPath);

    // Sauvegarder en galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "narrative_video.mp4", "video/mp4", "ai_generated", "narrative", scenarioText.slice(0,200), now());
    } catch {}

    res.json({ ok:true, url:vidUrl, steps:scenarioSteps.length, companions:companions.map(c=>c.name) });

  } catch(e) {
    console.error("[NarrVideo]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// VIDER LA GALERIE — supprime tous les fichiers générés par l'IA
// ══════════════════════════════════════════════════════════════
app.post("/api/gallery/clear", requireAuth, requireCsrf, (req, res) => {
  try {
    // Récupérer toutes les photos IA de l'utilisateur
    const photos = db.prepare(
      "SELECT filename FROM media_library WHERE user_id=? AND source='ai_generated'"
    ).all(req.user.id);

    let deleted = 0;
    for (const p of photos) {
      // Supprimer le fichier physique
      const fname = p.filename.replace("/uploads/","").split("/").pop();
      const filePath = path.join(UPLOADS_DIR, fname);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); deleted++; } catch(e) { console.warn("[GalleryClear] file:", e.message); }
      }
    }

    // Supprimer les entrées en DB
    const dbResult = db.prepare("DELETE FROM media_library WHERE user_id=? AND source='ai_generated'").run(req.user.id);

    console.log(`[GalleryClear] ${req.user.id} → ${deleted} fichiers, ${dbResult.changes} DB entrées supprimées`);
    res.json({ ok:true, deleted, db_changes: dbResult.changes });
  } catch(e) {
    console.error("[GalleryClear]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/", (req,res) => res.redirect("/mobile"));

/* ═══ MULTI-COMPAGNONS v12 ═══ */
app.get("/api/companions/preview", requireAuth, (req,res) => {
  const rows = db.prepare("SELECT * FROM companions WHERE user_id=? ORDER BY sort_order ASC, created_at ASC").all(req.user.id);
  const companions = rows.map(c => {
    const lp = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(c.id);
    const avatarUrl = c.avatar_url_enc ? decryptText(c.avatar_url_enc) : (lp ? decryptText(lp.url_enc) : null);
    const mc = db.prepare("SELECT COUNT(*) c FROM messages WHERE user_id=? AND companion_id=?").get(req.user.id,c.id)?.c||0;
    return {id:c.id,name:decryptText(c.name_enc),persona:c.persona,profile:parseJson(decryptText(c.profile_enc),{}),
      avatarUrl,isActive:Boolean(c.is_active),sortOrder:c.sort_order,createdAt:c.created_at,messageCount:mc};
  });
  res.json({ok:true,companions});
});

app.post("/api/multi-chat", requireAuth, requireCsrf, rateLimit("chat",30,3600000), async (req,res) => {
  try {
    const message = clean(req.body.message||"",2000);
    const companionIds = (req.body.companionIds||[]).slice(0,4);
    const scenarioContext = clean(req.body.scenarioContext||"",500);
    if (!companionIds.length) return res.status(400).json({ok:false,error:"Aucun compagnon."});
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    res.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
    res.write(JSON.stringify({type:"start",companionCount:companionIds.length})+"\n");
    if (message) {
      for (const cid of companionIds) {
        try{db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id(),req.user.id,"user",encryptText(message),"user",cid,"multi",now());}catch{}
      }
    }
    for (const compId of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId,req.user.id);
      if (!cr) continue;
      const cn = decryptText(cr.name_enc);
      const cp = parseJson(decryptText(cr.profile_enc),{});
      const fu = {...freshUser,ai_name_enc:cr.name_enc,preferred_persona:cr.persona,extended_profile_enc:encryptText(JSON.stringify(cp))};
      const humanName = publicUser(freshUser).displayName || "l'utilisateur";
      const ancre = `\nTu es ${cn}, et UNIQUEMENT ${cn} : tu parles en ton seul nom, jamais à la place des autres personnages.`
        + `\nTu restes fidèle à TON caractère décrit ci-dessus : tu ne deviens jamais un autre personnage et tu n'adoptes pas le rôle d'un·e autre. Une copine reste une copine, un soumis reste soumis — chacun garde sa propre personnalité.`
        + `\nC'est une scène à plusieurs : tu peux interagir avec les autres compagnons présents, réagir à ce qu'ils disent et font, et décrire tes propres actions.`
        + `\n${humanName} dirige la scène et donne des consignes : prends ses consignes en compte et intègre-les à ton jeu.`;
      const ss = (scenarioContext?`\n[SCÈNE] ${scenarioContext}`:``) + ancre;
      const sys = buildSystemPrompt(fu,cr.persona,message,{})+ss;
      const lm = [{role:"system",content:sys},...recentMessages(req.user.id,compId,"multi"),{role:"user",content:message}];
      res.write(JSON.stringify({type:"companion_start",companionId:compId,companionName:cn})+"\n");
      let full="";
      try{full=await ollamaStream(lm,t=>res.write(JSON.stringify({type:"token",companionId:compId,companionName:cn,token:t})+"\n"));}
      catch(e){res.write(JSON.stringify({type:"companion_error",companionId:compId,error:e.message})+"\n");continue;}
      try{db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(),req.user.id,"assistant",encryptText(full),cr.persona,compId,"multi",now());}catch(e){console.warn("[multi-chat]",e.message);}
      res.write(JSON.stringify({type:"companion_done",companionId:compId,companionName:cn,reply:full})+"\n");
    }
    res.write(JSON.stringify({type:"done"})+"\n"); res.end();
  } catch(e){console.error("[multi-chat]",e.message);try{res.write(JSON.stringify({type:"error",error:e.message})+"\n");res.end();}catch{}}
});

/* ═══════════════════════════════════════
   DÉMARRAGE
═══════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n✨ ${APP_NAME} v9.0 — architecture modulaire + fixes portrait/Perplexity/trans`);
  console.log(`🌐 http://localhost:${PORT}/mobile`);
  console.log(`🤖 Mode : ${MODE==="cloud"?"CLOUD ("+CLOUD_MODEL+")":"LOCAL ("+OLLAMA_MODEL+")"}`);
  console.log(`🖼️  ComfyUI : ${COMFY_URL} / Modèle : ${COMFY_MODEL}`);
  console.log(`🔊 Piper   : ${process.env.PIPER_BIN?"✓ "+process.env.PIPER_BIN:"✗ désactivé"}`);
  console.log(`📅 Workflow perpétuel : ✓ actif\n`);
});