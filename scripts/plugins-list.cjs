require("dotenv").config();

const plugins = require("../plugins");

console.log("");
console.log("Plugins");
console.log("-------");

for (const p of plugins.listPlugins()) {
  console.log((p.enabled ? "OK " : "XX ") + p.id + " — " + p.name);
  if (p.description) console.log("   " + p.description);
  if (p.hooks && p.hooks.length) console.log("   hooks: " + p.hooks.join(", "));
  if (p.error) console.log("   erreur: " + p.error);
}

console.log("");
