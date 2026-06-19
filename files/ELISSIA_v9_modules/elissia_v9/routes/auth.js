// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — routes/auth.js : health, auth, profil, avatar, state
// ═══════════════════════════════════════════════════════════════
async function generateVideoFromChat(userId, ext, explicit = false, chatMessages = []) {
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) throw new Error("FFmpeg non disponible. Lance: npm install @ffmpeg-installer/ffmpeg");

  // ✅ v13 — Construire la scène depuis la RÉPONSE IA (ce qu'elle décrit faire)
  // On lit le dernier message ASSISTANT pour extraire l'action décrite
  let sceneContext = "";
  const lastAiMsg = chatMessages.filter(m => m.role === "assistant").pop()?.content || "";
  const lastUserMsg = chatMessages.filter(m => m.role === "user").pop()?.content || "";
  const allContext = (lastAiMsg + " " + lastUserMsg).toLowerCase();

  if (/masturb|branle|ma (main|queue|bite|membre).*ma main|glisse.*ma queue/i.test(lastAiMsg)) {
    sceneContext = ", masturbating hand on cock, erotic self-touching, hand gripping penis, sensual solo act";
  } else if (/quatre pattes|à genoux|doggy|derrière toi|courb/i.test(allContext)) {
    sceneContext = ", on all fours doggy style pose, bent over presenting curves, sensual pose";
  } else if (/suce|fellation|bouche|lèche|avale/i.test(lastAiMsg)) {
    sceneContext = ", sensual mouth open, licking lips, provocative oral suggestion, tongue out";
  } else if (/déshabill|enlève|retire|dénude|nue/i.test(allContext)) {
    sceneContext = ", undressing slowly removing clothes, stripping, seductive revealing pose";
  } else if (/domin|fouet|fesse.*marqu|punish|coups/i.test(allContext)) {
    sceneContext = ", dominant powerful commanding pose, intense direct gaze, authority";
  } else if (/approch|vien(s)?|rejoin/i.test(allContext)) {
    sceneContext = ", walking towards camera sensually, reaching forward, seductive approach";
  } else if (/câlin|tendresse|amour|embrass/i.test(allContext)) {
    sceneContext = ", tender loving expression, arms open, romantic soft pose";
  } else {
    sceneContext = ", sensual confident pose, direct camera gaze, showing body";
  }
  console.log("[VideoChat] Scène détectée:", sceneContext.trim());

  const basePrompt = buildComfyPromptFinal(ext, explicit ? "nue" : "sensuelle");
  const frames = [];
  const seed = getAvatarSeed(ext);
  // ✅ v13 — Poses progressives qui correspondent à l'action détectée
  // Chaque frame montre une progression de l'action
  const getExpressions = (scene) => {
    if (scene.includes("masturbat") || scene.includes("hand on cock") || scene.includes("gripping penis")) {
      return [
        "standing looking at camera with a seductive smile, hands at sides",
        "reaching hand down towards groin, sensual expression",
        "hand near groin area, aroused expression, biting lip",
        "sensual expression face flushed with arousal",
        "satisfied expression post-arousal, catching breath"
      ];
    }
    if (scene.includes("all fours") || scene.includes("doggy") || scene.includes("bent over")) {
      return [
        "standing, turning to show her from behind",
        "bending forward slightly, hands on knees",
        "bent over showing curves, looking back over shoulder",
        "doggy position showing large ass and back",
        "arched back, looking back seductively"
      ];
    }
    if (scene.includes("undress") || scene.includes("stripping")) {
      return [
        "fully clothed or minimal clothing, seductive look",
        "removing top, showing shoulders",
        "topless, showing large breasts, arms up",
        "pushing clothing down hips",
        "fully nude standing, confident display"
      ];
    }
    return [
      "standing confident sensual pose",
      "slight turn showing curves",
      "hands on hips direct gaze",
      "leaning forward slightly",
      "seductive expression direct look"
    ];
  };
  const microExpressions = getExpressions(sceneContext);

  for (let i = 0; i < 5; i++) {
    const framePrompt = basePrompt + ", " + microExpressions[i] + ", consistent same face and body, " + sceneContext.replace(/^,\s*/, "");
    const url = await comfyGenerateImage(framePrompt, explicit ? "nue" : "sensuelle", seed + i);
    const abs = url.startsWith("/uploads/") ? path.join(UPLOADS_DIR, url.replace("/uploads/", "")) : url;
    if (fs.existsSync(abs)) { frames.push(abs); console.log(`[VideoChat] Frame ${i+1}/5`); }
  }

  if (frames.length < 2) throw new Error("Pas assez de frames ComfyUI générées pour la vidéo");

  const vidName = "chat_vid_" + userId + "_" + Date.now() + ".mp4";
  const vidPath = path.join(UPLOADS_DIR, vidName);
  await assembleMP4(frames, vidPath, 24);
  return "/uploads/" + vidName;
}

