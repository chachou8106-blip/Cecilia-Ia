require("dotenv").config();

const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const fs = require("fs");

const DB_PATH = process.env.DATABASE_PATH || "./data/app.sqlite";

function runBackup() {
  console.log("Maintenance: backup...");
  const r = spawnSync(process.execPath, ["scripts/backup.cjs"], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error("Backup échoué.");
}

function cleanDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.log("DB absente, nettoyage ignoré.");
    return;
  }

  console.log("Maintenance: nettoyage SQLite...");
  const db = new Database(DB_PATH);

  try { db.prepare("DELETE FROM sessions WHERE revoked_at IS NOT NULL").run(); } catch {}
  try { db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString()); } catch {}
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  try { db.exec("VACUUM"); } catch (err) { console.log("VACUUM ignoré:", err.message); }

  db.close();
}

function main() {
  runBackup();
  cleanDb();
  console.log("Maintenance terminée.");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
