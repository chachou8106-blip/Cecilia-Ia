// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — routes/companions.js : CRUD compagnons, avatars, photos
// ═══════════════════════════════════════════════════════════════
app.get("/api/companions", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM companions WHERE user_id=? ORDER BY sort_order ASC, created_at ASC").all(req.user.id);
  const companions = rows.map(c => ({
    id: c.id, name: decryptText(c.name_enc), persona: c.persona,
    profile: parseJson(decryptText(c.profile_enc), {}),
    avatarUrl: c.avatar_url_enc ? decryptText(c.avatar_url_enc) : null,
    seed: c.avatar_seed, isActive: Boolean(c.is_active),
    sortOrder: c.sort_order, createdAt: c.created_at
  }));
  res.json({ ok: true, companions });
});

// Créer une nouvelle compagne
app.post("/api/companions", requireAuth, requireCsrf, (req, res) => {
  const name    = clean(req.body.name || "Élissia", 80);
  const persona = clean(req.body.persona || "girlfriend", 50);
  const profile = req.body.profile || {};
  const compId  = id();
  // Seed déterministe basé sur l'ID compagne
  const seed = Math.abs(compId.split("").reduce((a,c) => ((a<<5)-a)+c.charCodeAt(0), 0)) % 4294967295;
  db.prepare("INSERT INTO companions(id,user_id,name_enc,persona,profile_enc,avatar_seed,created_at,updated_at,is_active,sort_order) VALUES(?,?,?,?,?,?,?,?,0,?)")
    .run(compId, req.user.id, encryptText(name), persona, encryptText(JSON.stringify(profile)), String(seed), now(), now(),
      db.prepare("SELECT COUNT(*) c FROM companions WHERE user_id=?").get(req.user.id).c);
  res.json({ ok: true, id: compId, name, persona, seed: seed });
});

// Mettre à jour une compagne
app.put("/api/companions/:id", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT id FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });
  const name    = req.body.name    ? clean(req.body.name, 80) : null;
  const persona = req.body.persona ? clean(req.body.persona, 50) : null;
  const profile = req.body.profile || null;
  if (name)    db.prepare("UPDATE companions SET name_enc=?,updated_at=? WHERE id=?").run(encryptText(name), now(), compId);
  if (persona) db.prepare("UPDATE companions SET persona=?,updated_at=? WHERE id=?").run(persona, now(), compId);
  if (profile) db.prepare("UPDATE companions SET profile_enc=?,updated_at=? WHERE id=?").run(encryptText(JSON.stringify(profile)), now(), compId);
  res.json({ ok: true });
});

// Supprimer une compagne
app.delete("/api/companions/:id", requireAuth, requireCsrf, (req, res) => {
  const compId = clean(req.params.id, 80);
  db.prepare("DELETE FROM companions WHERE id=? AND user_id=?").run(compId, req.user.id);
  db.prepare("DELETE FROM companion_photos WHERE companion_id=? AND user_id=?").run(compId, req.user.id);
  res.json({ ok: true });
});

