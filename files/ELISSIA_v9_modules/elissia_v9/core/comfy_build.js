// ═══════════════════════════════════════════════════════════════
// ÉLISSIA — comfy_build.js : Catalogues TENUES/ACCESSOIRES, buildComfyPrompt, buildComfyPromptFinal
// ═══════════════════════════════════════════════════════════════
function buildComfyPrompt(ext, style, tenue, userPrefs) {
  const parts = [];
  const age    = parseInt(ext.age) || 25;
  const corp   = (ext.corpulence  || "").toLowerCase();
  const genre  = (ext.genre       || "femme").toLowerCase();
  // ✅ v13 : genre-aware — homme, femme, trans, non-binaire
  const isHomme     = genre.includes("homme") && !genre.includes("trans");
  // Fallback : si statut_chirurgical contient phalloplastie/vaginoplastie → trans même si genre="femme"
  const _stcBuild = (ext.statut_chirurgical||"").toLowerCase();
  const isFemTrans  = genre.includes("femme trans") || genre.includes("trans femme")
    || _stcBuild.includes("phalloplastie") || _stcBuild.includes("vaginoplastie");
  const isHomTrans  = genre.includes("homme trans") || genre.includes("trans masc");
  const isNB        = genre.includes("non-binaire") || genre.includes("non binaire") || genre.includes("fluide");
  // isFem = tout ce qui n'est pas homme cis
  const isFem       = !isHomme || isFemTrans;
  const genderWord  = isHomme ? "man" : isNB ? "androgynous person" : isFemTrans ? "transgender woman" : "woman";

  // ── STYLE CANDY AI / PHOTORÉALISTE ───────────────────────────
  parts.push("photorealistic photograph, RAW photo, professional photography, sharp focus, natural lighting, realistic skin, real human");

  // ── CORPS / CORPULENCE — genre-aware ─────────────────────────
  // Chaque clé génère la description correcte selon le genre
  const buildCorpDesc = (key) => {
    const w = genderWord;
    const map = {
      "bbw":         `morbidly obese extremely fat BBW ${age} year old ${w}, enormous belly, massive thighs, huge fat body, super plus size`,
      "généreuse":   `very fat BBW ${age} year old ${w}, extremely chubby plus-size, massive fat body, heavy fat rolls`,
      "musclée":     isFem ? `muscular fit bodybuilder ${age} year old ${w}, very defined muscles, ripped physique, strong arms and legs`
                           : `muscular athletic ${age} year old ${w}, very defined muscles, ripped fit body, strong chest and arms`,
      "musclé":      isHomme ? `muscular athletic ${age} year old man, very defined muscles, ripped fit body, strong chest and arms`
                             : `muscular fit ${age} year old ${w}, very defined muscles, toned physique`,
      "pulpeuse":    `voluptuous curvy ${age} year old ${w}, perfect hourglass figure, full natural curves`,
      "voluptueuse": `voluptuous curvy ${age} year old ${w}, perfect hourglass figure, full natural curves`,
      "ronde":       `plus size chubby ${age} year old ${w}, soft round curves, full figured body`,
      "athlétique":  isHomme ? `athletic ${age} year old man, lean fit physique, defined abs and chest`
                             : `athletic toned ${age} year old ${w}, fit lean physique, defined abs`,
      "athletique":  isHomme ? `athletic ${age} year old man, lean fit physique, defined abs and chest`
                             : `athletic toned ${age} year old ${w}, fit lean physique, defined abs`,
      "élancée":     isHomme ? `tall slender ${age} year old man, lean build, long legs`
                             : `tall slender elegant ${age} year old ${w}, long legs, graceful silhouette`,
      "elancee":     isHomme ? `tall slender ${age} year old man, lean build, long legs`
                             : `tall slender elegant ${age} year old ${w}, long legs, graceful silhouette`,
      "mince":       isHomme ? `slim slender ${age} year old man, lean body, thin waist`
                             : `slim slender thin ${age} year old ${w}, petite frame, thin waist`,
      "petite":      `petite small ${age} year old ${w}, short and slim`,
      "compact":     `compact ${age} year old ${w}, average height, balanced proportions`,
    };
    return map[key] || null;
  };

  let matched = false;
  for (const key of Object.keys({bbw:"",généreuse:"",musclée:"",musclé:"",pulpeuse:"",voluptueuse:"",ronde:"",athlétique:"",athletique:"",élancée:"",elancee:"",mince:"",petite:"",compact:""})) {
    if (corp.includes(key)) {
      const desc = buildCorpDesc(key);
      if (desc) { parts.push(desc); matched = true; break; }
    }
  }
  if (!matched) {
    if      (isHomme)    parts.push(`${age} year old man, average build`);
    else if (isNB)       parts.push(`${age} year old androgynous person, slim build`);
    else                 parts.push(`beautiful ${age} year old woman`);
  }

  // ✅ v18 — Signal morphologique TRANS (corrige l'oubli post-op : genre + statut_chirurgical
  //          n'entraient jamais dans le prompt pour une femme trans opérée → rendue comme femme cis)
  if (isFemTrans) {
    const stc = (ext.statut_chirurgical || "").toLowerCase();
    let transMorph = "transgender woman, feminine passing trans woman";
    if (stc.includes("vaginoplastie") || stc.includes("opéré complet") || stc.includes("néo-vagin") || (stc.includes("opéré") && stc.includes("bas")))
      transMorph += ", post-op MTF trans woman after gender confirming surgery, fully feminized body and face";
    else if (stc.includes("opéré haut") || stc.includes("torse"))
      transMorph += ", feminized chest, hormone therapy feminized body";
    else if (stc.includes("pré-op") || stc.includes("non opéré"))
      transMorph += ", pre-op trans woman, hormone therapy feminized body";
    parts.push(transMorph);
  }

  if (ext.taille) parts.push(`${ext.taille} tall`);

  // ── TONICITÉ ─────────────────────────────────────────────────
  const ton = (ext.tonicite || "").toLowerCase();
  if      (ton.includes("très musclée") || ton.includes("définie")) parts.push("extremely toned defined physique, visible muscle definition");
  else if (ton.includes("tonique"))  parts.push("toned fit body, firm skin");
  else if (ton.includes("douce") || ton.includes("moelleuse")) parts.push("soft plush skin, gentle natural curves");

  // ── CHEVEUX — genre-aware ────────────────────────────────────
  const ch = (ext.cheveux || "").toLowerCase();
  const lg = (ext.longueur_cheveux || "").toLowerCase();
  // Couleur
  if      (ch.includes("noire") || ch.includes("noir"))   parts.push(isHomme ? "black hair" : "black hair");
  else if (ch.includes("brun") || ch.includes("châtain")) parts.push("brunette hair");
  else if (ch.includes("roux") || ch.includes("rousse"))  parts.push("auburn red hair");
  else if (ch.includes("platine") || ch.includes("blanc blond")) parts.push("platinum blonde hair");
  else if (ch.includes("blond"))  parts.push("blonde hair");
  else if (ch.includes("noir"))   parts.push("black hair");
  else if (ch.includes("gris"))   parts.push("silver grey hair");
  else if (ch.includes("coloré") || ch.includes("rose") || ch.includes("bleu")) parts.push(`${ext.cheveux} colored hair`);
  if      (lg.includes("rasé") || lg.includes("très court")) parts.push("shaved head, very short hair");
  else if (lg.includes("court"))   parts.push("short hair");
  else if (lg.includes("mi"))      parts.push("medium length hair");
  else if (lg.includes("très long")) parts.push("very long hair down to waist");
  else if (lg.includes("long"))    parts.push("long flowing hair");
  const tex = (ext.texture_cheveux || "").toLowerCase();
  if      (tex.includes("bouclés")) parts.push("curly hair");
  else if (tex.includes("frisés") || tex.includes("afro")) parts.push("natural afro curly hair");
  else if (tex.includes("ondulés")) parts.push("wavy hair");
  else if (tex.includes("lisses"))  parts.push("straight sleek hair");

  // ── YEUX ─────────────────────────────────────────────────────
  const y = (ext.yeux || "").toLowerCase();
  if      (y.includes("bleu"))    parts.push("piercing blue eyes");
  else if (y.includes("vert"))    parts.push("bright green eyes");
  else if (y.includes("marron") || y.includes("brun")) parts.push("brown eyes");
  else if (y.includes("noir"))    parts.push("dark black eyes");
  else if (y.includes("noisette")) parts.push("hazel eyes");
  else if (y.includes("gris"))    parts.push("grey eyes");

  // ── PEAU ─────────────────────────────────────────────────────
  const p = (ext.couleur_peau || "").toLowerCase();
  if      (p.includes("très claire") || p.includes("albâtre")) parts.push("very pale porcelain skin");
  else if (p.includes("claire"))  parts.push("fair pale skin");
  else if (p.includes("mat"))     parts.push("olive tan skin");
  else if (p.includes("dorée") || p.includes("bronzée")) parts.push("golden tanned skin");
  else if (p.includes("caramel") || p.includes("miel"))  parts.push("caramel honey skin");
  else if (p.includes("brun"))    parts.push("dark brown skin");
  else if (p.includes("ébène") || p.includes("noire"))   parts.push("dark ebony skin");
  else if (p.includes("métisse")) parts.push("mixed race brown skin");
  else if (p.includes("asiatique") || p.includes("porcelaine")) parts.push("asian porcelain skin");

  // ── LÈVRES FACIALES ──────────────────────────────────────────
  const lev = (ext.taille_levres || "").toLowerCase();
  if      (lev.includes("xxl") || lev.includes("hyper"))    parts.push("extremely full pouty lips, huge lips");
  else if (lev.includes("très pulp"))                        parts.push("very full pouty plump lips");
  else if (lev.includes("pulp"))                             parts.push("full pouty lips");
  else if (lev.includes("fine") || lev.includes("discret")) parts.push("thin lips");

  // ── MAQUILLAGE ───────────────────────────────────────────────
  const maq = (ext.maquillage || "").toLowerCase();
  if      (maq.includes("smoky") || maq.includes("yeux dramatiques")) parts.push("dramatic smoky eye makeup");
  else if (maq.includes("rouge"))  parts.push("dark red lipstick makeup");
  else if (maq.includes("naturel") || maq.includes("sans")) parts.push("natural minimal makeup");
  else if (maq.length > 2)         parts.push("makeup");

  // ── CORPS FÉMININ ─────────────────────────────────────────────
  const statutChirImgStr = (ext.statut_chirurgical || "").toLowerCase();
  const hasPhalloplastie = statutChirImgStr.includes("phalloplastie");
  // (hasNeoVaginImg retiré v18 : code mort — le statut post-op est désormais géré plus haut via transMorph)
  if (isFem) {
    // Seins
    const s = (ext.taille_seins || "").toLowerCase();
    if      (s.includes("xxl") || s.includes("bonnet g") || s.includes("g et plus") || s.includes("seins xxl")) parts.push("huge saggy natural G cup breasts hanging heavily, very large pendulous breasts with natural droop, massive chest with big tits resting on belly, heavy full natural breasts");
    else if (s.includes("énorme") || s.includes("bonnet f") || s.includes("f+")) parts.push("enormous F cup breasts, huge massive breasts");
    else if (s.includes("très gros") || s.includes("bonnet e") || s.includes("bonnet d")) parts.push("large D-E cup breasts, big bust");
    else if (s.includes("généreux") || s.includes("bonnet c")) parts.push("C cup breasts, full natural breasts");
    else if (s.includes("moyen") || s.includes("bonnet b")) parts.push("medium B cup breasts, natural bust");
    else if (s.includes("petit") || s.includes("bonnet a")) parts.push("small A cup breasts, petite chest");
    else if (s.includes("plate") || s.includes("aa"))       parts.push("flat chest, minimal breasts");

    // Forme seins — pour G+ BBW forcer teardrop/pendulaire peu importe le choix
    const fs = (ext.forme_seins || "").toLowerCase();
    const isXXLBBW = (s.includes("xxl") || s.includes("g et") || s.includes("bonnet g")) && (corp.includes("bbw") || corp.includes("généreuse") || corp.includes("ronde"));
    if (isXXLBBW || fs.includes("goutte") || fs.includes("teardrop")) parts.push("natural teardrop shaped breasts with soft droop, heavy pendulous natural hang");
    else if (fs.includes("implant") || fs.includes("parfaitement ronds")) parts.push("perfectly round implanted breasts, enhanced spherical");
    else if (fs.includes("fermes") && fs.includes("hauts") && !isXXLBBW)  parts.push("firm perky high breasts");
    else if (fs.includes("naturels ronds"))                  parts.push("naturally round perky breasts");
    else if (fs.includes("écartés"))                         parts.push("wide-set breasts");

    // Tétons
    const tet = (ext.teton || "").toLowerCase();
    if      (tet.includes("percés") || tet.includes("piercings")) parts.push("nipple piercings");
    else if (tet.includes("très proéminents") || tet.includes("érectiles")) parts.push("very prominent large erect nipples");
    else if (tet.includes("gros"))     parts.push("large prominent nipples");
    else if (tet.includes("petits"))   parts.push("small delicate nipples");
    else if (tet.includes("plats"))    parts.push("flat nipples");

    // Fesses
    const f = (ext.forme_fesses || "").toLowerCase();
    if      (f.includes("énormes") || f.includes("booty") || f.includes("xxl")) parts.push("enormous huge ass, massive booty, gigantic buttocks");
    else if (f.includes("très grosse") || f.includes("très gross"))              parts.push("very big round ass, huge buttocks");
    else if (f.includes("généreux") || f.includes("généreuse") || f.includes("bombée") || f.includes("bubble")) parts.push("big round generous bubble butt");
    else if (f.includes("grosse") || f.includes("gros"))  parts.push("big full ass");
    else if (f.includes("petite") || f.includes("ferme")) parts.push("small firm perky butt");
    // Forme fesses
    const ffs = (ext.forme_fesses_shape || "").toLowerCase();
    if      (ffs.includes("cœur") || ffs.includes("heart")) parts.push("heart-shaped ass");
    else if (ffs.includes("molles") || ffs.includes("coussins")) parts.push("soft jiggly ass");
    else if (ffs.includes("fermes") || ffs.includes("toniques")) parts.push("firm toned ass");

    // Hanches
    const h = (ext.hanches || "").toLowerCase();
    if      (h.includes("très large"))  parts.push("very wide hips, enormous hip curves");
    else if (h.includes("large"))        parts.push("wide hips, generous feminine curves");
    else if (h.includes("étroit") || h.includes("fine") || h.includes("narrow")) parts.push("narrow hips");

    // Ventre
    const v = (ext.ventre || "").toLowerCase();
    if      (v.includes("musclé") || v.includes("abdos"))   parts.push("flat toned abs, defined stomach");
    else if (v.includes("plat"))                             parts.push("flat belly");
    else if (v.includes("légèrement"))                       parts.push("slightly soft belly");
    else if (v.includes("arrondi") || v.includes("dodu"))   parts.push("rounded plump tummy");
    else if (v.includes("rebondi") || v.includes("généreux")) parts.push("big round belly");

    // Jambes
    const j = (ext.jambes || "").toLowerCase();
    if      (j.includes("très charnues") || j.includes("grosses cuisses")) parts.push("very thick meaty thighs, heavy legs");
    else if (j.includes("charnue") || j.includes("pulpeuse"))  parts.push("thick full thighs, chubby legs");
    else if (j.includes("athlétique") || j.includes("musclée")) parts.push("athletic muscular toned legs");
    else if (j.includes("fine") && j.includes("longue"))    parts.push("long slim slender legs");
    else if (j.includes("longue"))                           parts.push("long legs");

    // Pilosité intime
    const pil = hasPhalloplastie ? "" : (ext.style_pilosite || ext.pilosite || "").toLowerCase();
    const coulPil = (ext.couleur_pilosite || "").toLowerCase();
    let pilDesc = "";
    if      (pil.includes("rasée") || pil.includes("épilée") || pil.includes("intégrale")) pilDesc = "completely shaved smooth bare pussy";
    else if (pil.includes("landing") || pil.includes("bande fine"))  pilDesc = "landing strip pubic hair";
    else if (pil.includes("triangle"))  pilDesc = "trimmed triangle pubic hair";
    else if (pil.includes("taillée fine")) pilDesc = "neatly trimmed close pubic hair";
    else if (pil.includes("taillée"))    pilDesc = "trimmed pubic hair";
    else if (pil.includes("fournie") || pil.includes("bush")) pilDesc = "full natural thick pubic bush";
    else if (pil.includes("naturelle"))  pilDesc = "natural pubic hair";
    if (pilDesc) {
      if      (coulPil.includes("blonde"))  pilDesc += ", blonde pubic hair";
      else if (coulPil.includes("brune") || coulPil.includes("brun")) pilDesc += ", dark brunette pubic hair";
      else if (coulPil.includes("noire") || coulPil.includes("noir")) pilDesc += ", black pubic hair";
      else if (coulPil.includes("rousse"))  pilDesc += ", red pubic hair";
      parts.push(pilDesc);
    }

    // Lèvres intimes — SKIP si phalloplastie (pas de vulve après chirurgie)
    if (!hasPhalloplastie) {
      const li = (ext.levres_intimes || ext.morpho_intime || "").toLowerCase();
      if      (li.includes("très proéminentes") || li.includes("généreuses")) parts.push("large prominent labia, big inner lips");
      else if (li.includes("proéminentes"))  parts.push("visible protruding inner labia");
      else if (li.includes("très discrètes") || li.includes("invisible")) parts.push("minimal flat labia, tight smooth");
      else if (li.includes("discrètes"))     parts.push("small discrete labia");
      // Clitoris
      const cl = (ext.clitoris || "").toLowerCase();
      if      (cl.includes("très proéminent")) parts.push("very prominent visible clitoris");
      else if (cl.includes("proéminent"))      parts.push("prominent clitoris");
    }
  }

  // ── CORPS MASCULIN ────────────────────────────────────────────
  const anatomieLibre = (ext.anatomie_libre || "") === "true";
  // Fallback : si statut_chirurgical contient phalloplastie/vaginoplastie → trans même si genre="femme"
  const _stcFinal = (ext.statut_chirurgical||"").toLowerCase();
  const isTransFemme  = genre.includes("femme trans") || genre.includes("trans femme")
    || _stcFinal.includes("phalloplastie") || _stcFinal.includes("vaginoplastie");
  const hasEquipement = (ext.taille_sexe_m || "").trim().length > 3;
  // ✅ Fix v12 : montrer l'anatomie masculine pour :
  // - Genre masculin/non-binaire (comme avant)
  // - Mode hybride actif
  // - Trans femme avec équipement défini (pre-op ou non-op)
  const showMasc = genre.includes("homme") || genre.includes("trans femme") || genre.includes("femme trans") || genre.includes("non-binaire") || genre.includes("fluide");
  const showMascAnatomy = showMasc && (!isFem || anatomieLibre || (isTransFemme && hasEquipement));

  if (showMascAnatomy) {
    // Torse (pour homme / non-binaire / trans masc)
    if (!isTransFemme || !isFem) {
      const pec = (ext.pectoraux || "").toLowerCase();
      if      (pec.includes("très musclés") || pec.includes("imposant")) parts.push("massive muscular pecs, huge chest muscles");
      else if (pec.includes("développés"))  parts.push("developed pectoral muscles");
      const abd = (ext.abdominaux || "").toLowerCase();
      if      (abd.includes("très définis") || abd.includes("tablette")) parts.push("extremely defined six pack abs, chiseled core");
      else if (abd.includes("six-pack") || abd.includes("six pack"))     parts.push("visible six pack abs");
    }
    // ── Anatomie intime masculine avec taille complète ──────────
    const ts = (ext.taille_sexe_m || "").toLowerCase();
    const ep = (ext.epaisseur_sexe_m || "").toLowerCase();
    const fo = (ext.forme_sexe_m || "").toLowerCase();
    const ci = (ext.circoncis || "").toLowerCase();
    const te = (ext.testicules || "").toLowerCase();
    const pm = (ext.pilosite_masc || "").toLowerCase();

    if (ts) {
      // ✅ Pour trans femme : préciser le type (phalloplastie post-op ou pre-op)
      const transPrefix = (isTransFemme && isFem)
        ? (hasPhalloplastie
            ? "a transgender woman who has both female breasts and a natural penis as part of her body, "
            : "pre-op trans woman, transgender woman still has original cock, ")
        : "";
      if      (ts.includes("xxl") || ts.includes("23")) parts.push(transPrefix + "her penis is fully erect and rigid, hard erection pointing upward toward her navel, turgid erect penis standing up from groin, same skin color as body, attached to her pubic area, fully hard not flaccid");
      else if (ts.includes("très grand") || ts.includes("19")) parts.push(transPrefix + "visible erect penis part of her body at groin level, natural erect phallus");
      else if (ts.includes("grand") || ts.includes("15"))  parts.push(transPrefix + "large penis, above average cock");
      else if (ts.includes("moyen"))                        parts.push(transPrefix + "average size cock");
      else if (ts.includes("petit"))                        parts.push(transPrefix + "small penis");
    }
    if      (ep.includes("très épaisse") || ep.includes("imposante")) parts.push("extremely thick girth, very fat cock");
    else if (ep.includes("épaisse") || ep.includes("grosse"))         parts.push("thick girth cock");
    if      (fo.includes("champignon") || fo.includes("gland large")) parts.push("large mushroom head glans");
    else if (fo.includes("courbé vers le haut")) parts.push("upward curved penis");
    if      (ci.includes("circoncis") && !ci.includes("non"))  parts.push("circumcised penis");
    else if (ci.includes("non circoncis") || ci.includes("prépuce")) parts.push("uncircumcised foreskin penis");
    if      (te.includes("très généreux") || te.includes("imposant")) parts.push("very large heavy balls, huge scrotum");
    else if (te.includes("généreux"))  parts.push("large full balls");
    if      (pm.includes("rasée") || pm.includes("complète")) parts.push("shaved pubic area");
    else if (pm.includes("fournie"))   parts.push("full thick pubic hair");
  } else if (isTransFemme && hasEquipement) {
    // Fallback minimal si le bloc principal n'a pas été exécuté
    const ts = (ext.taille_sexe_m || "").toLowerCase();
    if (ts.includes("xxl") || ts.includes("23")) parts.push("pre-op trans woman, enormous huge cock between legs, XXL penis");
    else if (ts) parts.push("pre-op transgender woman, penis visible between legs");
  }

  // ── TATOUAGES ─────────────────────────────────────────────────
  const tats = (ext.tatouages || "").toLowerCase();
  if (tats.length > 2) {
    if (tats.includes("fin") || tats.includes("délicat"))  parts.push("delicate fine line tattoos");
    else if (tats.includes("dragon")) parts.push("large dragon tattoo on back, heavily tattooed");
    else if (tats.includes("manchette") || tats.includes("bras")) parts.push("sleeve tattoo on arm");
    else if (tats.includes("entier") || tats.includes("dos") || tats.includes("full") || tats.includes("complet")) parts.push("full back tattoo, heavily tattooed");
    else if (tats.includes("fleur") || tats.includes("rose")) parts.push("floral tattoos");
    else parts.push("visible tattoos");
  }

  // ── PIERCINGS ─────────────────────────────────────────────────
  const pc = (ext.piercings || "").toLowerCase();
  const pp = [];
  if (pc.includes("sein") || pc.includes("téton")) pp.push("nipple piercings");
  if (pc.includes("nombril"))   pp.push("belly button piercing");
  if (pc.includes("nez") || pc.includes("septum")) pp.push(pc.includes("septum") ? "septum piercing" : "nose ring piercing");
  if (pc.includes("labret") || pc.includes("lèvre") || pc.includes("bouche")) pp.push("labret lip piercing");
  if (pc.includes("oreille") || pc.includes("lobe") || pc.includes("helix")) pp.push("ear piercings");
  if (pc.includes("arcade") || pc.includes("sourcil")) pp.push("eyebrow piercing");
  if (pc.includes("langue")) pp.push("tongue piercing");
  if (pc.includes("intime") || pc.includes("vch") || pc.includes("clito") || pc.includes("labia")) pp.push("intimate piercing");
  if (pc.includes("prince albert") || pc.includes("frenum") || pc.includes("pénis")) pp.push("cock piercing");
  if (pp.length) parts.push(pp.join(", "));

  // ── LUNETTES ──────────────────────────────────────────────────
  const lun = (ext.lunettes || "").toLowerCase();
  if (lun.length > 2) {
    if      (lun.includes("soleil") || lun.includes("aviateur")) parts.push("wearing stylish sunglasses");
    else if (lun.includes("carrées") || lun.includes("carré")) parts.push("wearing square black glasses frames");
    else if (lun.includes("rondes") || lun.includes("round")) parts.push("wearing round glasses");
    else if (lun.includes("chat") || lun.includes("cat")) parts.push("wearing cat-eye glasses");
    else if (lun.includes("noire") || lun.includes("noir")) parts.push("wearing black glasses frames");
    else parts.push("wearing glasses, " + lun);
  }

  // ── BIJOUX & ACCESSOIRES ──────────────────────────────────────
  const bij = [];
  const bijStr = (ext.bijoux || "").toLowerCase();
  const col = (ext.collier_bijou || ext.bijoux || "").toLowerCase();
  const boucl = (ext.boucles_oreilles || "").toLowerCase();
  const bgue = (ext.bague || "").toLowerCase();
  const brac = (ext.bracelet || "").toLowerCase();
  const montr = (ext.montre || "").toLowerCase();

  if (col.includes("collier") || col.includes("necklace")) {
    if (col.includes("cuir") || col.includes("clouté") || col.includes("spike")) bij.push("spiked leather choker necklace");
    else if (col.includes("or") || col.includes("gold")) bij.push("gold necklace");
    else if (col.includes("perle")) bij.push("pearl necklace");
    else if (col.includes("chaîne") || col.includes("chain")) bij.push("chain necklace");
    else bij.push("necklace");
  }
  if (boucl.includes("boucle") || boucl.includes("oreille") || boucl.includes("earring")) {
    if (boucl.includes("or")) bij.push("gold earrings");
    else if (boucl.includes("créole") || boucl.includes("hoop")) bij.push("hoop earrings");
    else bij.push("earrings");
  }
  if (bgue.includes("bague") || bgue.includes("ring")) {
    if (bgue.includes("or")) bij.push("gold ring");
    else if (bgue.includes("argent")) bij.push("silver ring");
    else bij.push("ring on finger");
  }
  if (brac.includes("bracelet") || bijStr.includes("bracelet")) {
    if (bijStr.includes("acier") || bijStr.includes("steel")) bij.push("steel bracelet");
    else if (brac.includes("or") || bijStr.includes("or")) bij.push("gold bracelet");
    else bij.push("bracelet");
  }
  if (montr.includes("montre") || montr.includes("watch")) bij.push("wearing a watch");
  // Parsing libre si champ bijoux contient des infos non captées
  if (bijStr.includes("collier cuir") || bijStr.includes("cuir clouté")) bij.push("spiked leather choker");
  if (bij.length > 0) parts.push(bij.filter((v,i,a) => a.indexOf(v)===i).join(", "));

  // ── TENUE ─────────────────────────────────────────────────────
  const sk = style || "portrait";
  // ✅ v18 — la tenue OU le style choisi passe par le catalogue/alias.
  //   Avant : `parts.push(tenue)` poussait l'id brut (ex "pin_up") → tenue ignorée ;
  //   et l'UI envoie l'id de tenue dans `style` (generateAIAvatar(s.id)),
  //   donc on résout AUSSI `sk` via le catalogue/alias.
  const tenueDesc = resolveTenue(tenue) || resolveTenue(sk);
  parts.push(tenueDesc || "elegant natural confident pose");

  // Accessoires appris
  const jouets = userPrefs?.accessoires || "";
  if (jouets) parts.push(jouets);

  // ── QUALITÉ FINALE (style Candy AI) ──────────────────────────
  if (sk.includes("domin") || sk.includes("maitresse") || sk.includes("bdsm"))
    parts.push("dramatic dark moody lighting, powerful dominant atmosphere");
  else if (sk.includes("nue") || sk.includes("boudoir") || sk.includes("explic"))
    parts.push("soft intimate boudoir lighting, sensual atmosphere");
  else if (sk.includes("selfie"))
    parts.push("natural authentic candid lighting, selfie angle");
  else
    parts.push("professional studio lighting, clean sharp image");

  return parts.filter(Boolean).join(", ");
}

