// plugins.js — moteur de plugins Élissia (stub minimal)
// Permet d'étendre Élissia via des hooks beforeChat / afterChat

"use strict";

const plugins = new Map();

/**
 * Enregistrer un plugin
 * @param {string} name - nom du plugin
 * @param {object} hooks - { beforeChat, afterChat }
 */
function registerPlugin(name, hooks = {}) {
  plugins.set(name, hooks);
  console.log(`[plugins] Plugin "${name}" enregistré`);
}

/**
 * Exécuter un hook sur tous les plugins actifs
 * @param {string} hookName - "beforeChat" | "afterChat"
 * @param {object} context - contexte passé au hook
 * @returns {object|null} - résultat fusionné ou null
 */
async function runHook(hookName, context = {}) {
  const results = [];
  for (const [name, plugin] of plugins) {
    if (typeof plugin[hookName] === "function") {
      try {
        const result = await plugin[hookName](context);
        if (result) results.push(result);
      } catch (e) {
        console.error(`[plugins] Erreur hook "${hookName}" dans "${name}":`, e.message);
      }
    }
  }
  if (results.length === 0) return null;
  // Fusionner les résultats
  return Object.assign({}, ...results);
}

/**
 * Lister les plugins actifs
 */
function listPlugins() {
  return Array.from(plugins.keys()).map(name => ({
    name,
    hooks: Object.keys(plugins.get(name) || {})
  }));
}

module.exports = { registerPlugin, runHook, listPlugins };