// Générer et sauvegarder un avatar pour une compagne spécifique
app.post("/api/companions/:id/avatar", requireAuth, requireCsrf, rateLimit("genimg",10,3600000), async (req, res) => {
  // ComfyUI local — pas de clé requise
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  try {
    const profile = parseJson(decryptText(row.profile_enc), {});
    const seed    = parseInt(row.avatar_seed) || null;
    const prompt  = personality.buildAvatarPromptFromProfile(profile);
    const url     = await civitaiGenerateImage(prompt, "realistic", seed);

    // Sauvegarder en base — permanent
    db.prepare("UPDATE companions SET avatar_url_enc=?,updated_at=? WHERE id=?").run(encryptText(url), now(), compId);
    // Aussi dans companion_photos pour l'historique
    db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(), compId, req.user.id, encryptText(url), encryptText(prompt), "realistic", String(seed||""), now());

    res.json({ ok: true, url, avatarUrl: url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Générer une photo pour une compagne (selfie, sensuelle, etc.) — sauvegardée en permanence
app.post("/api/companions/:id/photo", requireAuth, requireCsrf, rateLimit("genimg",10,3600000), async (req, res) => {
  // ComfyUI local — pas de clé requise
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  try {
    const profile  = parseJson(decryptText(row.profile_enc), {});
    const style    = clean(req.body.style || "realistic", 20);
    const context  = clean(req.body.context || "casual", 20);
    const seed     = parseInt(row.avatar_seed) || null; // même seed = même visage
    const prompt   = req.body.prompt || personality.buildSelfiePrompt(profile, context);
    const url      = await civitaiGenerateImage(prompt, style, seed);

    // Sauvegarder en permanence
    db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,prompt_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id(), compId, req.user.id, encryptText(url), encryptText(prompt), style, String(seed||""), now());

    res.json({ ok: true, url });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Récupérer toutes les photos d'une compagne
app.get("/api/companions/:id/photos", requireAuth, (req, res) => {
  const compId = clean(req.params.id, 80);
  const photos = db.prepare("SELECT * FROM companion_photos WHERE companion_id=? AND user_id=? ORDER BY created_at DESC LIMIT 50").all(compId, req.user.id);
  res.json({ ok: true, photos: photos.map(p => ({
    id: p.id, url: decryptText(p.url_enc), style: p.style,
    prompt: decryptText(p.prompt_enc||""), createdAt: p.created_at
  }))});
});

// Chat avec une compagne spécifique (utilise son profil)
app.post("/api/companions/:id/chat", requireAuth, requireCsrf, rateLimit("chat",60,3600000), async (req, res) => {
  const compId = clean(req.params.id, 80);
  const row = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(compId, req.user.id);
  if (!row) return res.status(404).json({ ok: false, error: "Compagne introuvable" });

  // Construire un user "virtuel" avec le profil de cette compagne
  const compProfile = parseJson(decryptText(row.profile_enc), {});
  const compName    = decryptText(row.name_enc);
  const fakeUser = {
    ...req.user,
    ai_name_enc: encryptText(compName),
    preferred_persona: row.persona,
    extended_profile_enc: encryptText(JSON.stringify(compProfile))
  };

  // Déléguer au handler de chat standard
  req.user = fakeUser;
  req.body.companionId = compId;
  // Re-router vers le handler /api/chat/stream
  // Pour simplifier : appeler directement le LLM ici
  const message = clean(req.body.message, 4000);
  if (!message) return res.status(400).json({ ok: false, error: "Message vide" });

  const u = publicUser(fakeUser);
  const sysPrompt = buildSystemPrompt(fakeUser, row.persona, message, {});
  // ✅ v18.2 — recentMsgs scopé par companion_id + fil solo (était global → mélange tous les compagnons)
  const recentMsgs = db.prepare(
    "SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')='solo' ORDER BY created_at DESC LIMIT 20"
  ).all(req.user.id, compId).reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));

  const llmMessages = [
    { role: "system", content: sysPrompt },
    ...recentMsgs,
    { role: "user", content: message }
  ];

  res.writeHead(200, { "Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache","Connection":"keep-alive" });
  res.write(JSON.stringify({ type:"start", companion: compName }) + "\n");

  let full = await ollamaStream(llmMessages, token => {
    res.write(JSON.stringify({ type:"token", token }) + "\n");
  });

  // ✅ v18.2 — companion_id + thread 'solo' ajoutés (était orphelin → pastilles jamais incrémentées)
  db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,thread,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id(), req.user.id, "assistant", encryptText(full), row.persona, compId, "solo", now());

  res.write(JSON.stringify({ type:"done", reply: full, companion: compName }) + "\n");
  res.end();
});

/* ═══════════════════════════════════════
   WEB SEARCH — PERPLEXITY
   Utilisé pour enrichir les prompts photo/vidéo
   et répondre aux questions d'actualité
═══════════════════════════════════════ */
app.post("/api/websearch/perplexity", requireAuth, requireCsrf, rateLimit("websearch",20,3600000), async (req,res) => {
  const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PERPLEXITY_KEY) return res.json({ ok:false, error:"Clé Perplexity non configurée dans .env" });

  const { query, mode = "chat" } = req.body;
  if (!query) return res.status(400).json({ ok:false, error:"query manquante" });

  try {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PERPLEXITY_KEY}`
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: mode === "photo"
              ? "Tu es un expert en photographie et en génération d'images IA. Donne des descriptions visuelles précises et évocatrices pour guider la génération d'images. Réponds en anglais (pour les prompts) et en 2-3 phrases maximum."
              : "Tu es un assistant connecté à internet. Réponds en français, de façon concise et précise avec les informations les plus récentes."
          },
          { role: "user", content: query }
        ],
        max_tokens: 300,
        temperature: 0.7,
        search_recency_filter: "week"
      })
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      throw new Error(`Perplexity ${r.status}: ${err.slice(0,200)}`);
    }

    const data = await r.json();
    const result = data.choices?.[0]?.message?.content || "";
    const citations = data.citations || [];

    console.log(`[Perplexity] Query: "${query.slice(0,50)}" → ${result.length} chars`);
    res.json({ ok:true, result, citations });
  } catch(e) {
    console.error("[Perplexity]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* ═══════════════════════════════════════
   GALERIE PHOTOS AI
   ⚠️ DOUBLONS NEUTRALISÉS v9 — ces routes étaient redéfinies ici mais
   jamais atteintes (Express utilise la 1re définition plus haut).
   L'ancienne requête gallery ne lisait pas la colonne "style" et la liste
   "styles" plate était incomplète. Versions actives = celles plus haut.
═══════════════════════════════════════ */
// app.get("/api/gallery", ...) — voir définition active plus haut (avec colonne style)
// app.get("/api/generate/styles", ...) — voir définition active plus haut (catalogue + styles)

/* ═══════════════════════════════════════
   ROUTES STATIQUES
═══════════════════════════════════════ */
app.get("/mobile",       (req,res) => res.sendFile(path.join(__dirname,"public-v5","mobile.html")));
app.get("/v5.css",       (req,res) => res.sendFile(path.join(__dirname,"public-v5","v5.css")));
app.get("/v5.js",        (req,res) => res.sendFile(path.join(__dirname,"public-v5","v5.js")));
app.get("/manifest.json",(req,res) => res.json({
  name:"ÉLISSIA",short_name:"ÉLISSIA",start_url:"/mobile",display:"standalone",
  background_color:"#111018",theme_color:"#ff3f91",
  icons:[{src:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='192' height='192'%3E%3Crect width='192' height='192' rx='48' fill='%23ff3f91'/%3E%3Ctext x='96' y='122' text-anchor='middle' font-size='84'%3E%F0%9F%92%97%3C/text%3E%3C/svg%3E",sizes:"192x192",type:"image/svg+xml"}]
}));
app.get("/sw.js",(req,res) => res.type("js").send(`
const CACHE="elissia-v8";const ASSETS=["/mobile","/v5.css","/v5.js","/manifest.json"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",e=>{const u=new URL(e.request.url);if(u.pathname.startsWith("/api/")||u.pathname.startsWith("/uploads/")){e.respondWith(fetch(e.request));return}e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)))});
`));

// ══════════════════════════════════════════════════════════════
// GÉNÉRATION PHOTO COMPAGNON avec son profil exact
// ══════════════════════════════════════════════════════════════
app.post("/api/companions/:id/generate-avatar", requireAuth, requireCsrf, rateLimit("genimg",15,3600000), async (req,res) => {
  try {
    const compRow = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(req.params.id, req.user.id);
    if (!compRow) return res.status(404).json({ ok:false, error:"Compagnon introuvable" });
    
    // Profil compagnon = source de vérité
    const compProfile = parseJson(decryptText(compRow.profile_enc), {});
    // ✅ v18.1 — profil du compagnon = source de vérité (style/seed restent gérés à part)
    const ext  = compProfile;
    const style = clean(req.body.style || "portrait", 40);
    const seed  = req.body.seed ? parseInt(req.body.seed) : (parseInt(compRow.avatar_seed)||Math.floor(Math.random()*2**32));
    
    console.log(`[CompGen] ${decryptText(compRow.name_enc)} — genre:${ext.genre} corp:${ext.corpulence} seed:${seed}`);
    
    // Générer
    const prompt = buildComfyPromptFinal(ext, style);
    const url    = await comfyGenerateImage(prompt, style, seed);
    if (!url) return res.status(500).json({ ok:false, error:"Génération échouée" });
    
    // Sauvegarder comme avatar du compagnon
    db.prepare("UPDATE companions SET avatar_url_enc=?, avatar_seed=?, updated_at=? WHERE id=?")
      .run(encryptText(url), seed, now(), compRow.id);
    
    // Sauvegarder dans les photos du compagnon
    try {
      db.prepare("INSERT INTO companion_photos(id,companion_id,user_id,url_enc,style,seed,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), compRow.id, req.user.id, encryptText(url), style, seed, now());
    } catch {}
    
    res.json({ ok:true, url, companionId:compRow.id, prompt_preview:prompt.slice(0,150) });
  } catch(e) {
    console.error("[CompGen]", e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// SUPPRESSION D'UN MESSAGE (photo ou texte) du chat
// ══════════════════════════════════════════════════════════════
app.delete("/api/messages/:id", requireAuth, requireCsrf, (req,res) => {