// ✅ v14 — Post-process: pour Lumina/Z-Image-Turbo, la narration marche mieux que les tags
// On intercale une description de scène quand l'anatomie trans est présente
function buildComfyPromptFinal(ext, style, tenue, userPrefs) {
  const raw = buildComfyPrompt(ext, style, tenue, userPrefs);

  const genre = (ext.genre || "").toLowerCase();
  const statut = (ext.statut_chirurgical || "").toLowerCase();
  const tailleSexe = (ext.taille_sexe_m || "").toLowerCase();

  const isTransWithPenis = (genre.includes("trans") || (ext.anatomie_libre === "true")) &&
                           tailleSexe && tailleSexe.length > 3;

  if (!isTransWithPenis) return raw;

  // ✅ v18.1 — Respecter la tenue : la narration anatomique nue ne s'active QUE si la scène
  //   est explicitement nue (nude/naked/topless/bottomless). Un portrait ou une tenue habillée
  //   d'une femme trans reste habillé — fin du "tout sort nu". (raw porte déjà le signal trans.)
  if (!/\b(nude|naked|topless|bottomless)\b/i.test(raw)) return raw;

  // Taille du pénis en mots
  const penisSize = tailleSexe.includes("xxl") || tailleSexe.includes("23") ? "large thick" :
                    tailleSexe.includes("très grand") ? "large" :
                    tailleSexe.includes("grand") ? "above average" : "medium";

  // Type selon le statut
  const penisType = statut.includes("phalloplastie")
    ? "surgically constructed phallus (phalloplasty)"
    : "natural original penis";

  // ✅ v13 — Corpulence précise pour la narration trans
  const corpTrans = (ext.corpulence || "").toLowerCase();
  const bodyDesc = corpTrans.includes("bbw") || corpTrans.includes("généreuse") ? "obese plus-size curvy" :
                   corpTrans.includes("ronde") ? "plus-size chubby" :
                   corpTrans.includes("pulp") ? "voluptuous curvy" :
                   corpTrans.includes("musclée") || corpTrans.includes("musclé") ? "athletic muscular" :
                   corpTrans.includes("athlétique") ? "athletic toned" :
                   corpTrans.includes("élancée") || corpTrans.includes("elancee") ? "slender slim" :
                   corpTrans.includes("mince") ? "slim thin" : "average build";

  // ✅ v13 — Taille seins précise (pas de "large" pour bonnet A/B)
  const seinsSize = (ext.taille_seins || "").toLowerCase();
  const breastDesc = seinsSize.includes("xxl") || seinsSize.includes("bonnet g") || seinsSize.includes("g et") ? "very large natural hanging breasts" :
                     seinsSize.includes("bonnet f") || seinsSize.includes("énorme") ? "large F cup breasts" :
                     seinsSize.includes("bonnet e") || seinsSize.includes("bonnet d") || seinsSize.includes("très gros") ? "large D-E cup breasts" :
                     seinsSize.includes("bonnet c") || seinsSize.includes("généreux") ? "C cup breasts" :
                     seinsSize.includes("bonnet b") || seinsSize.includes("moyen") ? "medium B cup breasts" :
                     seinsSize.includes("bonnet a") || seinsSize.includes("petit") ? "small A cup breasts, petite chest" :
                     seinsSize.includes("plate") || seinsSize.includes("plat") ? "nearly flat chest, minimal breasts" :
                     "small natural breasts";

  // Prompt narratif complet — Lumina comprend les phrases mieux que les tags
  // ✅ v17 — Tokens Juggernaut simples pour trans avec pénis
  const narrative = `naked nude ${bodyDesc} transgender woman, ${breastDesc}, erect penis visible between thighs, thick hard cock, large penis at groin, she has both breasts and a penis, topless nude`;

  // On garde les éléments non-anatomiques du prompt original (cheveux, style, lumière)
  const keepParts = raw.split(", ").filter(p => {
    const pl = p.toLowerCase();
    return !pl.includes("obese") && !pl.includes("fat") && !pl.includes("bbw") &&
           !pl.includes("breast") && !pl.includes("tits") && !pl.includes("boob") &&
           !pl.includes("penis") && !pl.includes("cock") && !pl.includes("phallus") &&
           !pl.includes("phalloplasty") && !pl.includes("transgender woman body") &&
           !pl.includes("trans") && !pl.includes("intersex") && !pl.includes("woman with");
  }).join(", ");

  return `${narrative}, ${keepParts}`;
}

