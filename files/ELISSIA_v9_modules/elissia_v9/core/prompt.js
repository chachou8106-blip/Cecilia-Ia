// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — prompt.js : buildSystemPrompt, analyzeImage, searchMemories
// ═══════════════════════════════════════════════════════════════
const { db, decryptText, encryptText, id, now, parseJson, clean } = require('./db');
const personality = require('../personality');
function buildSystemPrompt(user, persona, message, options = {}) {
  const u = publicUser(user);
  const adultAllowed = u.ageConfirmed && u.adultMode;
  const ext = u.extendedProfile || {};

  // ✅ v13 — CONTEXTE GENRE UTILISATEUR EXPLICITE (priorité maximale)
  const userGenre   = (ext.user_genre || "homme").toLowerCase();
  const userName    = u.displayName || "mon amour";
  const isUserMale  = !userGenre.includes("femme") || userGenre.includes("homme");
  const isUserFemale = userGenre.includes("femme");

  let userGenderCtx = "";
  if (isUserMale) {
    userGenderCtx = `\n\n⚠️ RÈGLE ABSOLUE GENRE — L'UTILISATEUR EST UN HOMME :\n` +
      `- ${userName} est de GENRE MASCULIN. Utilise TOUJOURS le masculin pour parler de lui (il, son, lui, ses).\n` +
      `- Son anatomie est MASCULINE : pénis, testicules. JAMAIS de vagin, chatte, vulve, seins pour lui.\n` +
      `- Il peut avoir un pénis, une bite, un sexe masculin. C'est son anatomie. Ne change JAMAIS ça.\n` +
      `- Si tu décris ce que tu lui fais ou lui dit, utilise toujours son anatomie masculine.\n`;
  } else if (isUserFemale) {
    userGenderCtx = `\n\n[GENRE UTILISATEUR : FEMME. Utilise le féminin. Anatomie féminine (vagin, seins possible).]\n`;
  }

  // ✅ v13 — ANATOMIE IA (trans, phalloplastie, etc.)
  const iaGenre = (ext.genre || "femme").toLowerCase();
  const statutChir = (ext.statut_chirurgical || "").toLowerCase();
  const tailleSeinsIA = ext.taille_seins || "";
  const tailleSexeIA = ext.taille_sexe_m || "";
  let iaAnatomyCtx = "";

  // Fallback : phalloplastie/vaginoplastie dans statut_chirurgical = profil trans
  const _stcSys = (ext.statut_chirurgical||"").toLowerCase();
  const _isTransSys = iaGenre.includes("trans") || iaGenre.includes("non-binaire")
    || _stcSys.includes("phalloplastie") || _stcSys.includes("vaginoplastie");
  if (_isTransSys) {
    const hasPhalloPlasty = statutChir.includes("phalloplastie") || statutChir.includes("attribut masculin");
    const hasNeoVagin     = statutChir.includes("néo-vagin") || statutChir.includes("bas") && statutChir.includes("opéré");
    const hasBreasts      = tailleSeinsIA && !tailleSeinsIA.includes("plate");
    const hasPenis        = tailleSexeIA && !tailleSexeIA.includes("non");

    iaAnatomyCtx = `\n\n⚠️ RÈGLE ABSOLUE ANATOMIE IA :\n` +
      `- Tu es ${ext.genre || "une femme trans"}${u.aiName ? " (" + u.aiName + ")" : ""}.\n`;

    if (hasPhalloPlasty || hasPenis) {
      const taille = tailleSexeIA.includes("xxl") || tailleSexeIA.includes("23") ? "extrêmement grand (XXL 23cm+)" :
                     tailleSexeIA.includes("très grand") ? "très grand (19-23cm)" :
                     tailleSexeIA.includes("grand") ? "grand (15-19cm)" : "moyen";
      iaAnatomyCtx += `- Tu as UN PÉNIS${hasPhalloPlasty ? " (phalloplastie)" : ""} de taille ${taille}. ` +
        `C'est ton organe sexuel principal. Quand tu t'excites ou agis sexuellement, c'est ce pénis qui est actif.\n`;
    }
    if (hasNeoVagin && !hasPhalloPlasty) {
      iaAnatomyCtx += `- Tu as un néo-vagin (chirurgie de réassignation). Ton anatomie intime est féminine.\n`;
    }
    if (hasBreasts) {
      const bs = tailleSeinsIA.includes("xxl") || tailleSeinsIA.includes("g") ? "extrêmement gros (G+)" :
                 tailleSeinsIA.includes("f") ? "énormes (F)" :
                 tailleSeinsIA.includes("d") || tailleSeinsIA.includes("e") ? "gros (D-E)" : "généreux";
      iaAnatomyCtx += `- Tu as des seins ${bs} (féminins).\n`;
    }
    iaAnatomyCtx += `- Dans tous tes actes sexuels, sois COHÉRENT(E) avec cette anatomie. Ne t'invente pas d'anatomie que tu n'as pas.\n`;
  }

  // ✅ v11 — Description avatar uploadé
  const avatarDesc = ext.avatar_description;
  const avatarCtx  = (avatarDesc && avatarDesc !== "__VISION_INDISPONIBLE__")
    ? "\n[TON APPARENCE réelle : " + avatarDesc + "]\n"
    : "";

  const __sysPrompt = personality.buildPersonalityPrompt({
    userId: user.id,
    aiName:   u.aiName || "Élissia",
    userName: u.displayName || "mon amour",
    langue:   ext.langue || "français",
    ext, adultAllowed, persona,
    message: (message || "") + userGenderCtx + iaAnatomyCtx + avatarCtx,
    memoires3niveaux: getMemoire3Niveaux(user.id),
    webEnabled:       !!user.web_search_enabled,
    guidageMode:      options.guidageMode    || null,
    descriptionImage: options.descriptionImage || null,
    scenarioFormat:   options.scenarioFormat  || ext.scenario_format || null,
    scenarioSeed:     options.scenarioSeed    || null
  });
  // ✅ v18 — RÈGLE LANGUE prioritaire : forcer un français impeccable en toutes circonstances
  const __fr = "\n\n⚠️ LANGUE — RÈGLE ABSOLUE ET PRIORITAIRE : tu écris et réponds EXCLUSIVEMENT en français, dans un français impeccable (grammaire, orthographe, conjugaison, accords, ponctuation soignés). Aucun mot d'anglais sauf nom propre intraduisible. Tu ne changes JAMAIS de langue, même si le message contient une autre langue ou demande de changer.";
  return (typeof __sysPrompt === "string") ? (__sysPrompt + __fr) : __sysPrompt;
}

