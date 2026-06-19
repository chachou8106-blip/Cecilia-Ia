require("dotenv").config();

const fs = require("fs");

const bin = process.env.PIPER_BIN || "";
const model = process.env.PIPER_MODEL || "";

console.log("");
console.log("Piper TTS check");
console.log("---------------");
console.log("PIPER_BIN:", bin || "(non défini)");
console.log("PIPER_MODEL:", model || "(non défini)");
console.log("PIPER_VOICE_NAME:", process.env.PIPER_VOICE_NAME || "Piper local");

let ok = true;

if (!bin || !fs.existsSync(bin)) {
  console.log("XX Piper binary introuvable.");
  ok = false;
} else {
  console.log("OK Piper binary trouvé.");
}

if (!model || !fs.existsSync(model)) {
  console.log("XX Modèle Piper introuvable.");
  ok = false;
} else {
  console.log("OK Modèle Piper trouvé.");
}

console.log("");

if (!ok) {
  console.log("Configure .env :");
  console.log("PIPER_BIN=/chemin/vers/piper");
  console.log("PIPER_MODEL=/chemin/vers/voix.onnx");
  process.exit(1);
}

console.log("Piper semble configuré.");
