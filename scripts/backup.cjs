require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DATABASE_PATH || "./data/app.sqlite";
const BACKUP_DIR = process.env.BACKUP_DIR || "./backups";
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 14);

const keyRaw = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "", "base64");
const ENC_KEY = keyRaw.length === 32
  ? keyRaw
  : crypto.createHash("sha256").update(String(process.env.BACKUP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "dev-backup-key")).digest();

function nowIso() { return new Date().toISOString(); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function encrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from("AIBAK1\n"),
    Buffer.from(iv.toString("base64") + "\n"),
    Buffer.from(tag.toString("base64") + "\n"),
    enc
  ]);
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    console.error("DB introuvable:", DB_PATH);
    process.exit(1);
  }

  const tmpDb = path.join(BACKUP_DIR, ".tmp-" + stamp() + ".sqlite");
  const db = new Database(DB_PATH, { readonly: true });
  await db.backup(tmpDb);
  db.close();

  const dbBuffer = fs.readFileSync(tmpDb);
  fs.unlinkSync(tmpDb);

  const payload = {
    version: "5.0.0",
    type: "petite-amie-ia-backup",
    createdAt: nowIso(),
    databasePath: DB_PATH,
    dbBase64: dbBuffer.toString("base64"),
    metadata: {
      app: process.env.APP_NAME || "Petite Amie IA",
      ollamaModel: process.env.OLLAMA_MODEL || "",
      embedModel: process.env.OLLAMA_EMBED_MODEL || ""
    }
  };

  const jsonBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const gz = zlib.gzipSync(jsonBuf, { level: 9 });
  const encrypted = encrypt(gz);

  const out = path.join(BACKUP_DIR, "backup-" + stamp() + ".aibak");
  fs.writeFileSync(out, encrypted);

  prune();
  console.log("Backup chiffré créé:", out);
}

function prune() {
  const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const ts = Date.now();

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith(".aibak"))
    .map(f => path.join(BACKUP_DIR, f));

  for (const file of files) {
    const st = fs.statSync(file);
    if (ts - st.mtimeMs > maxAgeMs) {
      fs.unlinkSync(file);
      console.log("Ancien backup supprimé:", file);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