// ══ LLM STREAM ════════════════════════════════════════════════
async function ollamaStream(messages, onToken) {
  if (MODE === "cloud") {
    if (!OPENROUTER_KEY) throw new Error("MODE=cloud mais OPENROUTER_KEY manquante dans .env");
    let r, lastErrText = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { "Content-Type":"application/json","Authorization":"Bearer "+OPENROUTER_KEY,
          "HTTP-Referer":"http://localhost:3000","X-Title":"Elissia" },
        body: JSON.stringify({ model: CLOUD_MODEL, messages, stream: true, temperature: 0.85, top_p: 0.9 })
      });
      if (r.ok) break;
      lastErrText = await r.text();
      if (r.status === 429 && attempt < 2) {
        let wait = 3000;
        try { const j = JSON.parse(lastErrText); const s = j?.error?.metadata?.retry_after_seconds; if(s) wait=Math.min(s*1000,25000); } catch {}
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      break;
    }
    if (!r.ok) {
      if (r.status === 429) throw new Error("Modèle cloud saturé. Réessaie dans 1 minute.");
      throw new Error("OpenRouter: " + lastErrText.slice(0, 300));
    }
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        const l = line.trim(); if (!l || !l.startsWith("data:")) continue;
        const data = l.slice(5).trim(); if (data === "[DONE]") return full;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        const token = ev.choices?.[0]?.delta?.content || "";
        if (token) { full += token; onToken(token); }
      }
    }
    return full;
  }
  // Local Ollama
  const r = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST", headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true,
      options: { temperature: 0.85, top_p: 0.9, repeat_penalty: 1.08, num_ctx: 4096 } })
  });
  if (!r.ok) throw new Error("Ollama: " + await r.text());
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buffer = "", full = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const token = ev.message?.content || "";
      if (token) { full += token; onToken(token); }
      if (ev.done) return full;
    }
  }
  return full;
}