function getAvatarSeed(ext) {
  if (ext.avatar_seed && ext.avatar_seed !== "null" && ext.avatar_seed !== "undefined") {
    const n = parseInt(ext.avatar_seed);
    if (!isNaN(n) && n > 0) return n;
  }
  return Math.floor(Math.random() * 2**32);
}

function extraireAccessoires(message) {
  const m = (message||"").toLowerCase();
  const found = [];
  for (const [fr] of Object.entries(ACCESSOIRES_CATALOGUE)) {
    if (m.includes(fr)) found.push(fr);
  }
  return found;
}

function getStylesCatalogue() {
  return [
    {cat:"📸 Portraits", styles:[
      {id:"portrait",label:"Portrait visage",emoji:"🎭"},
      {id:"portrait_sourire",label:"Sourire naturel",emoji:"😊"},
      {id:"portrait_regard",label:"Regard intense",emoji:"👁️"},
      {id:"buste_nu",label:"Buste nu",emoji:"🌸"},
      {id:"buste_lingerie",label:"Buste lingerie",emoji:"🎀"}
    ]},
    {cat:"👤 Corps entier", styles:[
      {id:"entiere",label:"Debout",emoji:"🌟"},
      {id:"entiere_allongee",label:"Allongée",emoji:"🛏️"},
      {id:"entiere_dos",label:"De dos",emoji:"✨"},
      {id:"talons_nus",label:"Nue + talons",emoji:"👠"}
    ]},
    {cat:"🩱 Lingerie", styles:[
      {id:"lingerie_noir",label:"Lingerie noire",emoji:"🖤"},
      {id:"lingerie_rouge",label:"Lingerie rouge",emoji:"❤️"},
      {id:"lingerie_blanc",label:"Lingerie blanche",emoji:"🤍"},
      {id:"lingerie_latex",label:"Latex",emoji:"⚡"},
      {id:"string",label:"String seul",emoji:"🔥"},
      {id:"body",label:"Body",emoji:"💃"},
      {id:"bustier",label:"Bustier corset",emoji:"⏳"},
      {id:"bas_resille",label:"Bas résille",emoji:"🕸️"}
    ]},
    {cat:"⛓️ Dominatrice", styles:[
      {id:"dominatrice",label:"Latex dominatrice",emoji:"⛓️"},
      {id:"maitresse_cuir",label:"Maîtresse cuir",emoji:"🖤"},
      {id:"maitresse_latex",label:"Latex total",emoji:"✊"},
      {id:"maitresse_pvc",label:"PVC brillant",emoji:"💎"},
      {id:"goddess",label:"Déesse harnais",emoji:"👑"},
      {id:"bdsm_harness",label:"Harnais cuir",emoji:"🔗"},
      {id:"teacher_dom",label:"Professeure",emoji:"📚"},
      {id:"nurse_dom",label:"Infirmière",emoji:"🏥"},
      {id:"police_dom",label:"Policière",emoji:"👮"}
    ]},
    {cat:"🔞 Accessoires & Jouets", styles:[
      {id:"avec_vibro",label:"Vibromasseur",emoji:"💜"},
      {id:"avec_gode",label:"Gode",emoji:"🍆"},
      {id:"avec_plug",label:"Plug anal",emoji:"🔌"},
      {id:"avec_gode_ceinture",label:"Gode-ceinture",emoji:"⚡"},
      {id:"avec_baton_massage",label:"Magic Wand",emoji:"🪄"},
      {id:"avec_plug_queue",label:"Queue décorative",emoji:"🦊"},
      {id:"avec_menottes",label:"Menottes",emoji:"🔒"},
      {id:"avec_cravache",label:"Cravache",emoji:"🏇"},
      {id:"avec_fouet",label:"Fouet",emoji:"🩸"},
      {id:"avec_cordes",label:"Shibari",emoji:"🎋"},
      {id:"avec_bandeau",label:"Bandeau yeux",emoji:"😶"},
      {id:"avec_bille",label:"Bâillon",emoji:"🔴"},
      {id:"avec_pinces",label:"Pinces tétons",emoji:"✂️"}
    ]},
    {cat:"🎭 Roleplay", styles:[
      {id:"secretaire",label:"Secrétaire",emoji:"💼"},
      {id:"femme_de_menage",label:"Femme de ménage",emoji:"🧹"},
      {id:"cheerleader",label:"Cheerleader",emoji:"📣"},
      {id:"strip_teaseuse",label:"Strip-teaseuse",emoji:"💫"},
      {id:"femme_fatale",label:"Femme fatale",emoji:"🕷️"},
      {id:"gothique",label:"Gothique",emoji:"🖤"},
      {id:"vampire",label:"Vampire",emoji:"🧛"},
      {id:"soumise",label:"Soumise liée",emoji:"🙏"},
      {id:"collier_laisse",label:"Collier laisse",emoji:"🐾"}
    ]},
    {cat:"🌸 Nue artistique", styles:[
      {id:"nue",label:"Nu artistique",emoji:"🌸"},
      {id:"nue_allongee",label:"Allongée",emoji:"🛏️"},
      {id:"nue_douche",label:"Douche",emoji:"🚿"},
      {id:"nue_bain",label:"Bain",emoji:"🛁"},
      {id:"nue_miroir",label:"Miroir",emoji:"🪞"},
      {id:"nue_nature",label:"Nature",emoji:"🌿"}
    ]},
    {cat:"📱 Selfies & Casual", styles:[
      {id:"selfie",label:"Selfie chambre",emoji:"📱"},
      {id:"selfie_lit",label:"Au lit",emoji:"🛌"},
      {id:"selfie_salle_de_bain",label:"Salle de bain",emoji:"🚿"},
      {id:"casual_maison",label:"Casual maison",emoji:"🏠"},
      {id:"sport",label:"Sport",emoji:"💪"},
      {id:"plage",label:"Plage bikini",emoji:"🏖️"},
      {id:"piscine",label:"Piscine",emoji:"🏊"}
    ]}
  ];
}

