// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — routes/extras.js : websearch, messages, scene-video, multi-chat
// ═══════════════════════════════════════════════════════════════
  const msg = db.prepare("SELECT * FROM messages WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
  if (!msg) return res.status(404).json({ ok:false, error:"Message introuvable" });
  
  // Si le message a une photo, ne pas supprimer le fichier (il peut être en galerie)
  // Juste supprimer le message de la DB
  db.prepare("DELETE FROM messages WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  
  res.json({ ok:true, deleted:req.params.id });
});

// SUPPRESSION D'UNE PHOTO DE LA GALERIE (sans casser le chat)
app.delete("/api/gallery/:filename", requireAuth, requireCsrf, (req,res) => {
  try {
    const fname = req.params.filename;
    if (!fname || fname.includes("..")) return res.status(400).json({ ok:false, error:"Nom invalide" });
    
    // Supprimer de la DB
    db.prepare("DELETE FROM media_library WHERE user_id=? AND (filename=? OR filename=?)").run(
      req.user.id, fname, "/uploads/" + fname
    );
    
    // Supprimer le fichier (optionnel — si pas référencé ailleurs)
    const filePath = path.join(UPLOADS_DIR, fname.replace("/uploads/",""));
    if (fs.existsSync(filePath)) {
      // Vérifier si le fichier est encore référencé dans des messages
      const refs = db.prepare("SELECT COUNT(*) c FROM messages WHERE user_id=? AND media_url LIKE ?").get(req.user.id, "%" + fname + "%");
      if (!refs?.c) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    
    res.json({ ok:true, deleted:fname });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SCÈNE VIDÉO MULTI-PERSONNAGES — Perplexity enrichit le prompt
// ══════════════════════════════════════════════════════════════
app.post("/api/generate/scene-video", requireAuth, requireCsrf, rateLimit("genvid",3,3600000), async (req,res) => {
  try {
    const freshUser    = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const adultMode    = Boolean(freshUser.adult_mode);
    const scenarioCtx  = clean(req.body.scenarioContext || "", 2000);
    const companionIds = (req.body.companionIds || []).slice(0, 3);
    const style        = clean(req.body.style || "sensuelle", 30);
    if (!scenarioCtx)       return res.status(400).json({ ok:false, error:"scenarioContext requis" });
    if (!companionIds.length) return res.status(400).json({ ok:false, error:"Aucun compagnon" });

    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) return res.status(503).json({ ok:false, error:"FFmpeg non disponible" });

    // 1️⃣ Perplexity ENRICHIT le prompt (améliore le scénario utilisateur)
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    let videoPrompt = "";
    if (PERPLEXITY_KEY) {
      try {
        const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${PERPLEXITY_KEY}`},
          body: JSON.stringify({
            model:"sonar",
            messages:[
              { role:"system", content:"You are an expert Stable Diffusion prompt engineer for photorealistic adult AI image generation using Juggernaut XL. Given a scene description in French, create a highly optimized English Stable Diffusion prompt. Requirements: describe the exact pose and action, physical details of the scene, setting/environment, lighting, mood, level of nudity or explicitness. Be very specific and vivid. Max 4 sentences, English only. No preamble." },
              { role:"user", content:`Scene description (French): ${scenarioCtx.slice(0,1000)}

Create an optimized Stable Diffusion XL prompt for this exact scene. Include: pose, action, setting, lighting. Style: ${style}. Be explicit if adult content is described.` }
            ],
            max_tokens:300, temperature:0.8
          })
        });
        if (pxR.ok) {
          const pxD = await pxR.json();
          videoPrompt = pxD.choices?.[0]?.message?.content?.trim() || "";
          console.log("[SceneVideo] Perplexity prompt généré:", videoPrompt.slice(0,120));
        }
      } catch(e) { console.warn("[SceneVideo] Perplexity:", e.message); }
    }

    // 2️⃣ Profils + dernières photos des compagnons
    const companions = [];
    for (const cid of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(cid, req.user.id);
      if (!cr) continue;
      const profile   = parseJson(decryptText(cr.profile_enc), {});
      const lastPhoto = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(cid);
      const avatarUrl = cr.avatar_url_enc ? decryptText(cr.avatar_url_enc) : (lastPhoto ? decryptText(lastPhoto.url_enc) : null);
      companions.push({
        id: cid, name: decryptText(cr.name_enc), persona: cr.persona, profile, avatarUrl,
        seed: parseInt(cr.avatar_seed) || Math.floor(Math.random() * 2**32)
      });
    }
    if (!companions.length) return res.status(400).json({ ok:false, error:"Aucun compagnon trouvé" });

    // 3️⃣ Générer frames pour chaque personnage
    const allFrames = [];
    const frameCount = companions.length === 1 ? 6 : 4;

    for (const comp of companions) {
      const basePrompt = buildComfyPromptFinal(comp.profile, style);
      const sceneAdd   = videoPrompt || scenarioCtx.slice(0,200);

      const expressions = [
        "standing confident looking at camera, full body shot",
        "seductive pose showing body, hands on hips",
        "bending forward, dominant powerful pose",
        "turning to show curves, looking back over shoulder",
        "close intimate pose reaching toward camera",
        "sitting or kneeling, submissive pose"
      ].slice(0, frameCount);

      for (let i = 0; i < frameCount; i++) {
        try {
          const framePrompt = `${basePrompt}, ${expressions[i]}, ${sceneAdd.slice(0,180)}`;
          const url = await comfyGenerateImage(framePrompt, style, comp.seed + i);
          const abs = url.startsWith("/uploads/")
            ? path.join(UPLOADS_DIR, url.replace("/uploads/", ""))
            : path.join(UPLOADS_DIR, url.split("/").pop());
          if (fs.existsSync(abs)) { allFrames.push(abs); console.log(`[SceneVideo] ${comp.name} frame ${i+1}/${frameCount} ✓`); }
        } catch(e) { console.warn(`[SceneVideo] frame ${comp.name} ${i}:`, e.message); }
      }
    }

    if (allFrames.length < 2) return res.status(500).json({ ok:false, error:"Pas assez de frames ("+allFrames.length+")" });

    // 4️⃣ Assembler MP4
    const vidName = `scene_${req.user.id.slice(0,8)}_${Date.now()}.mp4`;
    const vidPath = path.join(UPLOADS_DIR, vidName);
    const fps = companions.length === 1 ? 18 : 22;
    await assembleMP4(allFrames, vidPath, fps);
    const vidUrl = "/uploads/" + vidName;

    // 5️⃣ Sauvegarder en galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "scene_video.mp4", "video/mp4", "ai_generated", "scene_multi", scenarioCtx.slice(0,200), now());
    } catch {}

    res.json({
      ok:true, url:vidUrl, video_url:vidUrl,
      frames:allFrames.length, companions:companions.map(c=>c.name),
      prompt_perplexity:videoPrompt.slice(0,200),
      prompt_enriched: videoPrompt.length > 0
    });
  } catch(e) {
    console.error("[SceneVideo]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// AVATAR COMPAGNON — sauvegarder la photo d'UN compagnon
// ══════════════════════════════════════════════════════════════
app.post("/api/companions/:id/avatar", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  const comp = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!comp) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });

  const url = req.body.url || req.body.avatar;
  if (!url) return res.status(400).json({ ok:false, error:"url requis" });

  // Sauvegarder comme avatar du compagnon (pas du user principal)
  db.prepare("UPDATE companions SET avatar_url_enc=?, updated_at=? WHERE id=?")
    .run(encryptText(url), now(), compId);

  // Ajouter à la galerie photos du compagnon si pas déjà présent
  try {
    const exists = db.prepare("SELECT id FROM companion_photos WHERE companion_id=? AND url_enc=?")
      .get(compId, encryptText(url));
    if (!exists) {
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,style,created_at) VALUES(?,?,?,?,?,?)")
        .run(id(), compId, req.user.id, encryptText(url), "portrait", now());
    }
  } catch(e) { console.warn("[companion/avatar]", e.message); }

  console.log(`[CompAvatar] ${decryptText(comp.name_enc)} → ${url.slice(-20)}`);
  res.json({ ok:true, url, companionId:compId });
});

// Route GET : récupérer l'avatar actuel d'un compagnon
app.get("/api/companions/:id/avatar", requireAuth, (req, res) => {
  const compId = clean(req.params.id, 80);
  const comp = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!comp) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });
  const avatarUrl = comp.avatar_url_enc ? decryptText(comp.avatar_url_enc) : null;
  res.json({ ok:true, url:avatarUrl, companionId:compId });
});

// ══════════════════════════════════════════════════════════════
// WAN VIDEO 2.2 — img2vid : image source → clip vidéo fluide
// Déclenché par /api/generate/img2vid
// Nécessite : wan2.2_i2v_high_noise_14B_fp8_sd.safetensors dans ComfyUI
// ══════════════════════════════════════════════════════════════
async function comfyImg2Vid(imageUrl, motionPrompt, durationSec = 4, seed = null) {
  const actualSeed = seed || Math.floor(Math.random() * 2**32);

  // Vérifier si WAN2.2 est disponible dans ComfyUI
  let wanModel = null;
  try {
    const mr = await fetch(COMFY_URL + "/object_info/CheckpointLoaderSimple", { signal:AbortSignal.timeout(3000) });
    if (mr.ok) {
      const md = await mr.json();
      const ckpts = md?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
      wanModel = ckpts.find(c => c.toLowerCase().includes("wan") && c.toLowerCase().includes("i2v"))
              || ckpts.find(c => c.toLowerCase().includes("wan"));
    }
  } catch(e) { console.warn("[Wan2.2]", e.message); }

  if (!wanModel) {
    throw new Error("Wan Video 2.2 non installé. Télécharger wan2.2_i2v_high_noise_14B_fp8_sd.safetensors dans ComfyUI/models/checkpoints/");
  }

  // Résoudre l'URL de l'image source en chemin local
  const imgPath = imageUrl.startsWith("/uploads/")
    ? path.join(UPLOADS_DIR, imageUrl.replace("/uploads/", ""))
    : imageUrl;
  if (!fs.existsSync(imgPath)) throw new Error("Image source introuvable: " + imgPath);

  // Upload l'image vers ComfyUI
  const imgBuffer = fs.readFileSync(imgPath);
  const imgB64 = imgBuffer.toString("base64");
  const uploadResp = await fetch(COMFY_URL + "/upload/image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:image/png;base64,${imgB64}`, filename: "img2vid_src.png", overwrite: true })
  });
  if (!uploadResp.ok) throw new Error("Upload image ComfyUI failed");

  // Nombre de frames selon la durée (Wan2.2 génère ~24fps)
  const numFrames = Math.min(Math.max(Math.round(durationSec * 24), 16), 81);

  // Workflow ComfyUI pour WAN I2V
  const workflow = {
    "1": { "class_type": "CheckpointLoaderSimple",    "inputs": { "ckpt_name": wanModel } },
    "2": { "class_type": "CLIPTextEncode",            "inputs": { "text": motionPrompt, "clip": ["1", 1] } },
    "3": { "class_type": "CLIPTextEncode",            "inputs": { "text": "watermark, text, blurry, artifacts, static, frozen, still", "clip": ["1", 1] } },
    "4": { "class_type": "LoadImage",                 "inputs": { "image": "img2vid_src.png" } },
    "5": { "class_type": "ImageResize+",              "inputs": { "image": ["4", 0], "width": 832, "height": 480, "interpolation": "lanczos", "method": "fill/crop", "condition": "always", "multiple_of": 16 } },
    "6": { "class_type": "WanVideoSampler",           "inputs": {
      "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
      "image": ["5", 0], "num_frames": numFrames, "fps": 24,
      "steps": 20, "cfg": 6.0, "seed": actualSeed,
      "sampler_name": "euler", "scheduler": "karras"
    }},
    "7": { "class_type": "VHS_VideoCombine",          "inputs": {
      "images": ["6", 0], "frame_rate": 24, "loop_count": 0,
      "filename_prefix": "wan_clip", "format": "video/h264-mp4",
      "unique_id": actualSeed
    }}
  };

  // Soumettre à ComfyUI
  const queueResp = await fetch(COMFY_URL + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "elissia" })
  });
  if (!queueResp.ok) throw new Error("ComfyUI queue failed: " + queueResp.status);
  const queueData = await queueResp.json();
  const promptId = queueData.prompt_id;

  // Attendre la fin de génération (max 5 min)
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    await new Promise(r => setTimeout(r, 3000));
    const histResp = await fetch(COMFY_URL + "/history/" + promptId);
    if (!histResp.ok) continue;
    const hist = await histResp.json();
    const job = hist[promptId];
    if (!job) continue;
    if (job.status?.completed) {
      // Récupérer la vidéo générée
      const outputs = Object.values(job.outputs || {});
      for (const out of outputs) {
        const vids = out.videos || out.gifs || [];
        if (vids.length > 0) {
          const vid = vids[0];
          // Télécharger depuis ComfyUI
          const vidResp = await fetch(`${COMFY_URL}/view?filename=${vid.filename}&subfolder=${vid.subfolder||""}&type=${vid.type||"output"}`);
          if (!vidResp.ok) throw new Error("Impossible de récupérer la vidéo");
          const vidBuf = Buffer.from(await vidResp.arrayBuffer());
          const outName = `wan_${Date.now()}.mp4`;
          const outPath = path.join(UPLOADS_DIR, outName);
          fs.writeFileSync(outPath, vidBuf);
          return "/uploads/" + outName;
        }
      }
    }
    if (job.status?.status_str === "error") throw new Error("ComfyUI erreur: " + JSON.stringify(job.status));
  }
  throw new Error("Timeout WAN2.2 (>5 min)");
}