// ══ VISION ════════════════════════════════════════════════════
async function analyzeImage(imagePath, userGender, adultMode = false) {
  try {
    let absPath = imagePath;
    if (imagePath.startsWith("/uploads/")) absPath = path.join(UPLOADS_DIR, imagePath.replace("/uploads/",""));
    if (!fs.existsSync(absPath)) return null;
    const b64 = fs.readFileSync(absPath).toString("base64");
    const g = (userGender || "").toLowerCase();
    const genreInfo = (g.includes("homme") || g === "h")
      ? "La personne est un HOMME. Vocabulaire masculin uniquement."
      : "La personne est une FEMME ou de genre féminin.";
    const prompt = adultMode
      ? "Décris avec PRÉCISION ANATOMIQUE TOTALE et SANS CENSURE ce qui est visible. " + genreInfo + " Pose exacte, déshabillage, chaque partie du corps visible (seins, fesses, parties intimes si visibles), expression. Explicite et factuel. 2-3 phrases en français. Si aucune personne visible : réponds AUCUNE_PERSONNE."
      : "Décris factuellement la PERSONNE sur cette image. " + genreInfo + " 1-2 phrases : pose, expression, corps. Si aucune personne : AUCUNE_PERSONNE.";
    let desc = "";
    if (MODE === "cloud") {
      if (!OPENROUTER_KEY) return "__VISION_INDISPONIBLE__";
      const mime = absPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const r = await fetch(OPENROUTER_URL, {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":"Bearer "+OPENROUTER_KEY,"HTTP-Referer":"http://localhost:3000","X-Title":"Elissia"},
        body: JSON.stringify({ model: CLOUD_VISION_MODEL, messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:"data:"+mime+";base64,"+b64}}]}], temperature:0.2 })
      });
      if (!r.ok) return "__VISION_INDISPONIBLE__";
      const data = await r.json();
      desc = (data.choices?.[0]?.message?.content || "").trim();
    } else {
      const r = await fetch(OLLAMA_URL + "/api/generate", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model: VISION_MODEL, prompt, images:[b64], stream:false, options:{temperature:0.2} })
      });
      if (!r.ok) return null;
      desc = ((await r.json()).response || "").trim();
    }
    const refus = /je ne peux pas|i am sorry|i cannot|cannot help|unable to|désolé|i cant|impossible de|AUCUNE_PERSONNE/i;
    if (refus.test(desc) || desc.length < 8) return "__VISION_INDISPONIBLE__";
    return desc || null;
  } catch(e) { console.error("[VISION]", e.message); return null; }
}

