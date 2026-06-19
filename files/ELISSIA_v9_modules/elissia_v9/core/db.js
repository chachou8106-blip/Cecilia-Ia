// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — db.js : Config, DB SQLite, migrations, crypto, utils
// ═══════════════════════════════════════════════════════════════
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

