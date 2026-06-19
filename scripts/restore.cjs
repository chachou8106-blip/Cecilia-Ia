require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const DB_PATH = process.env.DATABASE_PATH || "./data/app.sqlite";

const keyRaw = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "", "base64");
const ENC_KEY = keyRaw.length === 32
  ? keyRaw
  : crypto.createHash("sha256").update(String(process.env.BACKUP_ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY || "dev-backup-key")).digest();

function decrypt(fileBuffer) {
  const marker = Buffer.from("AIBAK1\n");
  if (!fileBuffer.subarray(0, marker.length).equals(marker)) {
    throw new Error("Format backup invalide.");
  }

  const rest = fileBuffer.subarray(marker.length);
  const firstNl = rest.indexOf(10);
  const ivB64 = rest.subarray(0, firstNl).toString("utf8");

  const rest2 = rest.subarray(firstNl + 1);
  const secondNl = rest2.indexOf(10);
  const tagB64 = rest2.subarray(0, secondNl).toString("utf8");

  const enc = rest2.subarray(secondNl + 1);

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function main() {
  const file = process.argv[2];

  if (!file) {
    console.error("Usage: node scripts/restore.cjs backups/backup-xxxx.aibak");
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error("Fichier introuvable:", file);
    process.exit(1);
  }

  const encrypted = fs.readFileSync(file);
  const gz = decrypt(encrypted);
  const jsonStr = zlib.gunzipSync(gz).toString("utf8");
  const payload = JSON.parse(jsonStr);

  if (!payload.dbBase64) {
    throw new Error("Backup invalide: dbBase64 absent.");
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const safety = DB_PATH + ".before-restore-" + new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(DB_PATH, safety);
    console.log("Copie de sécurité créée:", safety);
  }

  fs.writeFileSync(DB_PATH, Buffer.from(payload.dbBase64, "base64"));

  console.log("Restauration terminée vers:", DB_PATH);
  console.log("Redémarre l'application.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
