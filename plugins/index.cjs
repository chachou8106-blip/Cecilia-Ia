const fs = require("fs");
const path = require("path");

const PLUGINS_DIR = __dirname;

function loadPlugins() {
  if (String(process.env.PLUGINS_ENABLED || "true") !== "true") {
    return [];
  }

  const files = fs.readdirSync(PLUGINS_DIR)
    .filter(f => f.endsWith(".plugin.cjs"))
    .sort();

  const plugins = [];

  for (const file of files) {
    const full = path.join(PLUGINS_DIR, file);
    try {
      delete require.cache[require.resolve(full)];
      const mod = require(full);

      if (mod && mod.id && mod.enabled !== false) {
        plugins.push({ file, ...mod });
      }
    } catch (err) {
      plugins.push({
        id: file,
        name: file,
        enabled: false,
        error: String(err.message || err)
      });
    }
  }

  return plugins;
}

async function runHook(hookName, context) {
  const plugins = loadPlugins();
  let merged = { ...context };

  for (const plugin of plugins) {
    if (!plugin || plugin.enabled === false) continue;
    if (typeof plugin[hookName] !== "function") continue;

    try {
      const result = await plugin[hookName](merged);

      if (result && result.block) {
        return { ...result, plugin: plugin.id };
      }

      if (result && typeof result === "object") {
        merged = { ...merged, ...result };
      }
    } catch (err) {
      console.error("[plugin error]", plugin.id, hookName, err);
    }
  }

  return merged;
}

function listPlugins() {
  return loadPlugins().map(p => ({
    id: p.id,
    name: p.name || p.id,
    description: p.description || "",
    version: p.version || "1.0.0",
    enabled: p.enabled !== false,
    hooks: ["beforeChat", "afterChat", "beforeRemember", "afterRemember"]
      .filter(h => typeof p[h] === "function"),
    error: p.error || null
  }));
}

module.exports = { runHook, listPlugins };