// Alias pour compatibilité existante
async function civitaiGenerateVideo(prompt, explicit = false) {
  // Ce chemin est utilisé par la route /api/generate/video (selfie vidéo)
  // Génère une vidéo courte à partir d'un prompt direct
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) throw new Error("FFmpeg requis. Lance: npm install @ffmpeg-installer/ffmpeg");

  const frames = [];
  const seed = Math.floor(Math.random() * 2**32);
  const style = explicit ? "nue" : "sensuelle";
  const extras = ["looking at camera", "slight smile", "sensual gaze", "playful expression", "natural pose"];

  for (let i = 0; i < 4; i++) {
    const fp = prompt + ", " + extras[i] + ", consistent face, same person";
    const url = await comfyGenerateImage(fp, style, seed + i);
    const abs = url.startsWith("/uploads/") ? path.join(UPLOADS_DIR, url.replace("/uploads/", "")) : url;
    if (fs.existsSync(abs)) frames.push(abs);
  }

  if (frames.length < 2) throw new Error("Génération de frames échouée");
  const fname = "ai_vid_" + Date.now() + ".mp4";
  const fpath = path.join(UPLOADS_DIR, fname);
  await assembleMP4(frames, fpath, 24);
  return "/uploads/" + fname;
}

/* ═══════════════════════════════════════
   ROUTES API
═══════════════════════════════════════ */

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: APP_NAME, version: "9.0", mode: MODE,
    ollamaModel: OLLAMA_MODEL, comfy: COMFY_URL, piper: !!process.env.PIPER_BIN });
});

// ══ AUTH ══════════════════════════════════════════════════════
app.post("/api/auth/register", rateLimit("register", 5, 3600000), async (req, res) => {
  try {
    if (!ALLOW_REGISTRATION) return res.status(403).json({ ok:false, error:"Inscription désactivée." });
    if (INVITE_CODE && clean(req.body.inviteCode,200) !== INVITE_CODE) return res.status(403).json({ ok:false, error:"Code invitation invalide." });
    const email = clean(req.body.email,200).toLowerCase();
    const password = String(req.body.password||"");
    const displayName = clean(req.body.displayName||"Mon amour",80);
    const consent = Boolean(req.body.rgpdConsent);
    if (!email.includes("@")) return res.status(400).json({ ok:false, error:"Email invalide." });
    if (password.length < 10) return res.status(400).json({ ok:false, error:"Mot de passe: minimum 10 caractères." });
    if (!consent) return res.status(400).json({ ok:false, error:"Consentement requis." });
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email)) return res.status(409).json({ ok:false, error:"Compte déjà existant." });
    const count = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    const userId = id();
    const hash = await bcrypt.hash(password, 12);
    db.prepare(`INSERT INTO users(id,email,password_hash,display_name_enc,ai_name_enc,relationship_style_enc,preferred_persona,rgpd_consent,privacy_accepted_at,is_admin,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'girlfriend',1,?,?,?,?)`).run(userId,email,hash,encryptText(displayName),encryptText("Élissia"),encryptText("romantique"),now(),count===0?1:0,now(),now());
    const csrf = createSession(userId, req, res);
    audit(userId,"user_registered",{emailHash:sha256(email)},req);
    res.json({ ok:true, csrf, user:publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(userId)) });
  } catch(e) { console.error(e); res.status(500).json({ ok:false, error:"Erreur inscription." }); }
});

