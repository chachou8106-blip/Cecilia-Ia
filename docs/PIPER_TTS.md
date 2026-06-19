# Piper TTS local

Piper permet une synthèse vocale **locale** plus naturelle que la voix du
navigateur. Optionnel : tant qu'il n'est pas configuré, l'app retombe sur la voix
navigateur.

Projet : https://github.com/rhasspy/piper

## 1. Télécharger

- le binaire Piper pour ton OS,
- un modèle vocal français `.onnx` (+ son `.json` associé s'il est fourni).

## 2. Configurer `.env`

Linux / macOS :

```env
PIPER_BIN=/home/alex/piper/piper
PIPER_MODEL=/home/alex/piper/voices/fr_FR-upmc-medium.onnx
PIPER_VOICE_NAME=Français local
```

Windows :

```env
PIPER_BIN=C:\\piper\\piper.exe
PIPER_MODEL=C:\\piper\\voices\\fr_FR-upmc-medium.onnx
PIPER_VOICE_NAME=Français local
```

## 3. Vérifier puis activer

```bash
npm run piper
npm run dev
```

Dans `/mobile` → onglet **Profil** → **Voix** → coche **Piper TTS local**.

## Comment ça marche

Le serveur expose :

- `GET /api/tts/piper/status` — indique si Piper est configuré
- `POST /api/tts/piper` — reçoit du texte, exécute Piper, renvoie un `audio/wav`

Le binaire est appelé via `spawnSync(PIPER_BIN, ["--model", PIPER_MODEL, "--output_file", tmp])`
avec le texte sur stdin. Le fichier temporaire est supprimé après lecture.
