// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — comfy_gen.js : comfyGenerateImage, GIF, vidéo
// ═══════════════════════════════════════════════════════════════
const { COMFY_URL, COMFY_MODEL, UPLOADS_DIR } = require('./db');
const { buildComfyPrompt, buildComfyPromptFinal } = require('./comfy_build');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
async function comfyGenerateImage(prompt, style, seed) {
  // ✅ v15 — Détecte automatiquement le meilleur modèle disponible
  // Ordre de priorité : SDXL réaliste (Juggernaut, RealVis, etc.) > Z Image Turbo
  const actualSeed = seed || Math.floor(Math.random() * 2**32);

  // Lister les modèles disponibles
  let checkpointModel = null;  // SDXL checkpoint (Juggernaut, RealVis, Pony...)
  let unetModel = null;        // Z Image Turbo UNET

  try {
    const mr = await fetch(COMFY_URL + "/object_info/CheckpointLoaderSimple", { signal: AbortSignal.timeout(3000) });
    if (mr.ok) {
      const mdata = await mr.json();
      const checkpoints = mdata?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      // Priorité : modèles photo-réalistes NSFW > Pony > autres
      const PREF_CKPT = ["juggernaut","realvis","cyberrealistic","epicrealism","realdream","perfectworld","dreamshaper","photon","pony"];
      for (const pref of PREF_CKPT) {
        const found = checkpoints.find(c => c.toLowerCase().includes(pref));
        if (found) { checkpointModel = found; console.log("[ComfyUI] ✅ Modèle SDXL sélectionné:", found); break; }
      }
    }
  } catch {}

  // ══ WORKFLOW SDXL — si un checkpoint réaliste est disponible ══════════
  if (checkpointModel) {
    const isPony = checkpointModel.toLowerCase().includes("pony");

    // Prompt adapté au modèle
    let positivePrompt = prompt;
    if (!isPony) {
      // ✅ v17 — Juggernaut Ragnarok : ajouter tokens photorealism (RAW, natural skin)
      const transPhotoTokens = positivePrompt.toLowerCase().includes("transgender") || positivePrompt.toLowerCase().includes("trans woman")
        ? ", vagina:0, vulva:0, female genitalia:0"  // forcer pas de vulve
        : "";
      positivePrompt = "RAW photo, photorealistic, realistic skin texture, skin pores, natural photography, DSLR, " + positivePrompt + transPhotoTokens;
    }
    if (isPony) {
      // ✅ v16 — Tags Pony corrects pour photo réaliste + anatomie trans
      // source_real = données photo réelles (pas anime)
      // Détection trans pour utiliser les tags futa de Pony
      const isTransPrompt = prompt.toLowerCase().includes("transgender") || prompt.toLowerCase().includes("trans woman") || prompt.toLowerCase().includes("phalloplasty");
      const transPonyTag = isTransPrompt
        ? ", futanari, futa, 1girl, female body with penis, erect cock, large penis between legs, cock at groin, "
        : ", 1girl, ";
      positivePrompt = "score_9, score_8_up, score_7_up, score_6_up, source_real, realistic, photorealistic, rating_explicit" + transPonyTag + prompt;
    }

    // ✅ v12 — Négatifs adaptatifs : ne pas bloquer l'anatomie demandée
    const wantsFemAnatomy = /vagina|vulva|pussy|labia|clitoris|pubic/i.test(prompt);
    const wantsMascAnatomy = /penis|cock|phallus|erect|foreskin|scrotum/i.test(prompt);
    const wantsBoth = wantsFemAnatomy && wantsMascAnatomy;
    const wantsToys = /dildo|vibrator|plug|strap.on|wand|rope|bondage|handcuff|crop|whip/i.test(prompt);
    let ponyNeg = "score_1, score_2, score_3, score_4, source_cartoon, source_anime, child, minor, underage";
    if (!wantsFemAnatomy && !wantsBoth) ponyNeg += ", vagina, vulva, female genitalia, labia, clitoris";
    if (!wantsMascAnatomy && !wantsBoth) ponyNeg += ", penis, cock, erection, phallus";
    let sdxlNeg = "(worst quality, low quality:1.4), ugly, deformed, watermark, text, signature, child, minor, underage, bad anatomy, extra limbs, cgi, airbrushed, plastic skin, blurry, overexposed";
    if (!wantsFemAnatomy && !wantsBoth) sdxlNeg += ", vagina, vulva, female genitalia, labia";
    if (!wantsMascAnatomy && !wantsBoth) sdxlNeg += ", penis, erection, cock, phallus";
    if (!wantsToys) sdxlNeg += ", dildo, sex toy, object in hand";
    const negativePrompt = isPony ? ponyNeg : sdxlNeg;

    const sdxlWorkflow = {
      "4": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": checkpointModel } },
      "6": { "class_type": "CLIPTextEncode", "inputs": { "text": positivePrompt, "clip": ["4", 1] } },
      "7": { "class_type": "CLIPTextEncode", "inputs": { "text": negativePrompt, "clip": ["4", 1] } },
      "5": { "class_type": "EmptyLatentImage", "inputs": { "width": 832, "height": 1216, "batch_size": 1 } },
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0],
          "latent_image": ["5", 0], "seed": actualSeed,
          "steps": isPony ? 30 : 30,  // 30 steps pour meilleure qualité
          "cfg": isPony ? 7 : 7,  // CFG 7 = moins anime, plus réaliste
          "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "denoise": 1.0
        }
      },
      "8": { "class_type": "VAEDecode", "inputs": { "samples": ["3", 0], "vae": ["4", 2] } },
      "9": { "class_type": "SaveImage", "inputs": { "images": ["8", 0], "filename_prefix": "elissia_sdxl" } }
    };

    return await _submitComfyWorkflow(sdxlWorkflow, actualSeed);
  }

  // ══ WORKFLOW Z IMAGE TURBO (Lumina) — fallback si pas de SDXL ═════════
  // ⚠️  CFG=1 + ConditioningZeroOut = négatifs IGNORÉS. Contrôle uniquement par prompt positif.
  // Source: https://docs.comfy.org/tutorials/image/z-image/z-image-turbo
  const workflow = {
    "28": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "z_image_turbo_bf16.safetensors",
        "weight_dtype": "default"
      }
    },
    "30": {
      "class_type": "CLIPLoader",
      "inputs": {
        "clip_name": "qwen_3_4b.safetensors",
        "type": "lumina2",
        "device": "default"
      }
    },
    "29": {
      "class_type": "VAELoader",
      "inputs": {
        "vae_name": "ae.safetensors"
      }
    },
    "27": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "clip": ["30", 0],
        "text": prompt
      }
    },
    "33": {
      "class_type": "ConditioningZeroOut",
      "inputs": {
        "conditioning": ["27", 0]
      }
    },
    "13": {
      "class_type": "EmptySD3LatentImage",
      "inputs": {
        "width": 768,
        "height": 1024,
        "batch_size": 1
      }
    },
    "11": {
      "class_type": "ModelSamplingAuraFlow",
      "inputs": {
        "model": ["28", 0],
        "shift": 3.0
      }
    },
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "model": ["11", 0],
        "positive": ["27", 0],
        "negative": ["33", 0],
        "latent_image": ["13", 0],
        "seed": actualSeed,
        "steps": 12,  // v14: plus de steps pour détail anatomique
        "cfg": 1,
        "sampler_name": "res_multistep",
        "scheduler": "simple",
        "denoise": 1
      }
    },
    "8": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["3", 0],
        "vae": ["29", 0]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "images": ["8", 0],
        "filename_prefix": "elissia"
      }
    }
  };

  // Vérifier que le VAE ae.safetensors est disponible
  try {
    const vaeR = await fetch(`${COMFY_URL}/object_info/VAELoader`);
    if (vaeR.ok) {
      const vaeInfo = await vaeR.json();
      const vaes = vaeInfo?.VAELoader?.input?.required?.vae_name?.[0] || [];
      if (!vaes.includes("ae.safetensors")) {
        console.warn(`[ComfyUI] VAE ae.safetensors non trouvé. VAEs disponibles: ${vaes.join(", ")}`);
        // Utiliser le premier VAE dispo si ae.safetensors manque
        if (vaes.length > 0) {
          workflow["29"].inputs.vae_name = vaes[0];
          console.log(`[ComfyUI] Utilisation du VAE: ${vaes[0]}`);
        }
      }
    }
  } catch(e) { /* silencieux */ }

  // Vérifier que le CLIP qwen_3_4b est disponible
  try {
    const clipR = await fetch(`${COMFY_URL}/object_info/CLIPLoader`);
    if (clipR.ok) {
      const clipInfo = await clipR.json();
      const clips = clipInfo?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
      const normalize = s => s.replace(/-/g,'_').toLowerCase();
      const qwenMatch = clips.find(c => normalize(c).includes('qwen'));
      if (qwenMatch) {
        workflow["30"].inputs.clip_name = qwenMatch;
        console.log(`[ComfyUI] CLIP trouvé: ${qwenMatch}`);
      } else {
        console.warn(`[ComfyUI] qwen non trouvé dans: ${clips.join(", ")}`);
      }
    }
  } catch(e) { /* silencieux */ }

  // Vérifier que z_image_turbo est dans diffusion_models
  try {
    const unetR = await fetch(`${COMFY_URL}/object_info/UNETLoader`);
    if (unetR.ok) {
      const unetInfo = await unetR.json();
      const unets = unetInfo?.UNETLoader?.input?.required?.unet_name?.[0] || [];
      const normalize = s => s.replace(/-/g,'_').toLowerCase();
      const zMatch = unets.find(u => normalize(u).includes('z_image_turbo'));
      if (zMatch) {
        // ✅ v14 : préférer un modèle NSFW réaliste si disponible
        const modelToUse = altModelFound || zMatch;
        workflow["28"].inputs.unet_name = modelToUse;
        if (altModelFound) console.log("[ComfyUI] Utilisation modèle NSFW:", modelToUse);
        console.log(`[ComfyUI] UNET trouvé: ${zMatch}`);
      } else {
        console.warn(`[ComfyUI] z_image_turbo non trouvé dans UNETLoader. Disponibles: ${unets.join(", ")}`);
        throw new Error(`z_image_turbo_bf16.safetensors doit être dans diffusion_models/, pas checkpoints/. Déplace-le dans C:\\Users\\laure\\ComfyUI-Shared\\models\\diffusion_models\\`);
      }
    }
  } catch(e) {
    if (e.message.includes('diffusion_models')) throw e;
    /* silencieux pour les autres erreurs */
  }

  // Soumettre le workflow
  return await _submitComfyWorkflow(workflow, actualSeed);
}