app.post("/api/auth/login", rateLimit("login",10,900000), async (req,res) => {
  const email = clean(req.body.email,200).toLowerCase();
  const password = String(req.body.password||"");
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    audit(user?user.id:null,"login_failed",{emailHash:sha256(email)},req);
    return res.status(401).json({ ok:false, error:"Identifiants invalides." });
  }
  const csrf = createSession(user.id, req, res);
  audit(user.id,"login_success",{},req);
  res.json({ ok:true, csrf, user:publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req,res) => {
  const newCsrf = crypto.randomBytes(32).toString("hex");
  try { db.prepare("UPDATE sessions SET csrf_hash=? WHERE id=?").run(sha256(newCsrf), req.session.id); } catch(e) { console.error("[csrf]",e.message); }
  res.json({ ok:true, csrf:newCsrf, user:publicUser(req.user) });
});

app.post("/api/auth/logout", requireAuth, requireCsrf, (req,res) => {
  db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(now(), req.session.id);
  res.clearCookie("sid",{path:"/"});
  res.json({ ok:true });
});

// ══ PROFIL PRINCIPAL ══════════════════════════════════════════
app.put("/api/profile", requireAuth, requireCsrf, (req,res) => {
  const displayName = clean(req.body.displayName||"Mon amour",80);
  const aiName      = clean(req.body.aiName||"Élissia",80);
  const style       = clean(req.body.relationshipStyle||"romantique",120);
  const persona     = clean(req.body.preferredPersona||"girlfriend",50);
  const age         = Boolean(req.body.ageConfirmed);
  const adult       = Boolean(req.body.adultMode) && age;
  const consent     = Boolean(req.body.rgpdConsent);
  const webSearch   = Boolean(req.body.webSearchEnabled);
  const autoPhoto   = Boolean(req.body.autoPhoto);
  if (!consent) return res.status(400).json({ ok:false, error:"Consentement requis." });
  db.prepare(`UPDATE users SET display_name_enc=?,ai_name_enc=?,relationship_style_enc=?,preferred_persona=?,age_confirmed=?,adult_mode=?,web_search_enabled=?,rgpd_consent=1,privacy_accepted_at=COALESCE(privacy_accepted_at,?),updated_at=? WHERE id=?`)
    .run(encryptText(displayName),encryptText(aiName),encryptText(style),persona,age?1:0,adult?1:0,webSearch?1:0,now(),now(),req.user.id);
  // Reprogrammer le workflow proactif
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const ext = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};
  if (autoPhoto) ext.auto_photo = true;
  scheduleProactiveMessages(req.user.id, ext, aiName);
  audit(req.user.id,"profile_updated",{persona,adult},req);
  res.json({ ok:true, user:publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});

// ══ PROFIL ÉTENDU — CORRECTIF v8 COMPLET ═════════════════════
const EXTENDED_ALLOWED_FIELDS = [
  // Identité
  "genre","age","origine","langue","histoire","user_genre",
  // Silhouette globale
  "corpulence","tonicite","taille","poids","texture_cheveux",
  // Visage & cheveux
  "cheveux","longueur_cheveux","yeux","couleur_peau","taille_levres","maquillage",
  // Corps féminin
  "taille_seins","forme_seins","teton",
  "forme_fesses","forme_fesses_shape","hanches","ventre","jambes",
  // Anatomie intime féminine
  "pilosite","style_pilosite","couleur_pilosite","levres_intimes","clitoris","morpho_intime",
  // Corps masculin
  "pectoraux","abdominaux","taille_sexe_m","epaisseur_sexe_m","forme_sexe_m",
  "circoncis","testicules","pilosite_masc",
  // Trans / Hybride
  "anatomie_libre","statut_chirurgical",
  // Accessoires & bijoux
  "tatouages","piercings","style","tenue_preferee",
  "lunettes","bijoux","collier_bijou","boucles_oreilles","bague","bracelet","montre",
  "chaussures","sac","chapeau","casquette","bonnet",
  "ambiance_photo","decor_prefere","accent_voix","parfum",
  // Caractère
  "caractere","passions","profession","hobbies","reves","communication","valeurs",
  "humour","jalousie","independance","gestion_conflits","traits_perso",
  // Sexualité
  "kinks","fantasmes","limites","preferences_chat",
  "orientations","pratiques","rythme","tendresse",
  "niveau_intensite","initiative_sexuelle",
  "curseur_douceur","curseur_crudite","curseur_domination",
  "curseur_humiliation","curseur_romantisme","curseur_initiative",
  // Relation & Prefs
  "relation","proactivite","auto_photo","scenario_format",
  "envies_pratiques","mes_jouets","voix",
  // Mémoire & Avatar
  "avatar_description","avatar_seed","avatar_url_ref","avatar_animated_url"
];

app.put("/api/profile/extended", requireAuth, requireCsrf, (req,res) => {
  // Lire le profil existant et MERGER (ne pas écraser)
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const existing = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};

  const data = { ...existing };
  for (const k of EXTENDED_ALLOWED_FIELDS) {
    if (req.body[k] !== undefined) data[k] = String(req.body[k]).slice(0, 2000);
  }

  db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
    .run(encryptText(JSON.stringify(data)), now(), req.user.id);

  // Reprogrammer le workflow proactif si la proactivité a changé
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
  const aiName = decryptText(user.ai_name_enc) || "Élissia";
  scheduleProactiveMessages(req.user.id, data, aiName);

  res.json({ ok:true, extendedProfile: data });
});

app.get("/api/profile/extended", requireAuth, (req,res) => {
  const row = db.prepare("SELECT extended_profile_enc FROM users WHERE id=?").get(req.user.id);
  const profile = row?.extended_profile_enc ? parseJson(decryptText(row.extended_profile_enc),{}) : {};
  res.json({ ok:true, extendedProfile: profile });
});

// ══ AVATAR ════════════════════════════════════════════════════

// ✅ Upload portrait depuis l'appareil (fix MulterError "avatar" field)
const uploadAvatarMw = multer({ storage, limits:{fileSize:20*1024*1024},
  fileFilter:(req,file,cb) => cb(null,["image/jpeg","image/png","image/webp","image/gif"].includes(file.mimetype))
}).single("avatar");

app.post("/api/avatar/upload", requireAuth, requireCsrf, (req,res) => {
  uploadAvatarMw(req, res, async (err) => {
    if (err) return res.status(400).json({ok:false,error:err.message});
    if (!req.file) return res.status(400).json({ok:false,error:"Aucun fichier."});
    const localUrl = `/uploads/${req.file.filename}`;
    let desc = null;
    try {
      const uu = publicUser(req.user);
      desc = await analyzeImage(path.join(UPLOADS_DIR,req.file.filename),(uu.extendedProfile||{}).user_genre||"",!!(req.user.adult_mode));
      if (desc && desc!=="__VISION_INDISPONIBLE__") {
        const ex2 = uu.extendedProfile||{};
        db.prepare("UPDATE users SET extended_profile_enc=?,updated_at=? WHERE id=?")
          .run(encryptText(JSON.stringify({...ex2,avatar_description:desc})),now(),req.user.id);
      }
    } catch(e){console.warn("[avatar/upload]",e.message);}
    db.prepare("UPDATE users SET avatar_enc=?,updated_at=? WHERE id=?").run(encryptText(localUrl),now(),req.user.id);
    try{db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,original_name,mime_type,source,ai_analysis,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(),req.user.id,localUrl,req.file.originalname,req.file.mimetype,"user_upload",desc||null,now());}catch{}
    res.json({ok:true,url:localUrl,avatarUrl:localUrl});
  });
});

