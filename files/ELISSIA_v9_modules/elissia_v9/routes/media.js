// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — routes/media.js : génération images, galerie, TTS, vidéo
// ═══════════════════════════════════════════════════════════════
app.get("/api/generate/status", requireAuth, (req,res) => {
  res.json({ ok:true, ready:true, provider:"comfyui", model:COMFY_MODEL });
});

// Route principale génération image — essaie serveur-side, sinon renvoie les infos pour client-side
app.post("/api/generate/selfie", requireAuth, requireCsrf, rateLimit("genimg",30,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ Priorité : 1) ext envoyé depuis le front 2) profil compagnon 3) profil user
    const cidSelfie = req.body.companionId || null;
    let ext;
    if (cidSelfie) {
      const cr = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidSelfie, req.user.id);
      // ✅ v18.1 — Photo de compagnon : son profil est la source de vérité, on ne l'écrase
      //   plus par l'ext du formulaire principal (sinon Nyx prenait le corps cis de Gaëlle).
      ext = cr ? parseJson(decryptText(cr.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const style   = req.body.style   || "sensuelle";
    const tenue   = req.body.tenue   || null;
    const contexte= req.body.contexte|| null;
    const accessoires = req.body.accessoires || null;

    // Préférences apprises de l'utilisateur
    const userPrefs = { accessoires };
    let prompt = buildComfyPromptFinal(ext, style, tenue, userPrefs);
    if (contexte) prompt += ", " + contexte;
    if (accessoires) prompt += ", " + accessoires;

    // Seed aléatoire pour les selfies (variété) mais on garde le même visage de référence
    const seed = Math.floor(Math.random() * 2**32);
    const url = await comfyGenerateImage(prompt, style, null);

    // ✅ FIX v9 — INSERT avec la colonne "style" correctement remplie (et ai_analysis séparé)
    db.prepare("INSERT INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id(), req.user.id, url, "selfie_"+style+".png", "image/png", "ai_generated", style, prompt.slice(0,200), now());

    // Sauvegarder les préférences apprises dans le profil étendu
    if (accessoires || style) {
      const currentExt = ext;
      const histStyles = JSON.parse(currentExt.styles_generes || "[]");
      if (!histStyles.includes(style)) histStyles.push(style);
      currentExt.styles_generes = JSON.stringify(histStyles.slice(-20));
      if (accessoires && !currentExt.mes_jouets?.includes(accessoires)) {
        currentExt.mes_jouets = ((currentExt.mes_jouets||"") + " " + accessoires).trim();
      }
      db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
        .run(encryptText(JSON.stringify(currentExt)), now(), req.user.id);
    }

    res.json({ ok:true, url, style, prompt });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get("/api/generate/styles", requireAuth, (req,res) => {
  // ✅ FIX v9 — renvoyer le catalogue groupé ET une liste plate "styles"
  // Le frontend loadStyles() lit d.styles ; sans ça les tenues restaient vides.
  const cat = getStylesCatalogue();
  const flat = [];
  for (const groupe of cat) {
    for (const s of (groupe.styles || [])) {
      flat.push({ id: s.id, label: s.label, emoji: s.emoji });
    }
  }
  res.json({ ok:true, catalogue: cat, styles: flat });
});

app.get("/api/gallery", requireAuth, async (req,res) => {
  const companionIdFilter = req.query.companionId || null;
  try {
    // 1. Photos enregistrées en base — filtrées si companionId fourni
    let photos;
    if (companionIdFilter) {
      // Photos spécifiques à un compagnon
      photos = db.prepare(
        "SELECT id, url_enc as filename_enc, style, created_at FROM companion_photos WHERE companion_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50"
      ).all(companionIdFilter, req.user.id).map(p => ({
        ...p, filename: decryptText(p.filename_enc)
      }));
    } else {
      photos = db.prepare(
        "SELECT id, filename, COALESCE(style,'portrait') as style, COALESCE(created_at,datetime('now')) as created_at FROM media_library WHERE user_id=? AND (source='ai_generated' OR filename LIKE '/uploads/gen_%') ORDER BY rowid DESC LIMIT 100"
      ).all(req.user.id);
    }

    // 2. Si la base est vide, scanner le dossier uploads/ pour les gen_*
    if (!photos.length) {
      const uploadsDir = path.join(__dirname, "uploads");
      try {
        const fs2 = require("fs");
        const files = fs2.readdirSync(uploadsDir)
          .filter(f => f.startsWith("gen_") && f.endsWith(".png"))
          .sort().reverse()
          .slice(0, 50);
        photos = files.map(f => ({
          id: f,
          filename: "/uploads/" + f,
          style: "portrait",
          created_at: new Date(parseInt(f.split("_")[1]||0)).toISOString()
        }));
        // Les enregistrer en base pour la prochaine fois
        for (const p of photos) {
          try {
            db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
              .run(p.id, req.user.id, p.filename, p.id, "image/png", "ai_generated", p.style, p.created_at);
          } catch {}
        }
      } catch(e) { console.warn("[gallery scan]", e.message); }
    }

    // ✅ v13 : Filtrer les fichiers 404 côté serveur
    photos = photos.filter(p => {
      if (!p.filename || p.filename.includes("undefined")) return false;
      const clean = p.filename.replace("/uploads/","").split("/").pop();
      return fs.existsSync(path.join(UPLOADS_DIR, clean));
    });

    res.json({ ok:true, photos });
  } catch(e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post("/api/generate/image", requireAuth, requireCsrf, rateLimit("genimg",20,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ v18 — honorer le compagnon actif (corrige "toujours Gaëlle" : la route ignorait companionId)
    const cidImg = req.body.companionId || null;
    let ext;
    if (cidImg) {
      const crImg = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidImg, req.user.id);
      ext = crImg ? parseJson(decryptText(crImg.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }

    // Utiliser le prompt passé OU construire depuis le profil complet
    const rawPrompt = req.body.prompt || "";
    const style     = req.body.style  || "sensuelle";

    // Si le prompt est générique ou vide → utiliser buildComfyPrompt complet
    let finalPrompt;
    if (!rawPrompt || rawPrompt === "portrait sensuel" || rawPrompt.length < 20) {
      finalPrompt = buildComfyPromptFinal(ext, style, null);
    } else {
      // Enrichir le prompt utilisateur avec les caractéristiques physiques
      const physBase = buildComfyPromptFinal(ext, style, rawPrompt);
      finalPrompt = physBase;
    }

    const seed = req.body.seed ? parseInt(req.body.seed)
               : (req.body.forceSeed ? getAvatarSeed(ext) : null);
    const url  = await comfyGenerateImage(finalPrompt, style, seed);

    // ✅ FIX v9 — Sauvegarder dans media_library avec colonne style remplie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "photo_"+style+".png", "image/png", "ai_generated", style, finalPrompt.slice(0,200), now());
    } catch(e2) { console.warn("[media_library img]", e2.message); }

    res.json({ ok:true, url, style });
  } catch(e) {
    console.error("[generate/image]", e.message);
    res.status(500).json({ ok:false, error:e.message, clientSide:false });
  }
});

app.post("/api/generate/save", requireAuth, requireCsrf, async (req,res) => {
  try {
    const imageUrl = clean(req.body.imageUrl || "", 500);
    const companionId = req.body.companionId ? clean(req.body.companionId, 80) : null;
    const style = clean(req.body.style || "realistic", 20);
    const prompt = clean(req.body.prompt || "", 500);
    const seed = req.body.seed ? String(req.body.seed) : null;
    if (!imageUrl || !imageUrl.startsWith("http")) return res.status(400).json({ ok:false, error:"URL invalide" });

    // Télécharger et sauvegarder localement
    const localUrl = await downloadToUploads(imageUrl);

    if (companionId) {
      // Sauvegarder en companion_photos
      const comp = db.prepare("SELECT id FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
      if (comp) {
        db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(id(), companionId, req.user.id, encryptText(localUrl), encryptText(prompt), style, seed||"", now());
        // Mettre à jour avatar si c'est le premier
        const existing = db.prepare("SELECT avatar_url_enc FROM companions WHERE id=?").get(companionId);
        if (!existing?.avatar_url_enc) {
          db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE id=?").run(encryptText(localUrl), now(), companionId);
        }
      }
    } else {
      // Sauvegarder comme avatar utilisateur
      db.prepare("UPDATE users SET avatar_enc=?,persona_photo_enc=?,updated_at=? WHERE id=?")
        .run(encryptText(localUrl), encryptText(localUrl), now(), req.user.id);
    }

    res.json({ ok:true, url:localUrl });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post("/api/generate/avatar", requireAuth, requireCsrf, rateLimit("genimg",20,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u = publicUser(freshUser);
    // ✅ Priorité : ext front > profil compagnon > profil user
    const cidAv = req.body.companionId || null;
    let ext;
    if (cidAv) {
      const crAv = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidAv, req.user.id);
      ext = crAv ? parseJson(decryptText(crAv.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const style = req.body.style || "portrait";
    const tenue = req.body.tenue || null;

    // ✅ FIX v9 — gestion du seed :
    // - Si le client envoie un seed explicite (nouveau visage) → on l'utilise
    // - Sinon, si forceSeed demandé → seed de référence stable (même visage)
    // - Sinon → aléatoire
    const clientSeed = req.body.seed ? parseInt(req.body.seed) : null;
    const forceSeed  = req.body.forceSeed === true; // n'est plus true par défaut

    // Prompt complet depuis TOUT le profil physique
    const prompt = req.body.prompt || buildComfyPromptFinal(ext, style, tenue);

    let seed = null;
    if (clientSeed && !isNaN(clientSeed) && clientSeed > 0) {
      seed = clientSeed;            // visage varié demandé par le client
    } else if (forceSeed) {
      seed = getAvatarSeed(ext);    // même visage de référence
    }
    // sinon seed=null → comfyGenerateImage en génère un aléatoire

    console.log("[Avatar] style:", style, "| seed:", seed, "| prompt:", prompt.slice(0,80)+"...");
    const url = await comfyGenerateImage(prompt, style, seed);

    // Sauvegarder l'avatar + seed de référence
    const updExt = { ...ext };
    if (!updExt.avatar_seed || updExt.avatar_seed === "null") {
      updExt.avatar_seed = String(seed || Date.now());
    }
    updExt.avatar_url_ref = url;
    db.prepare("UPDATE users SET persona_photo_enc=?, avatar_enc=?, extended_profile_enc=?, updated_at=? WHERE id=?")
      .run(encryptText(url), encryptText(url), encryptText(JSON.stringify(updExt)), now(), req.user.id);

    // ── Sauvegarder dans media_library pour la galerie ──────────────
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "avatar_"+style+".png", "image/png", "ai_generated", style, now());
    } catch(e) { console.warn("[media_library]", e.message); }

    const updatedExt = { ...updExt };

    // Créer une compagne par défaut si aucune n'existe encore
    const existingComp = db.prepare("SELECT id FROM companions WHERE user_id=? LIMIT 1").get(req.user.id);
    if (!existingComp) {
      const compId = id();
      const aiNameStr = decryptText(req.user.ai_name_enc) || "Élissia";
      db.prepare("INSERT INTO companions(id,user_id,name_enc,persona,profile_enc,avatar_url_enc,avatar_seed,created_at,updated_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?,?,1,0)")
        .run(compId, req.user.id, encryptText(aiNameStr), req.user.preferred_persona||"girlfriend",
          encryptText(JSON.stringify(updatedExt)), encryptText(url), String(seed || Date.now()), now(), now());
      // Sauvegarder dans companion_photos
      const fullPrompt = personality.buildAvatarPromptFromProfile(updatedExt);
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), compId, req.user.id, encryptText(url), encryptText(fullPrompt), "realistic", String(seed || Date.now()), now());
    } else {
      // Mettre à jour la compagne existante
      db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE user_id=? LIMIT 1")
        .run(encryptText(url), now(), req.user.id);
      // Sauvegarder en companion_photos
      const fullPrompt = personality.buildAvatarPromptFromProfile(updatedExt);
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), existingComp.id, req.user.id, encryptText(url), encryptText(fullPrompt), "realistic", String(seed || Date.now()), now());
    }

    audit(req.user.id,"avatar_generated",{ seed: seed },req);
    res.json({ ok:true, url, avatarUrl:url, seed: seed });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   ✅ NOUVEAU v9 — AVATAR ANIMÉ GIF
   POST /api/generate/avatar/animated  { frames? }
   Génère plusieurs portraits du même visage et les assemble en GIF.
═══════════════════════════════════════════════════════════════ */
app.post("/api/generate/avatar/animated", requireAuth, requireCsrf, rateLimit("genimg",6,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u   = publicUser(freshUser);
    const ext = u.extendedProfile || {};
    const frames = req.body.frames || 6;

    console.log("[Avatar animé] Démarrage génération vidéo MP4, frames:", frames);
    const vidUrl = await generateAnimatedAvatarGif(ext, req.user.id, frames);

    // Sauvegarder la vidéo comme avatar animé (et avatar courant)
    const updExt = { ...ext, avatar_animated_url: vidUrl };
    db.prepare("UPDATE users SET avatar_animated_enc=?, persona_photo_enc=?, avatar_enc=?, extended_profile_enc=?, updated_at=? WHERE id=?")
      .run(encryptText(vidUrl), encryptText(vidUrl), encryptText(vidUrl), encryptText(JSON.stringify(updExt)), now(), req.user.id);

    // Ajouter à la galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, vidUrl, "avatar_anime.mp4", "video/mp4", "ai_generated", "avatar_anime", now());
    } catch(e) { console.warn("[media_library mp4]", e.message); }

    audit(req.user.id,"avatar_animated_generated",{ frames },req);
    res.json({ ok:true, url: vidUrl });
  } catch(e) {
    console.error("[avatar/animated]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══ GÉNÉRATION VIDÉO ══════════════════════════════════════════
app.post("/api/generate/video", requireAuth, requireCsrf, rateLimit("genvid",5,3600000), async (req,res) => {
  try {
    const u = publicUser(req.user);
    // ✅ v18 — honorer le compagnon actif (même fix que /api/generate/image)
    const cidVid = req.body.companionId || null;
    let ext;
    if (cidVid) {
      const crVid = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(cidVid, req.user.id);
      ext = crVid ? parseJson(decryptText(crVid.profile_enc), {}) : { ...(u.extendedProfile||{}), ...(req.body.ext||{}) };
    } else {
      ext = { ...(u.extendedProfile || {}), ...(req.body.ext || {}) };
    }
    const prompt  = clean(req.body.prompt || personality.buildSelfiePrompt(ext, "sensuelle"), 500);
    const explicit = Boolean(req.body.explicit) && !!req.user.adult_mode;
    const url = await civitaiGenerateVideo(prompt, explicit);
    res.json({ ok:true, video_url:url });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ v12 — Vidéo depuis conversation (utilise les messages du chat comme contexte de scène)
app.post("/api/generate/video/chat", requireAuth, requireCsrf, rateLimit("genvid",5,3600000), async (req,res) => {
  try {
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    const u   = publicUser(freshUser);
    const ext = u.extendedProfile || {};
    const explicit = Boolean(req.body.explicit) && !!freshUser.adult_mode;

    // Récupérer les derniers messages pour construire la scène
    const chatMessages = db.prepare("SELECT role, content_enc FROM messages WHERE user_id=? ORDER BY created_at DESC LIMIT 6").all(req.user.id)
      .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc).slice(0, 250) }));

    console.log("[VideoChat] Génération depuis", chatMessages.length, "messages récents");
    const url = await generateVideoFromChat(req.user.id, ext, explicit, chatMessages);

    // Sauvegarder dans la galerie
    try {
      db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,style,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, url, "chat_video.mp4", "video/mp4", "ai_generated", "video_chat", now());
    } catch {}

    res.json({ ok:true, video_url:url, url });
  } catch(e) { console.error("[VideoChat]", e.message); res.status(500).json({ ok:false, error:e.message }); }
});

// ✅ v12 — API pour afficher les mémoires dans l'UI
app.get("/api/memories/summary", requireAuth, (req,res) => {
  try {
    const m3 = getMemoire3Niveaux(req.user.id);
    const allMemories = db.prepare("SELECT id, text_enc, kind, importance, source, created_at FROM memories WHERE user_id=? ORDER BY importance DESC, created_at DESC LIMIT 100").all(req.user.id)
      .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, source:m.source, createdAt:m.created_at }));
    const facts = db.prepare("SELECT type, fact_enc, importance FROM user_facts WHERE user_id=? ORDER BY importance DESC LIMIT 30").all(req.user.id)
      .map(f => ({ type:f.type, text:decryptText(f.fact_enc), importance:f.importance }));
    const journal = db.prepare("SELECT date, title, content_enc, mood FROM memory_journal WHERE user_id=? ORDER BY created_at DESC LIMIT 10").all(req.user.id)
      .map(j => ({ date:j.date, title:j.title, content:decryptText(j.content_enc), mood:j.mood }));
    res.json({ ok:true, summary:m3, memories:allMemories, facts, journal, totalMemories:allMemories.length });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ══ UPLOAD MÉDIAS ═════════════════════════════════════════════
app.post("/api/media/upload", requireAuth, upload.single("media"), async (req,res) => {
  if (!req.file) return res.status(400).json({ ok:false, error:"Aucun fichier." });
  const localUrl = `/uploads/${req.file.filename}`;
  let analysis = "";

  if (req.file.mimetype.startsWith("image/")) {
    // ✅ v13 : Utiliser le genre du compagnon actif si fourni (pour une analyse plus précise)
    const u = publicUser(req.user);
    let userGender = (u.extendedProfile||{}).user_genre || (u.extendedProfile||{}).genre || "";
    const companionId = req.body.companionId || null;
    if (companionId) {
      const cr = db.prepare("SELECT profile_enc FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
      if (cr) {
        const cp = parseJson(decryptText(cr.profile_enc), {});
        userGender = cp.genre || userGender;
      }
    }
    try {
      analysis = await analyzeImage(path.join(UPLOADS_DIR, req.file.filename), userGender, !!(req.user.adult_mode)) || "";
      console.log("[MediaUpload] Analyse image:", analysis?.slice(0,80));
    } catch(e) { console.warn("[MediaUpload] analyzeImage:", e.message); }
  }

  const mediaId = id();
  db.prepare("INSERT INTO media_library(id,user_id,filename,original_name,mime_type,source,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(mediaId, req.user.id, localUrl, req.file.originalname, req.file.mimetype, "user", analysis, now());

  res.json({
    ok: true, mediaId, url: localUrl,
    type: req.file.mimetype.startsWith("image/") ? "image" : "video",
    analysis,
    mimeType: req.file.mimetype,
    // ✅ Indiquer si l'analyse a fonctionné
    vision_available: analysis.length > 0 && analysis !== "__VISION_INDISPONIBLE__"
  });
});

// ══ MÉMOIRES CRUD ═════════════════════════════════════════════
app.get("/api/memories", requireAuth, (req,res) => {
  const rows = db.prepare("SELECT id,text_enc,kind,importance,created_at,updated_at FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 300").all(req.user.id)
    .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at, updatedAt:m.updated_at }));
  res.json({ ok:true, memories:rows });
});
app.post("/api/memories", requireAuth, requireCsrf, async (req,res) => {
  const text = clean(req.body.text,1200), kind = clean(req.body.kind||"manual",80);
  const importance = Math.max(1,Math.min(5,Number(req.body.importance||3)));
  if (!text) return res.status(400).json({ ok:false, error:"Vide." });
  const e = await embed(text);
  const memoryId = id();
  db.prepare("INSERT INTO memories(id,user_id,text_enc,kind,importance,embedding_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(memoryId,req.user.id,encryptText(text),kind,importance,e?json(e):null,now(),now());
  res.json({ ok:true, memory:{ id:memoryId, text, kind, importance } });
});
app.put("/api/memories/:id", requireAuth, requireCsrf, async (req,res) => {
  const memoryId = clean(req.params.id,80);
  if (!db.prepare("SELECT id FROM memories WHERE id=? AND user_id=?").get(memoryId,req.user.id))
    return res.status(404).json({ ok:false, error:"Introuvable." });
  const text = clean(req.body.text,1200), kind = clean(req.body.kind||"manual",80);
  const importance = Math.max(1,Math.min(5,Number(req.body.importance||3)));
  const e = await embed(text);
  db.prepare("UPDATE memories SET text_enc=?,kind=?,importance=?,embedding_json=?,updated_at=? WHERE id=? AND user_id=?")
    .run(encryptText(text),kind,importance,e?json(e):null,now(),memoryId,req.user.id);
  res.json({ ok:true });
});
app.delete("/api/memories/:id", requireAuth, requireCsrf, (req,res) => {
  db.prepare("DELETE FROM memories WHERE id=? AND user_id=?").run(clean(req.params.id,80),req.user.id);
  res.json({ ok:true });
});
app.delete("/api/messages", requireAuth, requireCsrf, (req,res) => {
  const cid = req.query.companionId || req.body?.companionId || null;
  if (cid) db.prepare("DELETE FROM messages WHERE user_id=? AND companion_id=?").run(req.user.id, cid);
  else db.prepare("DELETE FROM messages WHERE user_id=? AND companion_id IS NULL").run(req.user.id);
  res.json({ ok:true });
});
app.delete("/api/memories", requireAuth, requireCsrf, (req,res) => {
  db.prepare("DELETE FROM memories WHERE user_id=?").run(req.user.id);
  res.json({ ok:true });
});
app.delete("/api/account", requireAuth, requireCsrf, (req,res) => {
  const userId = req.user.id;
  audit(userId,"account_deleted",{},req);
  db.prepare("DELETE FROM users WHERE id=?").run(userId);
  res.clearCookie("sid",{path:"/"});
  res.json({ ok:true });
});

// ══ EXPORT ════════════════════════════════════════════════════
app.get("/api/export", requireAuth, (req,res) => {
  const messages = db.prepare("SELECT role,content_enc,persona,created_at FROM messages WHERE user_id=? ORDER BY created_at ASC").all(req.user.id)
    .map(m => ({ role:m.role, content:decryptText(m.content_enc), persona:m.persona, createdAt:m.created_at }));
  const memories = db.prepare("SELECT text_enc,kind,importance,created_at FROM memories WHERE user_id=? ORDER BY created_at ASC").all(req.user.id)
    .map(m => ({ text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at }));
  res.setHeader("Content-Type","application/json");
  res.setHeader("Content-Disposition","attachment; filename=export-elissia.json");
  res.send(JSON.stringify({ exportedAt:now(), user:publicUser(req.user), messages, memories }, null, 2));
});

// ══ TTS PIPER ═════════════════════════════════════════════════
app.get("/api/tts/piper/status", requireAuth, (req,res) => {
  const bin = process.env.PIPER_BIN||"", model = process.env.PIPER_MODEL||"";
  res.json({ ok:true, enabled:Boolean(bin&&model&&fs.existsSync(bin)&&fs.existsSync(model)), voiceName:process.env.PIPER_VOICE_NAME||"Piper local" });
});
app.post("/api/tts/piper", requireAuth, requireCsrf, rateLimit("tts",120,3600000), async (req,res) => {
  const text = clean(req.body.text,1500);
  const bin = process.env.PIPER_BIN||"", model = process.env.PIPER_MODEL||"";
  if (!text) return res.status(400).json({ ok:false, error:"Texte vide." });
  if (!bin||!model||!fs.existsSync(bin)||!fs.existsSync(model)) return res.status(501).json({ ok:false, error:"Piper non configuré." });
  const out = path.join(os.tmpdir(), "elissia-" + id() + ".wav");
  const result = spawnSync(bin, ["--model",model,"--output_file",out], { input:text, encoding:"utf8", timeout:60000 });
  if (result.status!==0||!fs.existsSync(out)) return res.status(500).json({ ok:false, error:"Erreur Piper." });
  const wav = fs.readFileSync(out); fs.unlinkSync(out);
  res.setHeader("Content-Type","audio/wav"); res.setHeader("Cache-Control","no-store");
  res.send(wav);
});

// ══ PLUGINS ═══════════════════════════════════════════════════
app.get("/api/plugins", requireAuth, (req,res) => { res.json({ ok:true, plugins:pluginEngine.listPlugins() }); });
app.get("/api/ollama-status", async (req,res) => {
  try {
    const r = await fetch(OLLAMA_URL+"/api/tags",{signal:AbortSignal.timeout(5000)});
    const j = await r.json();
    res.json({ ok:true, models:j.models?.map(m=>m.name)||[] });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

/* ═══════════════════════════════════════
   ROUTES PROXY COMFYUI (diagnostic + modèles)
═══════════════════════════════════════ */

// Proxy transparent vers ComfyUI — pour contourner CORS du navigateur
app.get("/api/comfy/models", requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
    const d = await r.json();
    const models = d?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    res.json({ ok: true, models, comfyUrl: COMFY_URL });
  } catch(e) {
    res.status(503).json({ ok: false, error: "ComfyUI inaccessible: " + e.message, comfyUrl: COMFY_URL });
  }
});

// Proxy object_info — pour diagnostiquer les nodes disponibles
app.get("/api/comfy/object-info", requireAuth, async (req, res) => {
  try {
    const node = req.query.node || "CheckpointLoaderSimple";
    const r = await fetch(`${COMFY_URL}/object_info/${node}`);
    const d = await r.json();
    res.json({ ok: true, data: d });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.get("/api/comfy/status", requireAuth, async (req, res) => {
  try {
    const r = await fetch(`${COMFY_URL}/system_stats`);
    const d = await r.json();
    res.json({ ok: true, stats: d, comfyUrl: COMFY_URL });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════
   ROUTES COMPAGNES (multi-compagnes)
═══════════════════════════════════════ */

// Liste toutes les compagnes de l'utilisateur