// ══ Soumission et polling ComfyUI (partagé entre SDXL et Z Image Turbo) ══
async function _submitComfyWorkflow(workflow, actualSeed) {
  const submitR = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "elissia" })
  });

  if (!submitR.ok) {
    const err = await submitR.text().catch(() => "");
    throw new Error(`ComfyUI erreur ${submitR.status}: ${err.slice(0, 300)}`);
  }

  const submitData = await submitR.json();
  const prompt_id = submitData.prompt_id;
  if (!prompt_id) throw new Error("ComfyUI n'a pas retourné de prompt_id");
  console.log(`[ComfyUI] Job soumis: ${prompt_id}`);

  // Polling toutes les 2s jusqu'à l'image (max 3 min)
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const histR = await fetch(`${COMFY_URL}/history/${prompt_id}`);
    if (!histR.ok) continue;
    const hist = await histR.json();
    const entry = hist[prompt_id];
    if (!entry) continue;

    if (entry.status?.status_str === "error") {
      const msgs = (entry.status?.messages || []).map(m => JSON.stringify(m)).join("; ");
      throw new Error(`ComfyUI erreur exécution: ${msgs.slice(0, 300)}`);
    }

    const outputs = entry.outputs || {};
    for (const nodeOutputs of Object.values(outputs)) {
      for (const img of (nodeOutputs.images || [])) {
        if (!img.filename) continue;
        const imgUrl = `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${img.subfolder || ""}&type=${img.type || "output"}`;
        console.log(`[ComfyUI] ✓ Image générée: ${img.filename}`);
        return await downloadToUploads(imgUrl);
      }
    }
  }
  throw new Error("ComfyUI timeout (3 min) — vérifie que ComfyUI Desktop est bien lancé");
}

