require("dotenv").config();

const fs = require("fs");
const http = require("http");

const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail: detail || "" });
}

function fileExists(file) {
  return fs.existsSync(file);
}

async function httpGet(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
    });
    req.on("error", err => resolve({ ok: false, status: 0, body: err.message }));
    req.setTimeout(4000, () => { req.destroy(); resolve({ ok: false, status: 0, body: "timeout" }); });
  });
}

async function main() {
  check(".env présent", fileExists(".env"));
  check("server.js présent", fileExists("server.js"));
  check("package.json présent", fileExists("package.json"));
  check("APP_ENCRYPTION_KEY configurée", Boolean(process.env.APP_ENCRYPTION_KEY));
  check("BACKUP_ENCRYPTION_KEY configurée", Boolean(process.env.BACKUP_ENCRYPTION_KEY));
  check("AUDIT_SECRET configuré", Boolean(process.env.AUDIT_SECRET));

  const app = await httpGet("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/health");
  check("App HTTP /api/health", app.ok, app.body.slice(0, 120));

  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const ollama = await httpGet(ollamaUrl.replace(/\/$/, "") + "/api/tags");
  check("Ollama accessible", ollama.ok, ollama.body.slice(0, 120));

  console.log("");
  console.log("Diagnostic");
  console.log("----------");

  for (const c of checks) {
    console.log((c.ok ? "OK " : "XX ") + c.name + (c.detail ? " — " + c.detail : ""));
  }

  const failed = checks.filter(c => !c.ok).length;
  console.log("");
  console.log(failed ? failed + " problème(s) détecté(s)." : "Tout semble OK.");
  process.exit(failed ? 1 : 0);
}

main();