app.post("/api/avatar", requireAuth, requireCsrf, async (req,res) => {
  const avatar = req.body.avatar;
  if (!avatar) return res.status(400).json({ ok:false, error:"Avatar manquant." });

  // ✅ v11 — Analyser la photo uploadée avec llava pour que l'IA la connaisse
  let avatarDescription = null;
  try {
    const u = publicUser(req.user);
    const ext = u.extendedProfile || {};
    avatarDescription = await analyzeImage(avatar, ext.user_genre || "", !!(req.user.adult_mode));
    if (avatarDescription && avatarDescription !== "__VISION_INDISPONIBLE__") {
      // Stocker la description dans le profil pour que l'IA s'en souvienne
      const updExt = { ...ext, avatar_description: avatarDescription };
      db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
        .run(encryptText(JSON.stringify(updExt)), now(), req.user.id);
      console.log("[Avatar Upload] Description llava:", avatarDescription.slice(0,80));
    }
  } catch(e) { console.warn("[Avatar Upload Vision]", e.message); }

  db.prepare("UPDATE users SET avatar_enc=?, updated_at=? WHERE id=?").run(encryptText(avatar), now(), req.user.id);
  res.json({ ok:true, avatarUrl: avatar, description: avatarDescription });
});
app.delete("/api/avatar", requireAuth, requireCsrf, (req,res) => {
  db.prepare("UPDATE users SET avatar_enc=NULL, updated_at=? WHERE id=?").run(now(), req.user.id);
  res.json({ ok:true });
});

// ══ ÉTAT GLOBAL ═══════════════════════════════════════════════
app.get("/api/state", requireAuth, (req,res) => {
  const cid = req.query.companionId || null;
  const messages = cid
    ? db.prepare("SELECT id,role,content_enc,persona,media_url,media_type,created_at FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')='solo' ORDER BY created_at ASC LIMIT 300").all(req.user.id, cid)
        .map(m => ({ id:m.id, role:m.role, content:decryptText(m.content_enc), persona:m.persona, mediaUrl:m.media_url, mediaType:m.media_type, createdAt:m.created_at }))
    : db.prepare("SELECT id,role,content_enc,persona,media_url,media_type,created_at FROM messages WHERE user_id=? AND companion_id IS NULL AND COALESCE(thread,'solo')='solo' ORDER BY created_at ASC LIMIT 300").all(req.user.id)
        .map(m => ({ id:m.id, role:m.role, content:decryptText(m.content_enc), persona:m.persona, mediaUrl:m.media_url, mediaType:m.media_type, createdAt:m.created_at }));
  const memories = db.prepare("SELECT id,text_enc,kind,importance,created_at,updated_at FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(req.user.id)
    .map(m => ({ id:m.id, text:decryptText(m.text_enc), kind:m.kind, importance:m.importance, createdAt:m.created_at, updatedAt:m.updated_at }));
  res.json({ ok:true, user:publicUser(req.user), messages, memories });
});

// ══ CHAT STREAMING ════════════════════════════════════════════