// ══════════════════════════════════════════════════════════════
// MONTAGE NARRATIF : scénario → clips → MP4 final
// Le scénario est décomposé en étapes, chaque étape = 1 clip Wan2.2
// ══════════════════════════════════════════════════════════════
async function buildNarrativeVideo(companionProfiles, scenarioSteps, outputPath) {
  const clips = [];
  const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";

  for (let i = 0; i < scenarioSteps.length; i++) {
    const step = scenarioSteps[i];
    const comp = companionProfiles[step.companionIdx % companionProfiles.length];
    console.log(`[Narrative] Step ${i+1}/${scenarioSteps.length}: ${step.action.slice(0,60)}`);

    try {
      // Générer d'abord une frame de référence avec le profil exact du compagnon
      const framePrompt = buildComfyPromptFinal(comp.profile, step.style || "sensuelle")
        + ", " + step.action;
      const frameUrl = await comfyGenerateImage(framePrompt, step.style || "sensuelle", comp.seed + i);
      console.log(`[Narrative] Frame ${i+1} OK: ${frameUrl}`);

      // Générer le clip vidéo depuis cette frame
      const clipUrl = await comfyImg2Vid(frameUrl, step.action, step.duration || 4, comp.seed + i + 1000);
      const clipPath = path.join(UPLOADS_DIR, clipUrl.replace("/uploads/",""));
      if (fs.existsSync(clipPath)) {
        clips.push(clipPath);
        console.log(`[Narrative] Clip ${i+1} OK: ${clipUrl}`);
      }
    } catch(e) {
      console.warn(`[Narrative] Step ${i+1} erreur:`, e.message);
      // Si img2vid échoue (WAN pas installé), utiliser Ken Burns sur la frame
      try {
        const framePrompt = buildComfyPromptFinal(comp.profile, step.style || "sensuelle")
          + ", " + step.action;
        const frameUrl = await comfyGenerateImage(framePrompt, step.style || "sensuelle", comp.seed + i);
        const framePath = path.join(UPLOADS_DIR, frameUrl.replace("/uploads/",""));
        if (fs.existsSync(framePath)) {
          // Ken Burns fallback: 4s par clip
          const tempVid = path.join(UPLOADS_DIR, `temp_step_${i}_${Date.now()}.mp4`);
          await new Promise((res, rej) => {
            execFile(ffmpegBin, [
              "-y", "-loop", "1", "-t", String(step.duration || 4), "-i", framePath,
              "-vf", `scale=832:480:force_original_aspect_ratio=decrease,pad=832:480:(ow-iw)/2:(oh-ih)/2,fps=24,zoompan=z='min(zoom+0.001,1.06)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=832x480`,
              "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", tempVid
            ], (err) => err ? rej(err) : res());
          });
          if (fs.existsSync(tempVid)) clips.push(tempVid);
          console.log(`[Narrative] Ken Burns fallback step ${i+1} OK`);
        }
      } catch(e2) { console.warn(`[Narrative] Fallback step ${i+1}:`, e2.message); }
    }
  }

  if (!clips.length) throw new Error("Aucun clip généré");

  // Concatener tous les clips en un seul MP4
  const listFile = outputPath + "_concat.txt";
    const concatLines = clips.map(c => "file " + JSON.stringify(c)).join("\n");
  fs.writeFileSync(listFile, concatLines);

  await new Promise((res, rej) => {
    execFile(ffmpegBin, [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "fast", "-crf", "22",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", outputPath
    ], (err) => {
      try { fs.unlinkSync(listFile); } catch {}
      err ? rej(new Error("ffmpeg concat: " + err.message)) : res();
    });
  });

  // Nettoyer les clips temporaires
  clips.filter(c => c.includes("temp_step_")).forEach(c => { try { fs.unlinkSync(c); } catch {} });

  return outputPath;
}