/* ═══════════════════════════════════════════════════════════════
   ✅ NOUVEAU v9 — AVATAR ANIMÉ GIF via FFmpeg
   Génère N images du MÊME personnage (seed de base + micro-variations)
   puis les assemble en GIF animé avec un effet de boucle douce.
═══════════════════════════════════════════════════════════════ */
const { execFile } = require("child_process");

// Vérifie si ffmpeg est disponible — cherche dans PATH puis chemins Windows courants
function ffmpegAvailable() {
  return new Promise((resolve) => {
    // Stratégie 1 : @ffmpeg-installer (bundle NPM)
    try {
      const installer = require("@ffmpeg-installer/ffmpeg");
      if (installer.path && fs.existsSync(installer.path)) {
        const binDir = path.dirname(installer.path);
        const sep = process.platform === "win32" ? ";" : ":";
        if (!(process.env.PATH || "").includes(binDir))
          process.env.PATH = binDir + sep + (process.env.PATH || "");
        process.env.FFMPEG_PATH = installer.path;
        return resolve(true);
      }
    } catch {}
    // Stratégie 2 : PATH système
    execFile("ffmpeg", ["-version"], (err) => {
      if (!err) return resolve(true);
      // Stratégie 3 : Chemins Windows courants
      if (process.platform === "win32") {
        const candidates = [
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA||"","Microsoft","WinGet","Packages","Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe","ffmpeg-full","bin","ffmpeg.exe"),
          path.join(process.env.USERPROFILE||"","scoop","shims","ffmpeg.exe")
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            process.env.PATH = path.dirname(c) + ";" + (process.env.PATH || "");
            process.env.FFMPEG_PATH = c;
            return resolve(true);
          }
        }
      }
      resolve(false);
    });
  });
}