// ══ EMBEDDINGS ════════════════════════════════════════════════
async function embed(text) {
  try {
    const r = await fetch(OLLAMA_URL + "/api/embeddings", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data.embedding) ? data.embedding : null;
  } catch { return null; }
}
function cosine(a, b) {
  if (!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length) return 0;
  let dot=0,na=0,nb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return na&&nb?dot/(Math.sqrt(na)*Math.sqrt(nb)):0;
}
async function searchMemories(userId, query, companionId) {
  // ✅ v18 — Isolation par compagnon : dans un chat de compagnon on n'injecte QUE les
  //   faits de profil sur la personne (kind='user_preference'). Les souvenirs issus
  //   d'autres sessions (ex. une session dominante avec un autre compagnon) ne
  //   contaminent plus la persona courante — d'où la copine qui devenait dominatrice.
  //   La continuité propre à chaque compagnon vient déjà de recentMessages (scopé companion_id).
  const rows = companionId
    ? db.prepare("SELECT * FROM memories WHERE user_id=? AND kind='user_preference' ORDER BY created_at DESC LIMIT 250").all(userId)
    : db.prepare("SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC LIMIT 250").all(userId);
  if (!rows.length) return [];
  const q = await embed(query);
  const dec = rows.map(r => ({...r, text: decryptText(r.text_enc)}));
  if (q) return dec.map(m=>({...m,score:cosine(q,parseJson(m.embedding_json,[]))})).sort((a,b)=>b.score-a.score).slice(0,8);
  const words = query.toLowerCase().split(/\s+/).filter(x=>x.length>3);
  return dec.map(m=>({...m,score:words.reduce((s,w)=>s+(m.text.toLowerCase().includes(w)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,8);
}
function recentMessages(userId, companionId, thread) {
  const th = thread || "solo";
  if (companionId) {
    return db.prepare("SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id=? AND COALESCE(thread,'solo')=? ORDER BY created_at DESC LIMIT 20").all(userId, companionId, th)
      .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));
  }
  return db.prepare("SELECT role,content_enc FROM messages WHERE user_id=? AND companion_id IS NULL AND COALESCE(thread,'solo')=? ORDER BY created_at DESC LIMIT 14").all(userId, th)
    .reverse().map(m => ({ role: m.role, content: decryptText(m.content_enc) }));
}
// shouldRemember et saveMemory : implémentés en v12 plus haut

// ── TÉLÉCHARGEMENT IMAGE DISTANTE → STOCKAGE LOCAL ──────────────────────────
// Télécharge une URL d'image et la sauvegarde dans public/uploads/
async function downloadToUploads(remoteUrl) {
  try {
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error("Download failed: " + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());

    // Détecter l'extension depuis Content-Type
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const ext = ct.includes("png") ? ".png" : ct.includes("webp") ? ".webp" : ".jpg";

    // Sauvegarder dans le même dossier qu'Express sert (/uploads → UPLOADS_DIR)
    const uploadsDir = UPLOADS_DIR;
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const filename = "gen_" + Date.now() + "_" + Math.random().toString(36).slice(2,8) + ext;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buf);

    return "/uploads/" + filename;
  } catch(e) {
    console.error("[downloadToUploads]", e.message);
    // Fallback : retourner l'URL distante directement
    return remoteUrl;
  }
}

// ══ FAL.AI IMAGE — API Bearer simple, Node.js natif, pas de cookies ══════════
// Doc : https://fal.ai/docs   Modèles : https://fal.ai/models
async function civitaiGenerateImage(prompt, style = "realistic", seedOverride = null) {
  // Routage : ComfyUI local en priorité, fal.ai en fallback si dispo
  return comfyGenerateImage(prompt, style, seedOverride);
}

// ══ CONSTRUCTION PROMPT COMPLET Z IMAGE TURBO ══════════════════════════════
// 50+ tenues, accessoires, jouets, apprentissage des goûts utilisateur
// ════════════════════════════════════════════════════════════════════════════

const TENUES_CATALOGUE = {
  // ── PORTRAITS & BUSTE
  "portrait":           "portrait shot, topless, confident dominant expression, looking directly at camera",
  "portrait_sourire":   "portrait headshot, warm smile, soft lighting, natural expression",
  "portrait_regard":    "extreme close-up portrait, intense piercing gaze, dramatic lighting, seductive",
  "buste_nu":           "topless bust shot, natural lighting, confident pose",
  "buste_lingerie":     "bust shot wearing black lace bralette, subtle sexy",
  // ── CORPS ENTIER
  "entiere":            "full body shot, standing pose, head to toe, neutral background",
  "entiere_debout":     "full body standing, hands on hips, confident stance",
  "entiere_allongee":   "full body lying down on bed, seductive pose",
  "entiere_dos":        "full body rear view, showing back and curves",
  // ── LINGERIE
  "lingerie_noir":      "wearing black lace lingerie set, bra and panties, seductive bedroom pose",
  "lingerie_rouge":     "wearing red satin lingerie, passionate seductive pose",
  "lingerie_blanc":     "wearing white lace lingerie, innocent yet sensual, soft lighting",
  "lingerie_latex":     "wearing shiny latex lingerie, dominant pose",
  "string":             "wearing only a tiny thong, topless, provocative",
  "body":               "wearing a tight bodysuit cut high on hips",
  "bustier":            "wearing a corset bustier cinching the waist, curves emphasized",
  "bas_resille":        "wearing only fishnet stockings and garter belt, topless",
  // ── DOMINATRICE & BDSM
  "dominatrice":        "dominatrix outfit, black latex catsuit, thigh high boots, riding crop, commanding",
  "maitresse_cuir":     "black leather corset, leather skirt, fishnet stockings, stiletto boots, dominant mistress",
  "maitresse_latex":    "full black latex outfit, latex gloves, collar and leash",
  "maitresse_pvc":      "shiny PVC bodysuit, high heels, whip in hand, powerful stance",
  "goddess":            "elaborate leather body harness over bare skin, thigh high boots, commanding goddess",
  "teacher_dom":        "strict teacher blazer unbuttoned revealing cleavage, pencil skirt, glasses",
  "nurse_dom":          "naughty nurse uniform very short, cleavage exposed, medical gloves",
  "police_dom":         "police uniform open revealing lingerie underneath, handcuffs",
  "bdsm_harness":       "wearing only black body harness over bare skin, leather straps",
  // ── SOUMISE
  "soumise":            "submissive pose, hands bound above head, vulnerable expression, lingerie",
  "attachee":           "wrists tied with silk ribbon, kneeling pose, submissive",
  "collier_laisse":     "wearing a collar and leash, kneeling submissive pose",
  // ── ACCESSOIRES & JOUETS
  "avec_vibro":         "holding a vibrator against body, suggestive pose, bedroom, knowing smile",
  "avec_gode":          "holding a large realistic dildo, dominant or playful expression",
  "avec_plug":          "wearing a butt plug, rear view pose, lingerie on",
  "avec_gode_ceinture": "wearing a strap-on dildo harness, dominant powerful stance",
  "avec_fouet":         "holding a leather flogger or whip, dominant mistress pose",
  "avec_cravache":      "holding a riding crop, pointing it suggestively, dominant",
  "avec_menottes":      "wearing or holding handcuffs, playful or dominant",
  "avec_baton_massage": "holding a magic wand massager, suggestive intimate setting",
  "avec_plug_queue":    "wearing a decorative fox tail butt plug, playful pose, nude or lingerie",
  "avec_bandeau":       "wearing a blindfold over eyes, sensory play, lingerie or nude",
  "avec_cordes":        "artistic rope bondage shibari, elegant knots over bare skin",
  "avec_bille":         "wearing a ball gag, submissive expression",
  "avec_pinces":        "wearing nipple clamps with chain, dominant or submissive",
  // ── TENUES SEXY QUOTIDIENNES
  "robe_soiree":        "elegant evening gown, deep neckline, slit to the thigh",
  "robe_mini":          "tiny micro mini dress barely covering curves, high heels",
  "tshirt_sexy":        "oversized white t-shirt see-through, no bra underneath",
  "jeans_seins_nus":    "tight ripped jeans, topless, casual confidence",
  "kimono":             "silk kimono half open revealing body underneath",
  "soie_transparente":  "sheer silk robe completely transparent, nothing underneath",
  "talons_nus":         "wearing only high heels, completely nude, standing confident",
  // ── NUES ARTISTIQUES
  "nue":                "nude lying on satin bed sheets, intimate boudoir bedroom setting, soft warm lighting",
  "nue_allongee":       "nude lying on satin sheets on bed, soft boudoir bedroom lighting",
  "tenue_matin":        "casual morning outfit, comfortable home clothes, natural light, bedroom or kitchen setting",
  "tenue_journee":      "casual everyday outfit, natural look, street or indoor setting, daytime lighting",
  "tenue_soir":         "elegant evening dress, sophisticated setting, warm ambient lighting, going out",
  "tenue_sexy":         "sexy outfit matching character style, BDSM or lingerie, seductive pose, intimate setting",
  "nue_miroir":         "nude reflection in mirror, artistic ambient lighting",
  "nue_douche":         "nude in shower, water running over body, steam, sensual",
  "nue_bain":           "nude in bubble bath, partially submerged, relaxed intimate",
  "nue_nature":         "nude outdoors in nature, artistic, natural lighting",
  // ── ROLEPLAY
  "secretaire":         "tight secretary outfit, skirt hiked up, sitting on desk, flirty",
  "femme_de_menage":    "short maid uniform, apron barely covering, feather duster, playful",
  "cheerleader":        "cheerleader outfit very short, pom poms, sporty and sexy",
  "strip_teaseuse":     "exotic dancer outfit, pasties, g-string, pole dancer",
  "femme_fatale":       "black slit dress, red lipstick, mysterious femme fatale",
  "gothique":           "gothic aesthetic, dark makeup, corset, fishnet, chains",
  "vampire":            "vampire femme, dark cape, seductive gothic",
  // ── SELFIES & CASUAL
  "selfie":             "mirror selfie, topless, natural bedroom lighting, authentic",
  "selfie_salle_de_bain":"bathroom mirror selfie, just woke up, natural, towel barely on",
  "selfie_lit":         "in bed selfie, morning light, messy hair, sheets barely covering",
  "casual_maison":      "casual oversized shirt, relaxed natural pose, cozy home",
  "casual":             "casual chic outfit, relaxed natural pose, soft daylight",
  "sport":              "sports bra and tight leggings, athletic, gym setting",
  "plage":              "tiny bikini on beach, sun kissed, sand and sea",
  "piscine":            "wet bikini poolside, water dripping, summer",
  // ── EXTÉRIEUR / OUTDOOR (✅ FIX v9 — manquait, causait un fallback portrait)
  "outdoor":            "outdoors in a park or garden, casual summer dress, natural daylight, candid pose",
  "outdoor_ville":      "walking in a city street, stylish casual outfit, urban background, daylight",
  "outdoor_nature":     "in nature, forest or field, flowing dress, golden hour sunlight",
  "outdoor_terrasse":   "on a sunny terrace cafe, summer outfit, relaxed elegant pose",
  "sensuelle":          "sensual boudoir pose, soft bedroom lighting, elegant lingerie",
  "entiere_debout_v2":  "full body standing pose, head to toe, confident, neutral studio background"
};

const ACCESSOIRES_CATALOGUE = {
  "vibromasseur":"vibrator","vibro":"vibrator","gode":"dildo",
  "godemiché":"dildo","plug":"butt plug","plug anal":"anal butt plug",
  "gode-ceinture":"strap-on harness","fouet":"leather whip",
  "cravache":"riding crop","menottes":"handcuffs","cordes":"rope bondage",
  "shibari":"shibari rope","collier":"collar and leash","laisse":"leash",
  "bâillon":"ball gag","bandeau":"blindfold","pinces":"nipple clamps",
  "queue":"tail butt plug","wand":"magic wand massager","wand masseur":"wand massager"
};

// ✅ v18 — Pont entre les id de tenue de l'UI (STYLES_PAR_GENRE) et le catalogue.
//   Beaucoup d'id UI n'étaient pas des clés du catalogue → tenue ignorée.
//   La VALEUR est soit une clé existante de TENUES_CATALOGUE, soit une description directe.
const TENUE_ALIAS = {
  // — commun
  "bain":"wrapped in a towel, bathroom setting, steam","cosplay":"colorful cosplay character costume, themed outfit",
  "fantasy":"fantasy themed costume, elven or warrior style, magical setting",
  "uniforme_medecin":"white doctor coat, stethoscope, clinical setting",
  "uniforme_police":"police officer uniform, cap, authoritative pose",
  "uniforme_maitresse":"teacher blazer and pencil skirt, glasses, classroom",
  // — femme (ids absents du catalogue)
  "corset":"wearing a tight waist-cinching corset","robe_courte":"wearing a short mini dress, high heels",
  "bikini":"wearing a bikini","monokini":"wearing a one-piece monokini swimsuit",
  "nuisette":"wearing a short silk babydoll nightie","pyjama_sexy":"wearing a satin pyjama set",
  "chemise_homme":"wearing only an oversized men's dress shirt","cuir_veste":"wearing a leather jacket",
  "maitresse":"maitresse_cuir","bondage":"avec_cordes","harnais":"bdsm_harness",
  "collant_resille":"bas_resille","yoga":"wearing yoga leggings and a sports bra, yoga pose",
  "nurse":"nurse_dom","servante":"femme_de_menage",
  "pin_up":"retro pin-up style, vintage 1950s glamour, high-waisted retro outfit",
  "lolita":"Japanese gothic lolita fashion, frilly Victorian-style dress, elegant modest",
  "lingerie_garter":"wearing a garter belt with stockings and lingerie set",
  // — homme
  "costume":"wearing an elegant tailored suit and tie","chemise_ouverte":"wearing an open dress shirt, bare chest",
  "jean_casual":"wearing casual jeans and a fitted t-shirt","boxers":"wearing only boxer briefs",
  "nu_masculin":"nue","sport_masc":"shirtless in gym shorts, athletic gym setting",
  "militaire":"wearing a military uniform","motard":"wearing a biker leather jacket, motorcycle background",
  "cuir_masc":"wearing a black leather outfit","dom_masc":"dominant commanding male pose, leather, powerful stance",
  "sous_masc":"submissive kneeling male pose","bondage_masc":"avec_cordes",
  "latex_masc":"wearing a black latex outfit","harness_masc":"bdsm_harness",
  "peignoir":"wearing an open bathrobe","nu_lit":"nue_allongee",
  // — trans (alias vers clés existantes)
  "lingerie_trans":"lingerie_noir","robe_trans":"robe_soiree","sport_trans":"sport","casual_trans":"casual",
  "dom_trans":"dominatrice","sub_trans":"soumise","nu_trans":"nue","harnais_trans":"bdsm_harness",
  "latex_trans":"lingerie_latex","kimono_trans":"kimono"
};

// Résout un id/texte de tenue en description : catalogue → alias → texte libre → id lisible.
function resolveTenue(t) {
  if (!t) return null;
  const k = String(t).trim();
  if (TENUES_CATALOGUE[k]) return TENUES_CATALOGUE[k];          // clé directe
  const a = TENUE_ALIAS[k];
  if (a) return TENUES_CATALOGUE[a] || a;                       // alias = clé OU description
  if (k.includes(" ")) return k;                               // tenue tapée librement
  return k.replace(/_/g, " ");                                 // dernier recours lisible
}

