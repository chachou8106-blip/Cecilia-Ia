// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — routes/chat.js : /api/chat/stream
// ═══════════════════════════════════════════════════════════════
app.post("/api/chat/stream", requireAuth, requireCsrf, rateLimit("chat",60,3600000), async (req,res) => {
  try {
    const message = clean(req.body.message, 4000);
    const mediaUrl = req.body.mediaUrl || null;
    let   realAnalysis = req.body.mediaAnalysis || null;
    // ✅ MULTI-COMPAGNONS : charger le profil du compagnon si fourni
    const companionId = req.body.companionId ? clean(req.body.companionId, 80) : null;
    let companionRow = null;
    if (companionId) companionRow = db.prepare("SELECT * FROM companions WHERE id=? AND user_id=?").get(companionId, req.user.id);
    const persona = clean((companionRow ? companionRow.persona : null) || req.body.persona || req.user.preferred_persona, 50);

    if (!message && !mediaUrl) return res.status(400).json({ ok:false, error:"Message vide." });
    if (!req.user.rgpd_consent) return res.status(403).json({ ok:false, error:"Consentement requis." });

    const mod = moderation(message);
    if (!mod.allowed) {
      audit(req.user.id,"moderation_block",{category:mod.category},req);
      return res.status(400).json({ ok:false, error:"Contenu illégal refusé (mineurs, zoophilie, non-consentement réel)." });
    }

    // Plugin beforeChat
    const pluginBefore = await pluginEngine.runHook("beforeChat", { userId:req.user.id, user:publicUser(req.user), message, persona });
    if (pluginBefore?.block) return res.status(400).json({ ok:false, error:pluginBefore.userMessage||"Bloqué." });

    // Vision si image
    const u = publicUser(req.user);
    const ext = u.extendedProfile || {};
    let visionRefus = false;
    if (mediaUrl && !realAnalysis && (req.body.mediaType||"").startsWith("image")) {
      realAnalysis = await analyzeImage(mediaUrl, ext.user_genre || "", !!(freshUser.adult_mode));
    }
    if (realAnalysis === "__VISION_INDISPONIBLE__") {
      visionRefus = true; realAnalysis = null;
      // Indiquer à l'IA qu'une photo a été envoyée mais non analysable
      console.warn("[Vision] Indisponible pour ce media");
    }
    // Si photo envoyée sans analyse → demander à l'IA de reconnaître qu'elle ne peut pas la voir
    if (mediaUrl && !realAnalysis && (req.body.mediaType||"").startsWith("image")) {
      realAnalysis = "__VISION_INDISPONIBLE__";
      visionRefus = true;
    }

    let userContent = message || "";
    if (mediaUrl && realAnalysis) {
      userContent = `[ANALYSE IMAGE RÉELLE : ${realAnalysis}]\n${message ? message : ""}`;
    } else if (mediaUrl && visionRefus) {
      userContent = `[WEBCAM/PHOTO REÇUE MAIS JE NE VOIS RIEN. RÈGLE ABSOLUE : ne jamais prétendre voir, ne jamais décrire un corps sans l'avoir vu. Demander : "décris-moi exactement ce que tu fais"]\n${message||""}`;
    } else if (mediaUrl) {
      userContent = `[IMAGE NON LISIBLE. Ne pas inventer ce qu'on ne voit pas.]\n${message||""}`;
    }

    // Sauvegarder message user — robuste aux ancienne DB
    try {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,media_url,media_type,companion_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "user", encryptText(userContent), persona, mediaUrl, req.body.mediaType||null, companionId||null, now());
    } catch(_e) {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "user", encryptText(userContent), persona, companionId||null, now());
    }

    // Apprentissage v12 — sauvegarde automatique enrichie
    if (message && !message.startsWith("[PROACTIF]") && !message.startsWith("[WEBCAM]")) {
      try {
        apprendreFaits(req.user.id, message);
        // ✅ v12 : sauvegarder TOUS les messages avec importance calculée automatiquement
        saveMemoryAuto(req.user.id, message, "user").catch(()=>{});
        // Consolidation périodique en arrière-plan (toutes les 20 conv)
        consolidateMemoriesIfNeeded(req.user.id).catch(()=>{});
        // Apprendre les accessoires et jouets mentionnés
        const accs = extraireAccessoires(message);
        if (accs.length) {
          const freshExt = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)).extendedProfile || {};
          let jouets = freshExt.mes_jouets || "";
          for (const a of accs) {
            if (!jouets.includes(a.fr)) {
              jouets = (jouets + " " + a.fr).trim();
              saveFact(req.user.id, "accessoire", a.fr);
            }
          }
          if (jouets !== (freshExt.mes_jouets||"")) {
            freshExt.mes_jouets = jouets;
            db.prepare("UPDATE users SET extended_profile_enc=?, updated_at=? WHERE id=?")
              .run(encryptText(JSON.stringify(freshExt)), now(), req.user.id);
            console.log("[Learn] Accessoires appris:", accs.map(a=>a.fr).join(", "));
          }
        }
      } catch(e) { console.error("[learn]",e.message); }
    }

    // Mémoires pertinentes
    const memories = await searchMemories(req.user.id, message||"media", companionId);
    const memContext = memories.length ? "Souvenirs pertinents:\n" + memories.map(m=>"- "+m.text).join("\n") : "";
    const profileContext = `Profil:\n- Nom: ${u.displayName}\n- IA: ${u.aiName}\n- Style: ${u.relationshipStyle}\n- Mode adulte: ${u.adultMode?"activé":"désactivé"}`;
    const pluginSys = pluginBefore?.systemPrompt ? String(pluginBefore.systemPrompt).slice(0,2000) : "";

    // Détection guidage/scénario
    const chatOptions = {};
    if ((message||"").includes("[WEBCAM]") && mediaUrl) {
      chatOptions.guidageMode = "webcam";
      chatOptions.descriptionImage = realAnalysis;
      chatOptions.visionRefus = visionRefus;
    } else if (mediaUrl && (req.body.mediaType||"").startsWith("image")) {
      chatOptions.guidageMode = "photo";
      chatOptions.descriptionImage = realAnalysis;
      chatOptions.visionRefus = visionRefus;
    }
    if (req.body.scenarioFormat) { chatOptions.scenarioFormat = req.body.scenarioFormat; chatOptions.scenarioSeed = req.body.scenarioSeed||null; }

    // CORRECTIF v8 : relire le user FRAIS depuis la DB
    const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
    // ✅ MULTI-COMPAGNONS : utiliser le profil du compagnon — le profil global n'est JAMAIS écrasé
    let userForPrompt = freshUser;
    if (companionRow) {
      const compProfile = parseJson(decryptText(companionRow.profile_enc), {});
      // ✅ v18.1 — En chat de compagnon, le profil DU COMPAGNON est la source de vérité.
      //   Le front envoyait l'ext du formulaire principal (Gaëlle), qui écrasait le profil
      //   du compagnon → Élissia "parlait comme Gaëlle". On n'utilise plus req.body.ext ici.
      const mergedExt = compProfile;
      userForPrompt = { ...freshUser, ai_name_enc: companionRow.name_enc,
        preferred_persona: companionRow.persona, extended_profile_enc: encryptText(JSON.stringify(mergedExt)) };
    } else if (req.body.ext) {
      const baseExt = publicUser(freshUser).extendedProfile || {};
      userForPrompt = { ...freshUser, extended_profile_enc: encryptText(JSON.stringify({...baseExt, ...req.body.ext})) };
    }
    const sysPrompt = buildSystemPrompt(userForPrompt, persona, message, chatOptions);

    const llmMessages = [
      { role:"system", content: sysPrompt },
      ...(pluginSys ? [{ role:"system", content:"Plugin:\n"+pluginSys }] : []),
      { role:"system", content: profileContext + (memContext ? "\n\n" + memContext : "") },
      ...recentMessages(req.user.id, companionId || undefined),
      { role:"user", content: userContent }
    ];

    res.writeHead(200, { "Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no" });
    res.write(JSON.stringify({ type:"start" }) + "\n");

    let full = await ollamaStream(llmMessages, token => {
      res.write(JSON.stringify({ type:"token", token }) + "\n");
    });

    // Modération réponse (uniquement si pas mode adulte)
    if (!freshUser.adult_mode) {
      const modReply = moderation(full);
      if (!modReply.allowed) full = "Active le mode adulte dans les paramètres.";
    }

    // ── Web search Perplexity si demande d'info d'actualité ──────────
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    const webSearchEnabled = Boolean(freshUser.web_search_enabled || freshUser.webSearchEnabled);
    const isWebQuery = /actu|news|aujourd|dernier|recent|2024|2025|2026|trump|bourse|crypto|guerre|election|sport|foot|meteo|resultat|score|sortie|nouveau|comment|pourquoi|quel|information|annonce|bitcoin/i.test(message || "")
        if (pxR.ok) {
          const pxData = await pxR.json();
          const pxResult = pxData.choices?.[0]?.message?.content || "";
          if (pxResult) {
            // Injecter le résultat web dans le contexte
            console.log(`[Web search] "${message.slice(0,40)}" → ${pxResult.slice(0,80)}`);
            // Ajouter une note dans la réponse si non déjà présent
            if (!full.includes(pxResult.slice(0,20))) {
              full = full + `

[🌐 Info web: ${pxResult}]`;
            }
          }
        }
      } catch(e) { console.warn("[websearch]", e.message); }
    }

    // Plugin afterChat
    const pluginAfter = await pluginEngine.runHook("afterChat", { userId:req.user.id, user:u, message, persona, reply:full });
    if (pluginAfter?.reply) full = String(pluginAfter.reply).slice(0,12000);

    // Traiter les tags médias dans la réponse ([PHOTO], [VIDEO])
    let mediaGenerated = null;
    // ── Forcer la génération si le MESSAGE UTILISATEUR demande une photo ──
    // Le LLM ignore souvent l'instruction → on force côté serveur
    const userWantsPhoto = /(photo|selfie|image|pic|montre|envoie|envoi).{0,30}(toi|vous|moi|la|une)|\[PHOTO\]|\[SELFIE/i.test(message || "");
    const llmRefuses     = /je (ne peux|suis une IA|n'ai pas de corps|ne peux pas envoyer)/i.test(full);
    
    if (userWantsPhoto && (llmRefuses || !full.includes("[PHOTO]"))) {
      // Remplacer le refus par une vraie génération
      if (llmRefuses) {
        full = full.replace(/[Mm]alheureusement.*?corps[^.]*\./gs, "")
                   .replace(/[Cc]omme je l.ai.*?corps[^.]*\./gs, "")
                   .replace(/je suis une IA[^.]*\./gi, "")
                   .replace(/je n.ai pas de corps[^.]*\./gi, "")
                   .trim();
        if (!full) full = "Voilà mon soumis...";
      }
      if (!full.includes("[PHOTO]") && !full.includes("[SELFIE")) {
        full += " [PHOTO]";
      }
    }
    
    // Détecter les promesses implicites — SEULEMENT si le user a demandé quelque chose de visuel
    const photoPromise = userWantsPhoto && /je (vais|peux|veux|pourrais) (t['']?envoyer|te montrer|partager).{0,60}(photo|selfie|image|selfie)/i.test(full);
    if (photoPromise && !full.includes("[PHOTO]") && !full.includes("[SELFIE")) {
      full += " [PHOTO]";
    }

    if (/\[PHOTO\]|\[SELFIE|\[IMG_GEN:/.test(full)) {
      try {
        // ✅ v13 FIX CRITIQUE : prendre le profil du compagnon actif, pas le profil user
        let ext2 = u.extendedProfile || {};
        if (companionRow) {
          ext2 = parseJson(decryptText(companionRow.profile_enc), {});
        }
        // Détecter le style dans le tag [SELFIE:style] ou [IMG_GEN:style]
        let photoStyle = "sensuelle";
        const styleMatch = full.match(/\[SELFIE:([^\]]+)\]/i) || full.match(/\[IMG_GEN:([^\]]+)\]/i);
        if (styleMatch) {
          const s = styleMatch[1].toLowerCase();
          if (s.includes("domin")) photoStyle = "dominatrice";
          else if (s.includes("nu") || s.includes("expli")) photoStyle = "nue";
          else if (s.includes("entier")) photoStyle = "entiere";
          else if (s.includes("cuir")) photoStyle = "tenue_cuir";
          else photoStyle = s;
        } else if (freshUser.adult_mode && /\bnu(e)?\b|déshabill|explic/i.test(full)) {
          photoStyle = "nue";
        }
        // Enrichissement Perplexity si description complexe
        let extraContext = "";
        const PKEY = process.env.PERPLEXITY_API_KEY;
        const msgForPhoto = message || "";
        if (PKEY && msgForPhoto.length > 50) {
          try {
            const pxR = await fetch("https://api.perplexity.ai/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${PKEY}` },
              body: JSON.stringify({
                model: "sonar",
                messages: [
                  { role: "system", content: "You are an expert AI image prompt writer. Convert the user's scene description into a precise photography prompt in English. Be explicit and descriptive about lighting, pose, atmosphere. Max 2 sentences." },
                  { role: "user", content: `Scene: ${msgForPhoto.slice(0, 200)}. Style: ${photoStyle}` }
                ],
                max_tokens: 150, temperature: 0.7
              })
            });
            if (pxR.ok) {
              const pxD = await pxR.json();
              extraContext = pxD.choices?.[0]?.message?.content || "";
            }
          } catch(e) { /* silencieux */ }
        }

        const photoPrompt = buildComfyPromptFinal(ext2, photoStyle) + (extraContext ? ", " + extraContext : "") +
          ((!extraContext && (photoStyle === "nue" || photoStyle === "sensuelle"))
            ? ", on bed with white satin sheets, intimate bedroom setting, soft warm candlelight" : "");
        const imgUrl = await comfyGenerateImage(photoPrompt, photoStyle, null);
        // ✅ v13 : nettoyage complet des tags techniques dans le texte affiché
        const textBeforePhoto = full.replace(/\[PHOTO(\:[^\]]*)?\]|\[SELFIE(\:[^\]]*)?\]|\[IMG_GEN(\:[^\]]*)?\]|\[VID_GEN(\:[^\]]*)?\]|\[VIDEO(\:[^\]]*)?\]|\[WEBCAM(\:[^\]]*)?\]/gi, "").replace(/,\s*$/, "").trim();
        // ✅ v12 — Elle PARLE avant d'envoyer la photo. Si le texte est vide, phrase par défaut.
        if (!textBeforePhoto || textBeforePhoto.length < 5) {
          const defaultPhrases = [
            "Voilà, je t'envoie ça avec amour 💕",
            "Tiens, un petit aperçu pour toi... 😘",
            "Je pensais à toi, alors j'ai pris ça 📸",
            "Regarde-moi... 🔥"
          ];
          full = defaultPhrases[Math.floor(Math.random() * defaultPhrases.length)];
        } else {
          full = textBeforePhoto;
        }
        mediaGenerated = { type: "image", url: imgUrl };
        console.log("[Chat→Photo] style:", photoStyle);
      } catch(e) { console.error("[PHOTO GEN]", e.message); }
    }

    if (/\[VIDEO\]|\[VID_GEN:/.test(full)) {
      try {
        // ✅ v18 — même correctif que la photo : profil de la compagne active, pas le profil principal
        let ext2 = u.extendedProfile || {};
        if (companionRow) ext2 = parseJson(decryptText(companionRow.profile_enc), {});
        const isExplicit = freshUser.adult_mode;
        const videoPrompt = personality.buildSelfiePrompt(ext2, isExplicit ? "explicit" : "sensuelle");
        const vidUrl = await civitaiGenerateVideo(videoPrompt, isExplicit);
        full = full.replace(/\[VIDEO\]|\[VID_GEN:[^\]]*\]/g, "");
        mediaGenerated = { type: "video", url: vidUrl };
      } catch(e) { console.error("[VIDEO GEN]", e.message); }
    }

    // Sauvegarder réponse — robuste aux ancienne DB
    try {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,media_url,companion_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "assistant", encryptText(full), persona, mediaGenerated?.url||null, companionId||null, now());
    } catch(_e2) {
      db.prepare("INSERT INTO messages(id,user_id,role,content_enc,persona,companion_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(id(), req.user.id, "assistant", encryptText(full), persona, companionId||null, now());
    }

    // ✅ v12 : sauvegarder aussi la réponse IA (ce qu'elle dit est important pour le contexte)
    const memorySaved = await saveMemoryAuto(req.user.id, message||"", "user");
    if (full && full.length > 50) saveMemoryAuto(req.user.id, full.slice(0, 400), "assistant", 1).catch(()=>{});
    audit(req.user.id,"chat_completed",{persona,memorySaved},req);

    res.write(JSON.stringify({ type:"done", reply:full, memorySaved, media:mediaGenerated }) + "\n");
    res.end();
  } catch(e) {
    console.error(e);
    if (!res.headersSent) return res.status(500).json({ ok:false, error:"Erreur serveur." });
    res.write(JSON.stringify({ type:"error", error:"Erreur serveur: " + e.message }) + "\n");
    res.end();
  }
});

// ══ GÉNÉRATION IMAGE ══════════════════════════════════════════