// ✅ v11 — Assemble des frames PNG en vidéo MP4 (Ken Burns + fondu)
// Remplace l'ancien assembleGif. Génère un fichier .mp4 de qualité avec effet zoom.
function assembleMP4(framePaths, outPath, fps = 24) {
  return new Promise((resolve, reject) => {
    const listFile = outPath + "_list.txt";
    // Durée par frame : on pingpong pour une boucle douce aller-retour
    const ordered = [...framePaths, ...framePaths.slice(1, -1).reverse()];
    // ✅ v13 : durée min 1.5s par frame pour vidéo de 8-10 secondes
    const durPerFrame = Math.max(1.5, (1 / (fps / 6))).toFixed(3);
    const lines = ordered.map(f => `file '${f.replace(/'/g, "'\\''")}'
duration ${durPerFrame}`).join("\n")
      + `\nfile '${ordered[ordered.length-1].replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(listFile, lines);

    const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";

    // Ken Burns : zoom lent de 1.0 → 1.08 + encode H264 compatible navigateur
    execFile(ffmpegBin, [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", [
        "scale=512:768:force_original_aspect_ratio=decrease",
        "pad=512:768:(ow-iw)/2:(oh-ih)/2",
        `fps=${fps}`,
        "zoompan=z='min(zoom+0.0008,1.08)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=512x768"
      ].join(","),
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "22",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      outPath
    ], (err) => {
      try { fs.existsSync(listFile) && fs.unlinkSync(listFile); } catch {}
      if (err) return reject(new Error("ffmpeg mp4: " + err.message));
      resolve(outPath);
    });
  });
}

// ✅ v11 — Génère un avatar animé MP4 (Ken Burns) à partir du profil
async function generateAnimatedAvatarGif(ext, userId, frames = 6) {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error("FFmpeg introuvable — lance : npm install @ffmpeg-installer/ffmpeg fluent-ffmpeg et redémarre");
  }

  const nFrames = Math.max(3, Math.min(parseInt(frames) || 6, 8));
  const baseSeed = getAvatarSeed(ext);
  const basePrompt = personality.buildAvatarPromptFromProfile(ext);

  const expressions = [
    "neutral soft expression, looking at camera",
    "subtle warm smile, looking at camera",
    "warm genuine smile, slight head tilt",
    "soft sensual gaze, lips slightly parted",
    "playful expression, looking at camera",
    "tender romantic look, slight smile",
    "confident direct gaze, chin up",
    "calm serene expression, eyes half closed"
  ];

  const localFrames = [];
  for (let i = 0; i < nFrames; i++) {
    const seed = baseSeed + i;
    const prompt = basePrompt + ", " + expressions[i % expressions.length] + ", consistent same face, same person";
    console.log(`[VideoAvatar] Frame ${i + 1}/${nFrames} (seed ${seed})`);
    const url = await comfyGenerateImage(prompt, "portrait", seed);
    const abs = url.startsWith("/uploads/")
      ? path.join(UPLOADS_DIR, url.replace("/uploads/", ""))
      : url;
    if (fs.existsSync(abs)) localFrames.push(abs);
  }

  if (localFrames.length < 2) {
    throw new Error("Pas assez de frames générées (ComfyUI a échoué sur certaines)");
  }

  // ✅ Générer MP4 au lieu de GIF
  const vidName = "avatar_anim_" + userId + "_" + Date.now() + ".mp4";
  const vidPath = path.join(UPLOADS_DIR, vidName);
  await assembleMP4(localFrames, vidPath, 24);

  return "/uploads/" + vidName;
}

// ✅ v12 — Génération vidéo depuis chat context via FFmpeg + ComfyUI