// ══════════════════════════════════════════════════════════════
// ROUTE : /api/generate/narrative-video
// Reçoit un scénario texte → Perplexity décompose en étapes
// → buildNarrativeVideo → MP4 final
// ══════════════════════════════════════════════════════════════
app.post("/api/generate/narrative-video", requireAuth, requireCsrf, rateLimit("genvid",2,3600000), async (req,res) => {
  try {
    const scenarioText = clean(req.body.scenarioText || req.body.scenarioContext || "", 3000);
    const companionIds = (req.body.companionIds || []).slice(0, 3);
    const targetDuration = Math.min(parseInt(req.body.duration) || 60, 180); // max 3 min

    if (!scenarioText) return res.status(400).json({ ok:false, error:"scenarioText requis" });
    if (!companionIds.length) return res.status(400).json({ ok:false, error:"Compagnons requis" });

    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) return res.status(503).json({ ok:false, error:"FFmpeg non disponible" });

    // 1️⃣ Charger les profils des compagnons
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const companions = [];
    for (const cid of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(cid, req.user.id);
      if (!cr) continue;
      const profile = parseJson(decryptText(cr.profile_enc), {});
      const lastPhoto = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(cid);
      const avatarUrl = cr.avatar_url_enc ? decryptText(cr.avatar_url_enc) : (lastPhoto ? decryptText(lastPhoto.url_enc) : null);
      companions.push({ id:cid, name:decryptText(cr.name_enc), persona:cr.persona, profile, avatarUrl, seed:parseInt(cr.avatar_seed)||Math.floor(Math.random()*2**32) });
    }
    if (!companions.length) return res.status(400).json({ ok:false, error:"Aucun compagnon trouvé" });

    // 2️⃣ Perplexity décompose le scénario en étapes narratives précises
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    let scenarioSteps = [];

    if (PERPLEXITY_KEY) {
      try {
        const compNames = companions.map((c,i) => `${i}:${c.name}(${c.persona})`).join(", ");
        const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${PERPLEXITY_KEY}`},
          body: JSON.stringify({
            model:"sonar",
            messages:[{
              role:"system",
              content:`You are a cinematic storyboard director. Break a French scene description into sequential video shots for AI image generation. Output ONLY valid JSON array, no other text. Each shot: {"companionIdx":0_or_1,"action":"detailed English motion prompt for Stable Diffusion, include pose body language expression setting","style":"sensuelle|nue|portrait|dominatrice|bdsm","duration":2_to_6}. Total duration should be ~${targetDuration} seconds. Focus on: specific body movements, facial expressions, spatial relationships between characters. Be explicit about physical actions if adult content. Companions: ${compNames}.`
            },{
              role:"user",
              content:`Scene (French): ${scenarioText}

Break this into ${Math.ceil(targetDuration/4)} shots (~4s each). Return ONLY the JSON array.`
            }],
            max_tokens:2000, temperature:0.8
          })
        });
        if (pxR.ok) {
          const pxD = await pxR.json();
          const content = pxD.choices?.[0]?.message?.content || "";
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
              scenarioSteps = parsed.slice(0, Math.ceil(targetDuration/3));
              console.log(`[NarrVideo] ${scenarioSteps.length} étapes Perplexity ✓`);
            }
          }
        }
      } catch(e) { console.warn("[NarrVideo] Perplexity:", e.message); }
    }

    // Fallback si Perplexity échoue
    if (!scenarioSteps.length) {
      const nSteps = Math.ceil(targetDuration / 4);
      for (let i = 0; i < nSteps; i++) {
        scenarioSteps.push({
          companionIdx: i % companions.length,
          action: scenarioText.slice(0, 200) + `, step ${i+1}, dynamic pose`,
          style: "sensuelle",
          duration: 4
        });
      }
    }

    // 3️⃣ Générer le montage
    const outName = `narrative_${req.user.id.slice(0,8)}_${Date.now()}.mp4`;
    const outPath = path.join(UPLOADS_DIR, outName);
    const vidUrl = "/uploads/" + outName;

    console.log(`[NarrVideo] Démarrage montage: ${scenarioSteps.length} étapes, ${companions.length} compagnons`);
    await buildNarrativeVideo(companions, scenarioSteps, outPath);

    // Sauvegarder en galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "narrative_video.mp4", "video/mp4", "ai_generated", "narrative", scenarioText.slice(0,200), now());
    } catch {}

    res.json({ ok:true, url:vidUrl, steps:scenarioSteps.length, companions:companions.map(c=>c.name) });

  } catch(e) {
    console.error("[NarrVideo]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// VIDER LA GALERIE — supprime tous les fichiers générés par l'IA
// ══════════════════════════════════════════════════════════════
app.post("/api/gallery/clear", requireAuth, requireCsrf, (req, res) => {
  try {
    // Récupérer toutes les photos IA de l'utilisateur
    const photos = db.prepare(
      "SELECT filename FROM media_library WHERE user_id=? AND source='ai_generated'"
    ).all(req.user.id);

    let deleted = 0;
    for (const p of photos) {
      // Supprimer le fichier physique
      const fname = p.filename.replace("/uploads/","").split("/").pop();
      const filePath = path.join(UPLOADS_DIR, fname);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); deleted++; } catch(e) { console.warn("[GalleryClear] file:", e.message); }
      }
    }

    // Supprimer les entrées en DB
    const dbResult = db.prepare("DELETE FROM media_library WHERE user_id=? AND source='ai_generated'").run(req.user.id);

    console.log(`[GalleryClear] ${req.user.id} → ${deleted} fichiers, ${dbResult.changes} DB entrées supprimées`);
    res.json({ ok:true, deleted, db_changes: dbResult.changes });
  } catch(e) {
    console.error("[GalleryClear]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get("/", (req,res) => res.redirect("/mobile"));

/* ═══ MULTI-COMPAGNONS v12 ═══ */
app.get("/api/companions/preview", requireAuth, (req,res) => {
  const rows = db.prepare("SELECT * FROM companions WHERE user_id=? ORDER BY sort_order ASC, created_at ASC").all(req.user.id);
  const companions = rows.map(c => {
    const lp = db.prepare("SELECT url_enc FROM companion_photos WHERE companion_id=? ORDER BY created_at DESC LIMIT 1").get(c.id);
    const avatarUrl = c.avatar_url_enc ? decryptText(c.avatar_url_enc) : (lp ? decryptText(lp.url_enc) : null);
    const mc = db.prepare("SELECT COUNT(*) c FROM messages WHERE user_id=? AND companion_id=?").get(req.user.id,c.id)?.c||0;
    return {id:c.id,name:decryptText(c.name_enc),persona:c.persona,profile:parseJson(decryptText(c.profile_enc),{}),
      avatarUrl,isActive:Boolean(c.is_active),sortOrder:c.sort_order,createdAt:c.created_at,messageCount:mc};
  });
  res.json({ok:true,companions});
});

app.post("/api/multi-chat", requireAuth, requireCsrf, rateLimit("chat",30,3600000), async (req,res) => {
  try {
    const message = clean(req.body.message||"",2000);
    const companionIds = (req.body.companionIds||[]).slice(0,4);
    const scenarioContext = clean(req.body.scenarioContext||"",500);
    if (!companionIds.length) return res.status(400).json({ok:false,error:"Aucun compagnon."});
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    res.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
    res.write(JSON.stringify({type:"start",companionCount:companionIds.length})+"\n");
    if (message) {
      for (const cid of companionIds) {
        try{db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id(),req.user.id,"user",encryptText(message),"user",cid,"multi",now());}catch{}
      }
    }
    for (const compId of companionIds) {
      const cr = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId,req.user.id);
      if (!cr) continue;
      const cn = decryptText(cr.name_enc);
      const cp = parseJson(decryptText(cr.profile_enc),{});
      const fu = {...freshUser,ai_name_enc:cr.name_enc,preferred_persona:cr.persona,extended_profile_enc:encryptText(JSON.stringify(cp))};
      const humanName = publicUser(freshUser).displayName || "l'utilisateur";
      const ancre = `\nTu es ${cn}, et UNIQUEMENT ${cn} : tu parles en ton seul nom, jamais à la place des autres personnages.`
        + `\nTu restes fidèle à TON caractère décrit ci-dessus : tu ne deviens jamais un autre personnage et tu n'adoptes pas le rôle d'un·e autre. Une copine reste une copine, un soumis reste soumis — chacun garde sa propre personnalité.`
        + `\nC'est une scène à plusieurs : tu peux interagir avec les autres compagnons présents, réagir à ce qu'ils disent et font, et décrire tes propres actions.`
        + `\n${humanName} dirige la scène et donne des consignes : prends ses consignes en compte et intègre-les à ton jeu.`;
      const ss = (scenarioContext?`\n[SCÈNE] ${scenarioContext}`:``) + ancre;
      const sys = buildSystemPrompt(fu,cr.persona,message,{})+ss;
      const lm = [{role:"system",content:sys},...recentMessages(req.user.id,compId,"multi"),{role:"user",content:message}];
      res.write(JSON.stringify({type:"companion_start",companionId:compId,companionName:cn})+"\n");
      let full="";
      try{full=await ollamaStream(lm,t=>res.write(JSON.stringify({type:"token",companionId:compId,companionName:cn,token:t})+"\n"));}
      catch(e){res.write(JSON.stringify({type:"companion_error",companionId:compId,error:e.message})+"\n");continue;}
      try{db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(),req.user.id,"assistant",encryptText(full),cr.persona,compId,"multi",now());}catch(e){console.warn("[multi-chat]",e.message);}
      res.write(JSON.stringify({type:"companion_done",companionId:compId,companionName:cn,reply:full})+"\n");
    }
    res.write(JSON.stringify({type:"done"})+"\n"); res.end();
  } catch(e){console.error("[multi-chat]",e.message);try{res.write(JSON.stringify({type:"error",error:e.message})+"\n");res.end();}catch{}}
});

/* ═══════════════════════════════════════
   DÉMARRAGE
═══════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\n✨ ${APP_NAME} v8.3 — fix multichat + [PHOTO:] + Nyx trans + Perplexity + expressions`);
  console.log(`🌐 http://localhost:${PORT}/mobile`);
  console.log(`🤖 Mode : ${MODE==="cloud"?"CLOUD ("+CLOUD_MODEL+")":"LOCAL ("+OLLAMA_MODEL+")"}`);
  console.log(`🖼️  ComfyUI : ${COMFY_URL} / Modèle : ${COMFY_MODEL}`);
  console.log(`🔊 Piper   : ${process.env.PIPER_BIN?"✓ "+process.env.PIPER_BIN:"✗ désactivé"}`);
  console.log(`📅 Workflow perpétuel : ✓ actif\n`);
