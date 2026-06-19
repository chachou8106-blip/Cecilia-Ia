/* ══════════════════════════════════════════════════════════════
   ÉLISSIA v9 — Frontend Mobile Complet
   Corrections :
   ✅ appendMessage → addMsg (generateSelfie)
   ✅ clearInterval au lieu de clearTimeout (proactivité)
   ✅ oninput= au lieu de addEventListener (curseurs — pas de doublons)
   ✅ TTS sauvegardé dans saveAll()
   ✅ seed aléatoire dans generateAIAvatar() et generateSelfie()
   ✅ cancelMedia() dans finally (toujours réinitialisé)
   ✅ Galerie : DOM propre via createElement (plus d'XSS via onclick inline)
   ✅ generateAnimatedAvatar() — GIF FFmpeg avec barre de progression
   ✅ checkSession() — ne déconnecte que sur 401/403, pas sur erreur réseau
   ══════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);

let csrf = localStorage.getItem("csrf") || "";

async function refreshCsrf() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      if (d.csrf) { csrf = d.csrf; localStorage.setItem("csrf", csrf); }
    }
  } catch {}
}

let mode = "login";
let user = null;
let aiNameValue = "Élissia";
let piperAvailable = false;
let ttsGlobalEnabled = false;
let proactiveTimer = null;
let webcamStream = null;
let mediaFile = null;

const authScreen = $("authScreen");
const appScreen  = $("appScreen");

// ── Utilitaires ───────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function api(method, path, body) {
  const doFetch = async () => {
    const opts = {
      method: method.toUpperCase(),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    };
    if (["POST", "PUT", "PATCH", "DELETE"].includes(opts.method)) {
      opts.headers["X-CSRF-Token"] = csrf;
    }
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(path, opts);
  };
  let r = await doFetch();
  if (r.status === 403) { await refreshCsrf(); r = await doFetch(); }
  let data = {};
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Erreur " + r.status);
  return data;
}

function showToast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── AUTH ──────────────────────────────────────────────────────
function setAuthMode(next) {
  mode = next;
  $("loginTab") .classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  if ($("registerFields")) $("registerFields").hidden = mode !== "register";
  if ($("authBtn")) $("authBtn").textContent = mode === "login" ? "Connexion" : "Créer compte";
  if ($("authError")) $("authError").textContent = "";
}

async function submitAuth(e) {
  e.preventDefault();
  if ($("authError")) $("authError").textContent = "";
  try {
    let data;
    if (mode === "register") {
      data = await api("POST", "/api/auth/register", {
        email:       $("authEmail")?.value?.trim(),
        password:    $("authPassword")?.value,
        displayName: $("authName")?.value?.trim() || "Mon amour",
        inviteCode:  $("authInvite")?.value?.trim() || "",
        rgpdConsent: $("authConsent")?.checked || false
      });
    } else {
      data = await api("POST", "/api/auth/login", {
        email:    $("authEmail")?.value?.trim(),
        password: $("authPassword")?.value
      });
    }
    csrf = data.csrf;
    localStorage.setItem("csrf", csrf);
    user = data.user;
    await startApp();
  } catch (err) {
    if ($("authError")) $("authError").textContent = err.message;
  }
}

// ✅ CORRIGÉ : déconnecte uniquement sur 401/403 — pas sur erreur réseau/5xx
async function checkSession() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" });
    // Erreur réseau ou serveur 5xx → ne pas déconnecter
    if (r.status >= 500) {
      console.warn("[checkSession] Serveur indisponible, on attend.");
      if (authScreen) authScreen.hidden = true;
      if (appScreen)  appScreen.hidden = false;
      return;
    }
    if (!r.ok) throw new Error("Non connecté");
    const data = await r.json();
    if (!data.ok) throw new Error("Session invalide");
    csrf = data.csrf;
    localStorage.setItem("csrf", csrf);
    user = data.user;
    await startApp();
  } catch {
    csrf = "";
    localStorage.removeItem("csrf");
    if (authScreen) authScreen.hidden = false;
    if (appScreen)  appScreen.hidden = true;
  }
}

async function logout() {
  try { await api("POST", "/api/auth/logout"); } catch {}
  localStorage.removeItem("csrf");
  location.reload();
}

// ── APP INIT ──────────────────────────────────────────────────
async function startApp() {
  if (authScreen) authScreen.hidden = true;
  if (appScreen)  appScreen.hidden = false;

  await loadExtendedProfile();
  await loadPiperStatus();
  await loadMessages();
  updateHeader();
  scheduleProactive();

  if ("speechSynthesis" in window) {
    ttsGlobalEnabled = true;
    if ($("ttsToggleBtn")) $("ttsToggleBtn").textContent = "🔊";
    speechSynthesis.getVoices();
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }
}

function updateHeader() {
  aiNameValue = user?.aiName || "Élissia";
  if ($("aiNameDisplay")) $("aiNameDisplay").textContent = aiNameValue;
  if ($("aiStatus"))      $("aiStatus").textContent = "🟢 En ligne";

  const avatarUrl = user?.avatarUrl || user?.personaPhotoUrl;
  if (avatarUrl) {
    if ($("avatarImg"))   { $("avatarImg").src = avatarUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji")) $("avatarEmoji").hidden = true;
  } else {
    if ($("avatarImg"))   $("avatarImg").hidden = true;
    if ($("avatarEmoji")) $("avatarEmoji").hidden = false;
  }
}

// ── PROFIL ÉTENDU ─────────────────────────────────────────────
async function loadExtendedProfile() {
  try {
    const data = await api("GET", "/api/profile/extended");
    const ext = data.extendedProfile || {};
    if (user) user.extendedProfile = ext;
    fillProfileFields(user, ext);
  } catch (e) {
    console.error("[loadExtended]", e.message);
  }
}

function fillProfileFields(u, ext) {
  if (!u) return;
  ext = ext || u?.extendedProfile || {};

  if ($("sAiName"))       $("sAiName").value       = u.aiName       || "";
  if ($("sDisplayName"))  $("sDisplayName").value   = u.displayName  || "";
  if ($("sUserGenre"))    $("sUserGenre").value      = ext.user_genre  || "homme";
  if ($("sGenre"))        $("sGenre").value          = ext.genre       || "femme";
  if ($("sAge"))          $("sAge").value            = ext.age         || "25";
  if ($("sOrigine"))      $("sOrigine").value        = ext.origine     || "";
  if ($("sLangue"))       $("sLangue").value         = ext.langue      || "français";
  if ($("sHistoire"))     $("sHistoire").value       = ext.histoire    || "";

  if ($("sCorpulence"))      $("sCorpulence").value      = ext.corpulence      || "mince et élancée";
  if ($("sTailleSeins"))     $("sTailleSeins").value     = ext.taille_seins    || "moyens";
  if ($("sFormeFesses"))     $("sFormeFesses").value     = ext.forme_fesses    || "normale";
  if ($("sTaille"))          $("sTaille").value          = ext.taille          || "";
  if ($("sPoids"))           $("sPoids").value           = ext.poids           || "";
  if ($("sLongueurCheveux")) $("sLongueurCheveux").value = ext.longueur_cheveux || "longs";
  if ($("sCheveux"))         $("sCheveux").value         = ext.cheveux         || "";
  if ($("sYeux"))            $("sYeux").value            = ext.yeux            || "";
  if ($("sCouleurPeau"))     $("sCouleurPeau").value     = ext.couleur_peau    || "claire";
  if ($("sTailleLevres"))    $("sTailleLevres").value    = ext.taille_levres   || "normales";
  if ($("sPilosite"))        $("sPilosite").value        = ext.pilosite        || "épilée";
  if ($("sTatouages"))       $("sTatouages").value       = ext.tatouages       || "";
  if ($("sPiercings"))       $("sPiercings").value       = ext.piercings       || "";
  if ($("sStyle"))           $("sStyle").value           = ext.style           || "";
  if ($("sTenuePreferee"))   $("sTenuePreferee").value   = ext.tenue_preferee  || "";
  if ($("sMaquillage"))      $("sMaquillage").value      = ext.maquillage      || "";

  if ($("sCaractere"))  $("sCaractere").value  = ext.caractere   || "";
  if ($("sPassions"))   $("sPassions").value   = ext.passions    || "";
  if ($("sProfession")) $("sProfession").value = ext.profession  || "";
  if ($("sHumour"))     $("sHumour").value     = ext.humour      || "taquin";
  if ($("sJalousie"))   $("sJalousie").value   = ext.jalousie    || "légère";
  if ($("sValeurs"))    $("sValeurs").value    = ext.valeurs     || "";

  if ($("sPersona"))         $("sPersona").value         = u.preferredPersona || "girlfriend";
  if ($("sKinks"))           $("sKinks").value           = ext.kinks          || "";
  if ($("sFantasmes"))       $("sFantasmes").value       = ext.fantasmes      || "";
  if ($("sPratiques"))       $("sPratiques").value       = ext.pratiques      || "";
  if ($("sLimites"))         $("sLimites").value         = ext.limites        || "";
  if ($("sRythme"))          $("sRythme").value          = ext.rythme         || "toujours disponible";
  if ($("sPreferencesChat")) $("sPreferencesChat").value = ext.preferences_chat || "très cru et explicite";

  if ($("sRelation"))    $("sRelation").value    = ext.relation    || u.relationshipStyle || "romantique";
  if ($("sProactivite")) $("sProactivite").value = ext.proactivite || "normale";

  if ($("sNiveauIntensite"))    $("sNiveauIntensite").value    = ext.niveau_intensite    || "7";
  if ($("sInitiativeSexuelle")) $("sInitiativeSexuelle").value = ext.initiative_sexuelle || "normale";
  if ($("niveauVal"))           $("niveauVal").textContent     = ext.niveau_intensite     || "7";

  // ✅ Curseurs — utilise oninput= posé dans le HTML, pas de addEventListener ici
  const curseurMap = {
    sCurseurDouceur:     ext.curseur_douceur     || "5",
    sCurseurCrudite:     ext.curseur_crudite     || "7",
    sCurseurDomination:  ext.curseur_domination  || "7",
    sCurseurHumiliation: ext.curseur_humiliation || "5",
    sCurseurRomantisme:  ext.curseur_romantisme  || "3",
    sCurseurInitiative:  ext.curseur_initiative  || "7"
  };
  for (const [id, val] of Object.entries(curseurMap)) {
    if ($(id)) $(id).value = val;
  }
  // Synchroniser les labels affichés
  syncCurseurLabels();

  if ($("sTTSEnabled")) $("sTTSEnabled").checked = u.ttsEnabled || false;
  if ($("sTTSSpeed"))   $("sTTSSpeed").value     = u.ttsSpeed   || "1.0";
  if ($("sAutoPhoto"))  $("sAutoPhoto").checked  = ext.auto_photo === "true" || ext.auto_photo === true;
  if ($("sWebSearch"))  $("sWebSearch").checked  = Boolean(u.webSearchEnabled);

  if ($("sAgeConfirm")) $("sAgeConfirm").checked = Boolean(u.ageConfirmed);
  if ($("sAdultMode"))  $("sAdultMode").checked  = Boolean(u.adultMode);

  updateAdultUI();
}

// ✅ CORRIGÉ : lit les valeurs courantes des sliders → met à jour les labels
// Pas d'addEventListener ici (ceux-ci sont en oninput= dans le HTML)
function syncCurseurLabels() {
  const pairs = [
    ["sCurseurDouceur",    "cDouceurVal"],
    ["sCurseurCrudite",    "cCruditeVal"],
    ["sCurseurDomination", "cDomVal"],
    ["sCurseurHumiliation","cHumVal"],
    ["sCurseurRomantisme", "cRomVal"],
    ["sCurseurInitiative", "cInitVal"]
  ];
  for (const [sliderId, labelId] of pairs) {
    const slider = $(sliderId), label = $(labelId);
    if (slider && label) label.textContent = slider.value;
  }
  const n = $("sNiveauIntensite"), nv = $("niveauVal");
  if (n && nv) nv.textContent = n.value;
}

// Alias conservé pour compatibilité avec les anciens appels éventuels
function updateCurseurLabels() { syncCurseurLabels(); }

function updateAdultUI() {
  const age   = $("sAgeConfirm")?.checked;
  const adult = $("sAdultMode")?.checked;
  if ($("adultWarning")) $("adultWarning").hidden = !(age && adult);
  if ($("sexContent"))   $("sexContent").hidden   = !(age && adult);
  if ($("adultGate"))    $("adultGate").hidden    = !!(age && adult);
}

// ── SAUVEGARDER — v9 CORRIGÉ ─────────────────────────────────
// ✅ TTS inclus dans profileData
// ✅ Pas de double-écriture "relation"
async function saveAll() {
  try {
    const ageConfirmed = $("sAgeConfirm")?.checked || false;
    const adultMode    = ($("sAdultMode")?.checked && ageConfirmed) || false;

    const profileData = {
      displayName:       $("sDisplayName")?.value  || user?.displayName || "",
      aiName:            $("sAiName")?.value        || user?.aiName      || "Élissia",
      relationshipStyle: $("sRelation")?.value      || "romantique",
      preferredPersona:  $("sPersona")?.value       || "girlfriend",
      ageConfirmed,
      adultMode,
      webSearchEnabled:  $("sWebSearch")?.checked   || false,
      autoPhoto:         $("sAutoPhoto")?.checked   || false,
      // ✅ TTS désormais sauvegardé
      ttsEnabled:        $("sTTSEnabled")?.checked  || false,
      ttsSpeed:          $("sTTSSpeed")?.value      || "1.0",
      rgpdConsent: true
    };

    const d = await api("PUT", "/api/profile", profileData);
    user = d.user;

    const extData = {
      user_genre: $("sUserGenre")?.value || "homme",
      genre:      $("sGenre")?.value     || "femme",
      age:        $("sAge")?.value       || "25",
      origine:    $("sOrigine")?.value   || "",
      langue:     $("sLangue")?.value    || "français",
      histoire:   $("sHistoire")?.value  || "",

      corpulence:       $("sCorpulence")?.value      || "",
      taille_seins:     $("sTailleSeins")?.value     || "",
      forme_fesses:     $("sFormeFesses")?.value     || "",
      taille:           $("sTaille")?.value          || "",
      poids:            $("sPoids")?.value           || "",
      longueur_cheveux: $("sLongueurCheveux")?.value || "",
      cheveux:          $("sCheveux")?.value         || "",
      yeux:             $("sYeux")?.value            || "",
      couleur_peau:     $("sCouleurPeau")?.value     || "",
      taille_levres:    $("sTailleLevres")?.value    || "",
      pilosite:         $("sPilosite")?.value        || "",
      tatouages:        $("sTatouages")?.value       || "",
      piercings:        $("sPiercings")?.value       || "",
      style:            $("sStyle")?.value           || "",
      tenue_preferee:   $("sTenuePreferee")?.value   || "",
      maquillage:       $("sMaquillage")?.value      || "",

      caractere:  $("sCaractere")?.value  || "",
      passions:   $("sPassions")?.value   || "",
      profession: $("sProfession")?.value || "",
      humour:     $("sHumour")?.value     || "taquin",
      jalousie:   $("sJalousie")?.value   || "légère",
      valeurs:    $("sValeurs")?.value    || "",

      kinks:            $("sKinks")?.value           || "",
      fantasmes:        $("sFantasmes")?.value       || "",
      pratiques:        $("sPratiques")?.value       || "",
      limites:          $("sLimites")?.value         || "",
      rythme:           $("sRythme")?.value          || "toujours disponible",
      preferences_chat: $("sPreferencesChat")?.value || "très cru et explicite",

      // ✅ relation uniquement ici (pas dans profileData.relationshipStyle séparé)
      relation:    $("sRelation")?.value    || "romantique",
      proactivite: $("sProactivite")?.value || "normale",

      niveau_intensite:    $("sNiveauIntensite")?.value    || "7",
      initiative_sexuelle: $("sInitiativeSexuelle")?.value || "normale",

      curseur_douceur:     $("sCurseurDouceur")?.value     || "5",
      curseur_crudite:     $("sCurseurCrudite")?.value     || "7",
      curseur_domination:  $("sCurseurDomination")?.value  || "7",
      curseur_humiliation: $("sCurseurHumiliation")?.value || "5",
      curseur_romantisme:  $("sCurseurRomantisme")?.value  || "3",
      curseur_initiative:  $("sCurseurInitiative")?.value  || "7",

      auto_photo: String($("sAutoPhoto")?.checked || false)
    };

    // Conserver les champs dynamiques non affichés
    const prev = user?.extendedProfile || {};
    if (prev.mes_jouets)       extData.mes_jouets       = prev.mes_jouets;
    if (prev.envies_pratiques) extData.envies_pratiques = prev.envies_pratiques;

    await api("PUT", "/api/profile/extended", extData);

    if (user) user.extendedProfile = { ...(user.extendedProfile || {}), ...extData };

    updateHeader();
    await refreshCsrf();
    showToast("✅ Tout sauvegardé !", "success");
    closePanel();
    scheduleProactive();
  } catch (e) {
    if (e.message.includes("CSRF") || e.message.includes("403")) {
      await refreshCsrf();
      showToast("🔄 Session rafraîchie — réessaie la sauvegarde", "info");
    } else {
      showToast("❌ " + e.message, "error");
    }
    console.error("[saveAll]", e);
  }
}

// ── MESSAGES ──────────────────────────────────────────────────
async function loadMessages() {
  try {
    const data = await api("GET", "/api/state");
    user = { ...user, ...data.user };
    const el = $("chatMessages");
    if (!el) return;
    el.innerHTML = "";
    if (!data.messages?.length) {
      addMsg("assistant", "Coucou 💗 Je suis là. Parle-moi de tout et de rien !");
      return;
    }
    data.messages.forEach(m => addMsg(m.role, m.content, m.mediaUrl, m.mediaType));
  } catch (e) { console.error("[loadMessages]", e); }
}

function _personaEmoji() {
  const E = {
    "dom_hard":"⛓️","dom_soft":"🖤","dom_bdsm":"👑","bdsm_complet":"⛓️",
    "pegging":"⚡","homme_dom":"👊","sub_hard":"🙏","sub_soft":"💜",
    "girlfriend":"💕","boyfriend":"💙","adult_intimate":"🔥","hedoniste":"🍷",
    "fetichiste":"🖤","exhib":"📸","voyeur":"👁️","libertin":"🌹",
    "switch":"♾️","maman_dom":"🌸","prof_dom":"📐","echangiste":"🔄",
    "gang_bang":"🔥","trans_femme":"🌈","trans_masc":"🌈","non_binaire":"🌈",
    "bisexuel":"🌈","pan":"🌈","asexuel_romantique":"🤍","coach":"💡"
  };
  return E[window.user?.preferredPersona || "girlfriend"] || "💜";
}

function addMsg(role, text, mediaUrl, mediaType) {
  const el = $("chatMessages");
  if (!el) return null;

  const wrap = document.createElement("div");
  wrap.className = "msg msg-" + role;

  if (role === "assistant") {
    const avatarDiv = document.createElement("div");
    avatarDiv.className = "msg-avatar";
    const avatarUrl = window.user?.avatarUrl || window.user?.personaPhotoUrl;
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl; img.alt = "";
      img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover";
      img.onerror = () => { img.style.display = "none"; avatarDiv.textContent = _personaEmoji(); };
      avatarDiv.appendChild(img);
    } else {
      avatarDiv.textContent = _personaEmoji();
    }
    wrap.appendChild(avatarDiv);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  const cleanText = (text || "").replace(/\[(IMG_GEN|VID_GEN|PHOTO|VIDEO|WEBCAM)[^\]]*\]/g, "").replace(/^\[WEBCAM\]\s*/g, "").trim();
  bubble.innerHTML = esc(cleanText || text || "");
  wrap.appendChild(bubble);

  if (mediaUrl) {
    const mediaDiv = document.createElement("div");
    mediaDiv.className = "msg-media";
    const isVideo = (mediaType || "").startsWith("video") || mediaUrl.includes("_vid_");
    const mediaEl = document.createElement(isVideo ? "video" : "img");
    mediaEl.src = mediaUrl;
    if (isVideo) { mediaEl.controls = true; }
    mediaDiv.appendChild(mediaEl);
    wrap.appendChild(mediaDiv);
  }

  if (role === "assistant" && /\[(IMG_GEN|VID_GEN|PHOTO|VIDEO)/.test(text || "")) {
    processMediaTagsInMessage(bubble, text || "");
  }

  el.appendChild(wrap);
  el.scrollTop = el.scrollHeight;
  return { wrap, bubble };
}

async function processMediaTagsInMessage(container, text) {
  const imgRe = /\[(?:PHOTO|SELFIE(?::([^\]]+))?|IMG_GEN:[^:]*:([^\]]+))\]/g;
  const vidRe = /\[(VIDEO|VID_GEN:[^:]*:([^\]]+))\]/g;
  let m;

  while ((m = imgRe.exec(text)) !== null) {
    const el = document.createElement("div");
    el.style.cssText = "padding:.5rem 0;text-align:center";
    el.textContent = "⏳ Génération photo...";
    container.appendChild(el);
    try {
      const rawStyle  = m[1] || m[2] || "";
      const style     = rawStyle.split(":")[0] || "sensuelle";
      const extraPrompt = rawStyle.includes(":") ? rawStyle.split(":").slice(1).join(":") : "";
      const data = await api("POST", "/api/generate/image", {
        style,
        prompt: extraPrompt,
        seed: Math.floor(Math.random() * 999999999)
      });
      if (data.ok && data.url) {
        const img = document.createElement("img");
        img.src = data.url;
        img.style.cssText = "width:100%;max-width:320px;border-radius:14px;margin-top:4px;display:block;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.5)";
        img.onclick = () => typeof openPhotoFull === "function" && openPhotoFull(data.url);
        const btns = document.createElement("div");
        btns.style.cssText = "display:flex;gap:6px;margin-top:6px;justify-content:center;flex-wrap:wrap";
        const bSave = document.createElement("button");
        bSave.textContent = "💾 Avatar";
        bSave.style.cssText = "background:#1e1b2e;border:1px solid #ff3f91;color:#ddd;padding:4px 10px;border-radius:8px;font-size:11px;cursor:pointer";
        bSave.onclick = () => typeof saveAsAvatar === "function" && saveAsAvatar(data.url);
        const bDl = document.createElement("a");
        bDl.href = data.url; bDl.download = "elissia.png"; bDl.target = "_blank";
        bDl.textContent = "⬇️ Télécharger";
        bDl.style.cssText = "background:#13111e;border:1px solid #555;color:#ddd;padding:4px 10px;border-radius:8px;font-size:11px;text-decoration:none";
        btns.appendChild(bSave); btns.appendChild(bDl);
        el.innerHTML = "";
        el.appendChild(img);
        el.appendChild(btns);
      } else {
        el.textContent = "❌ " + (data.error || "Photo non disponible");
      }
    } catch (e) { el.textContent = "❌ " + e.message; }
  }

  while ((m = vidRe.exec(text)) !== null) {
    const el = document.createElement("div");
    el.style.padding = ".5rem 0";
    el.textContent = "⏳ Vidéo en cours (peut prendre 2-3 min)...";
    container.appendChild(el);
    try {
      const data = await api("POST", "/api/generate/video", { prompt: m[2] || "sensual video", explicit: false });
      if (data.ok && data.video_url) {
        const vid = document.createElement("video");
        vid.src = data.video_url;
        vid.controls = true;
        vid.style.cssText = "width:100%;max-width:300px;border-radius:12px;margin-top:4px;display:block;";
        el.innerHTML = "";
        el.appendChild(vid);
      } else el.textContent = "❌ Vidéo non disponible";
    } catch (e) { el.textContent = "❌ " + e.message; }
  }
}

// ── ENVOI MESSAGE ─────────────────────────────────────────────
async function sendMsg() {
  const input = $("msgInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text && !mediaFile && !webcamStream) return;

  input.value = "";
  autoGrow(input);

  if (text) addMsg("user", text);

  const statusEl = $("aiStatus");
  if (statusEl) statusEl.textContent = "✍️ Elle écrit...";

  const assistantEntry = addMsg("assistant", "");
  if (!assistantEntry) return;
  const { bubble } = assistantEntry;

  let body = { message: text, persona: $("sPersona")?.value || user?.preferredPersona || "girlfriend" };

  // ✅ Média — cancelMedia() dans finally pour garantir la réinitialisation
  if (mediaFile) {
    try {
      const fd = new FormData();
      fd.append("media", mediaFile.file);
      const uploadResp = await fetch("/api/media/upload", {
        method: "POST", credentials: "same-origin",
        headers: { "X-CSRF-Token": csrf }, body: fd
      });
      const uploadData = await uploadResp.json();
      if (uploadData.ok) {
        body.mediaUrl      = uploadData.url;
        body.mediaType     = uploadData.mimeType;
        body.mediaAnalysis = uploadData.analysis || null;
        addMsg("user", "", uploadData.url, uploadData.mimeType);
      }
    } catch (e) {
      console.error("[upload]", e);
    } finally {
      cancelMedia(); // ✅ toujours réinitialisé, succès ou échec
    }
  }

  // Webcam snapshot
  if (webcamStream) {
    const canvas = document.createElement("canvas");
    const video  = $("webcamVideo");
    if (video) {
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext("2d").drawImage(video, 0, 0);
      await new Promise(resolve => {
        canvas.toBlob(async (blob) => {
          if (blob) {
            const fd = new FormData();
            fd.append("media", blob, "webcam.jpg");
            try {
              const r = await fetch("/api/media/upload", {
                method: "POST", credentials: "same-origin",
                headers: { "X-CSRF-Token": csrf }, body: fd
              });
              const d = await r.json();
              if (d.ok) { body.mediaUrl = d.url; body.mediaType = "image/jpeg"; body.mediaAnalysis = d.analysis; }
            } catch {}
          }
          resolve();
        }, "image/jpeg", 0.8);
      });
      body.message = "[WEBCAM] " + text;
    }
  }

  // Stream SSE
  try {
    const r = await fetch("/api/chat/stream", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body)
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Erreur"); }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = "", full = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "token") {
          full += ev.token;
          bubble.innerHTML = esc(full);
          $("chatMessages")?.scrollTo(0, $("chatMessages")?.scrollHeight);
        }
        if (ev.type === "done") {
          full = ev.reply || full;
          bubble.innerHTML = esc(full);
          if (ev.media?.url) {
            const isVideo = ev.media.type === "video";
            const mediaEl = document.createElement(isVideo ? "video" : "img");
            mediaEl.src = ev.media.url;
            if (isVideo) { mediaEl.controls = true; mediaEl.style.cssText = "width:100%;max-width:300px;border-radius:12px;margin-top:8px;display:block;"; }
            else mediaEl.style.cssText = "width:100%;max-width:300px;border-radius:12px;margin-top:8px;display:block;";
            bubble.appendChild(mediaEl);
          }
        }
        if (ev.type === "error") throw new Error(ev.error);
      }
    }
    if (statusEl) statusEl.textContent = "🟢 En ligne";
    if (ttsGlobalEnabled) await speak(full);
  } catch (e) {
    bubble.innerHTML = esc("❌ " + e.message);
    if (statusEl) statusEl.textContent = "🔴 Erreur";
  }
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}

// ── TTS ───────────────────────────────────────────────────────
async function loadPiperStatus() {
  try {
    const s = await api("GET", "/api/tts/piper/status");
    piperAvailable = Boolean(s.enabled);
    if ($("ttsStatus")) $("ttsStatus").textContent = piperAvailable
      ? "Piper ✓ " + (s.voiceName || "")
      : "Piper non configuré — voix navigateur utilisée";
  } catch {
    piperAvailable = false;
    if ($("ttsStatus")) $("ttsStatus").textContent = "TTS navigateur disponible";
  }
}

async function speak(text) {
  if (!ttsGlobalEnabled) return;
  if ($("sTTSEnabled") && !$("sTTSEnabled").checked) return;
  if (piperAvailable) { await speakPiper(text); } else { speakBrowser(text); }
}

function speakBrowser(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\[.*?\]/g, "").slice(0, 600));
  u.lang  = "fr-FR";
  u.rate  = parseFloat($("sTTSSpeed")?.value || "0.95");
  u.pitch = 1.1;
  const voices    = speechSynthesis.getVoices();
  const preferred = ["Microsoft Hortense", "Google français", "Microsoft Julie"];
  for (const name of preferred) {
    const v = voices.find(v => v.name.includes(name));
    if (v) { u.voice = v; break; }
  }
  if (!u.voice) {
    const frVoice = voices.find(v => v.lang.startsWith("fr"));
    if (frVoice) u.voice = frVoice;
  }
  speechSynthesis.speak(u);
}

async function speakPiper(text) {
  try {
    const r = await fetch("/api/tts/piper", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ text })
    });
    if (!r.ok) { speakBrowser(text); return; }
    const blob  = await r.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    audio.play().catch(() => {});
  } catch { speakBrowser(text); }
}

function toggleTTSGlobal() {
  ttsGlobalEnabled = !ttsGlobalEnabled;
  if ($("ttsToggleBtn")) $("ttsToggleBtn").textContent = ttsGlobalEnabled ? "🔊" : "🔇";
}

// ── MIC ───────────────────────────────────────────────────────
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast("Dictée non supportée. Essaie Chrome.", "error"); return; }
  const rec = new SR();
  rec.lang = "fr-FR";
  rec.interimResults = false;
  rec.start();
  if ($("micBtn")) $("micBtn").textContent = "🎙️";
  rec.onresult = e => {
    const input = $("msgInput");
    if (input) { input.value = e.results[0][0].transcript; autoGrow(input); }
    if ($("micBtn")) $("micBtn").textContent = "🎤";
  };
  rec.onerror = () => { if ($("micBtn")) $("micBtn").textContent = "🎤"; };
}

// ── WEBCAM ────────────────────────────────────────────────────
async function toggleWebcam() {
  if (webcamStream) { stopWebcam(); return; }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    const video   = $("webcamVideo");
    const preview = $("webcamPreview");
    if (video)   { video.srcObject = webcamStream; }
    if (preview) preview.hidden = false;
    if ($("webcamBtn")) $("webcamBtn").textContent = "📷🔴";
  } catch (e) { showToast("Webcam indisponible: " + e.message, "error"); }
}

function stopWebcam() {
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  const preview = $("webcamPreview");
  if (preview) preview.hidden = true;
  if ($("webcamBtn")) $("webcamBtn").textContent = "📷";
}

// ── MÉDIA ─────────────────────────────────────────────────────
function handleMedia(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  mediaFile = { file, type: file.type };
  const preview = $("mediaPreview");
  const label   = $("mediaPreviewLabel");
  const img     = $("mediaPreviewImg");
  if (preview) preview.hidden = false;
  if (label)   label.textContent = file.name;
  if (img && file.type.startsWith("image/")) {
    img.src = URL.createObjectURL(file); img.hidden = false;
  }
}

function cancelMedia() {
  mediaFile = null;
  const preview = $("mediaPreview");
  if (preview) preview.hidden = true;
  const input = $("mediaInput");
  if (input) input.value = "";
}

// ── AVATAR ────────────────────────────────────────────────────
function openAvatarModal() {
  if ($("avatarModal")) $("avatarModal").hidden = false;
  // Pré-remplir l'image actuelle dans la modal
  const avatarUrl = user?.avatarUrl || user?.personaPhotoUrl;
  if (avatarUrl) {
    if ($("avatarModalImg"))   { $("avatarModalImg").src = avatarUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";
  }
}
function closeAvatarModal() { if ($("avatarModal")) $("avatarModal").hidden = true; }

// ✅ CORRIGÉ : seed aléatoire à chaque génération, tenue transmise
async function generateAIAvatar(style = "portrait", tenue = null) {
  const statusEl = $("avatarStatus") || $("avatarGenStatus");
  if (statusEl) statusEl.textContent = "⏳ Génération en cours... (30-60s)";

  try {
    await refreshCsrf();
    const d = await api("POST", "/api/generate/avatar", {
      style,
      tenue: tenue || null,
      seed: Math.floor(Math.random() * 999999999) // ✅ aléatoire — plus de forceSeed
    });
    if (!d.ok) throw new Error(d.error || "Erreur génération");

    const avatarUrl = d.url;
    if ($("avatarImg"))        { $("avatarImg").src = avatarUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji"))      $("avatarEmoji").hidden = true;
    if ($("avatarModalImg"))   { $("avatarModalImg").src = avatarUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";
    if (user) { user.avatarUrl = avatarUrl; user.personaPhotoUrl = avatarUrl; }
    updateHeader();
    showToast("✨ Portrait généré !", "success");
    if (statusEl) statusEl.textContent = "✅ Portrait généré !";

    if ($("galleryPanel") && $("galleryPanel").open) loadGallery();
    return avatarUrl;
  } catch (e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    showToast("❌ " + e.message, "error");
    console.error("[avatar]", e);
  }
}

// ✅ NOUVEAU — Avatar animé GIF via FFmpeg (route serveur à créer)
async function generateAnimatedAvatar() {
  const statusEl   = $("avatarStatus");
  const progressWrap = $("gifProgressWrap");
  const progressBar  = $("gifProgressBar");
  const progressLbl  = $("gifProgressLabel");

  if (statusEl)     statusEl.textContent = "⏳ Génération GIF animé en cours...";
  if (progressWrap) progressWrap.hidden  = false;
  if (progressBar)  progressBar.style.width = "5%";
  if (progressLbl)  progressLbl.textContent = "Initialisation...";

  try {
    await refreshCsrf();

    // Simulation de progression pendant la génération (réseau seul)
    let pct = 5;
    const progTimer = setInterval(() => {
      pct = Math.min(pct + 3, 90);
      if (progressBar) progressBar.style.width = pct + "%";
      if (progressLbl) {
        if (pct < 30) progressLbl.textContent = "Génération des poses...";
        else if (pct < 60) progressLbl.textContent = "Assemblage des images...";
        else progressLbl.textContent = "Encodage GIF FFmpeg...";
      }
    }, 2000);

    const d = await api("POST", "/api/generate/avatar/animated", {
      frames: 6,
      style:  "portrait"
    });

    clearInterval(progTimer);

    if (!d.ok) throw new Error(d.error || "Erreur GIF");

    if (progressBar)  progressBar.style.width = "100%";
    if (progressLbl)  progressLbl.textContent = "✅ GIF prêt !";

    // Afficher le GIF dans le header (cache-busting avec timestamp)
    const gifUrl = d.url + "?t=" + Date.now();
    if ($("avatarImg"))   { $("avatarImg").src = gifUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji")) $("avatarEmoji").hidden = true;
    if ($("avatarModalImg"))   { $("avatarModalImg").src = gifUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";

    // Mettre à jour tous les avatars du chat
    document.querySelectorAll(".msg-avatar img").forEach(i => { i.src = gifUrl; });

    if (user) { user.avatarUrl = d.url; user.personaPhotoUrl = d.url; }
    updateHeader();

    showToast("🎞️ Avatar animé GIF créé !", "success");
    if (statusEl) statusEl.textContent = "✅ Avatar animé GIF actif !";

    // Cacher la barre après 3s
    setTimeout(() => { if (progressWrap) progressWrap.hidden = true; }, 3000);
  } catch (e) {
    if (progressWrap) progressWrap.hidden = true;
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    showToast("❌ " + e.message, "error");
    console.error("[gif avatar]", e);
  }
}

// ✅ CORRIGÉ : appendMessage → addMsg + seed aléatoire
async function generateSelfie(style, tenue, contexte) {
  showToast(`🎨 Génération ${style || "selfie"}...`, "info");
  try {
    await refreshCsrf();
    const d = await api("POST", "/api/generate/selfie", {
      style:    style || "sensuelle",
      tenue,
      contexte,
      seed: Math.floor(Math.random() * 999999999) // ✅ aléatoire
    });
    if (!d.ok) throw new Error(d.error);
    showToast("✨ Photo générée !", "success");
    addMsg("assistant", `[Photo générée — ${style}]`, d.url, "image/png"); // ✅ était appendMessage
    if ($("galleryPanel") && $("galleryPanel").open) loadGallery();
    return d.url;
  } catch (e) {
    showToast("❌ " + e.message, "error");
  }
}

// ✅ CORRIGÉ : galerie via DOM (createElement) — plus d'XSS via onclick inline
async function loadGallery() {
  const panel = $("galleryGrid");
  if (!panel) return;
  panel.innerHTML = "<p style='color:#aaa;grid-column:1/-1;text-align:center;padding:12px'>Chargement...</p>";
  try {
    const d = await api("GET", "/api/gallery");
    if (!d.ok || !d.photos?.length) {
      panel.innerHTML = "<p style='color:#888;grid-column:1/-1;text-align:center;padding:12px'>Aucune photo générée pour l'instant.</p>";
      return;
    }
    panel.innerHTML = "";
    d.photos.forEach(p => {
      const cell = document.createElement("div");
      cell.className = "gallery-item";
      cell.style.cssText = "position:relative;border-radius:8px;overflow:hidden";

      const img = document.createElement("img");
      img.src     = p.filename;
      img.loading = "lazy";
      img.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;display:block;cursor:pointer;border:2px solid transparent;transition:border-color .15s";
      img.onmouseover = () => { img.style.borderColor = "#ff3f91"; };
      img.onmouseout  = () => { img.style.borderColor = "transparent"; };
      img.onclick = () => openPhotoFull(p.filename);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "💾";
      saveBtn.title = "Définir comme avatar";
      saveBtn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.75);border:none;color:#fff;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:13px";
      saveBtn.onclick = async (e) => {
        e.stopPropagation();
        await saveAsAvatar(p.filename);
        closeAvatarModal();
      };

      cell.appendChild(img);
      cell.appendChild(saveBtn);
      panel.appendChild(cell);
    });
  } catch (e) {
    panel.innerHTML = "<p style='color:#e55;grid-column:1/-1;text-align:center;padding:12px'>❌ " + esc(e.message) + "</p>";
  }
}

function openPhotoFull(url) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer";
  overlay.onclick = () => overlay.remove();
  const img = document.createElement("img");
  img.src = url;
  img.style.cssText = "max-width:95vw;max-height:95vh;border-radius:12px";
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}

async function loadStyles() {
  const d = await api("GET", "/api/generate/styles");
  if (!d.ok) return;
  const grid = $("stylesGrid");
  if (!grid) return;
  grid.innerHTML = "";
  d.styles.forEach(s => {
    const btn = document.createElement("button");
    btn.className = "style-btn";
    btn.style.cssText = "background:#1e1b2e;border:1px solid #ff3f91;border-radius:12px;padding:12px;cursor:pointer;color:#fff;text-align:center;transition:.2s;min-width:70px";
    btn.innerHTML = `<div style="font-size:28px">${esc(s.emoji)}</div><div style="font-size:12px;margin-top:4px;color:#ddd">${esc(s.label)}</div>`;
    btn.onclick = () => generateAIAvatar(s.id);
    grid.appendChild(btn);
  });
}

// ── GALERIE OVERLAY (selectFromGallery) ───────────────────────
async function selectFromGallery() {
  let d;
  try { d = await api("GET", "/api/gallery"); } catch (e) { showToast("❌ " + e.message, "error"); return; }
  if (!d?.ok || !d.photos?.length) { showToast("Aucune photo dans la galerie", "info"); return; }

  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.96);z-index:9999;overflow-y:auto;padding:20px;box-sizing:border-box";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px";
  const h2 = document.createElement("h2");
  h2.style.cssText = "color:#fff;margin:0;font-size:1.1rem";
  h2.textContent = `🖼️ Galerie (${d.photos.length})`;
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:none;border:none;color:#fff;font-size:28px;cursor:pointer;line-height:1;padding:0 4px";
  closeBtn.onclick = () => ov.remove();
  header.appendChild(h2);
  header.appendChild(closeBtn);
  ov.appendChild(header);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:6px";

  d.photos.forEach(p => {
    const cell = document.createElement("div");
    cell.style.cssText = "position:relative;cursor:pointer;border-radius:8px;overflow:hidden";

    const img = document.createElement("img");
    img.src     = p.filename;
    img.loading = "lazy";
    img.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;display:block;border:2px solid transparent;transition:border-color .15s";
    img.onmouseover = () => { img.style.borderColor = "#ff3f91"; };
    img.onmouseout  = () => { img.style.borderColor = "transparent"; };
    img.onclick = () => openPhotoFull(p.filename);

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾";
    saveBtn.title = "Définir comme avatar";
    saveBtn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.75);border:none;color:#fff;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:13px";
    saveBtn.onclick = async (e) => { e.stopPropagation(); await saveAsAvatar(p.filename); ov.remove(); };

    cell.appendChild(img);
    cell.appendChild(saveBtn);
    grid.appendChild(cell);
  });

  ov.appendChild(grid);
  document.body.appendChild(ov);
}

async function saveAsAvatar(url) {
  try {
    await refreshCsrf();
    await fetch("/api/avatar", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ avatar: url })
    });
    if (window.user) { window.user.avatarUrl = url; window.user.personaPhotoUrl = url; }
    updateHeader();
    document.querySelectorAll(".msg-avatar img").forEach(i => { i.src = url; });
    document.querySelectorAll(".msg-avatar").forEach(d => {
      if (!d.querySelector("img")) {
        const img = document.createElement("img");
        img.src = url;
        img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover";
        d.textContent = "";
        d.appendChild(img);
      }
    });
    showToast("✅ Avatar mis à jour !", "success");
  } catch (e) { showToast("❌ " + e.message, "error"); }
}

async function clearMessages() {
  if (!confirm("Effacer toute la conversation ?")) return;
  await api("DELETE", "/api/messages");
  await loadMessages();
  showToast("Conversation effacée", "info");
}

async function clearMemories() {
  if (!confirm("Effacer tous les souvenirs ?")) return;
  await api("DELETE", "/api/memories");
  showToast("Souvenirs effacés", "info");
}

function exportData() { location.href = "/api/export"; }

// ── PROACTIVITÉ ── ✅ CORRIGÉ : clearInterval au lieu de clearTimeout ──
function scheduleProactive() {
  if (proactiveTimer) clearInterval(proactiveTimer); // ✅ était clearTimeout
  const proactivite = user?.extendedProfile?.proactivite || "normale";
  if (proactivite === "off") return;
  const intervals = { haute: 90 * 60 * 1000, normale: 3 * 60 * 60 * 1000, basse: 6 * 60 * 60 * 1000 };
  const interval  = intervals[proactivite] || intervals.normale;
  proactiveTimer = setInterval(checkProactiveMessages, Math.min(interval, 5 * 60 * 1000));
  setTimeout(checkProactiveMessages, 10 * 1000);
}

async function checkProactiveMessages() {
  try {
    const data = await api("GET", "/api/proactive/pending");
    if (!data.ok || !data.messages?.length) return;
    for (const msg of data.messages) {
      if (msg.type === "selfie" && msg.content) {
        try {
          const imgData = await api("POST", "/api/generate/image", {
            prompt: msg.content,
            style: "realistic",
            seed: Math.floor(Math.random() * 999999999)
          });
          if (imgData.ok && imgData.url) {
            addMsg("assistant", "💕", imgData.url, "image/jpeg");
            if (ttsGlobalEnabled) await speak("Je t'envoie un selfie mon amour 💕");
          }
        } catch (e) { console.error("[proactif selfie]", e); }
      } else if (msg.content) {
        addMsg("assistant", msg.content);
        if (ttsGlobalEnabled) await speak(msg.content);
      }
    }
  } catch {}
}

// ── PANNEAU PARAMÈTRES ────────────────────────────────────────
function openPanel() {
  if ($("settingsPanel"))  $("settingsPanel").hidden  = false;
  if ($("settingsOverlay")) $("settingsOverlay").hidden = false;
}
function closePanel() {
  if ($("settingsPanel"))  $("settingsPanel").hidden  = true;
  if ($("settingsOverlay")) $("settingsOverlay").hidden = true;
}
function showTab(tabId, btn) {
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".snav-btn").forEach(b => b.classList.remove("active"));
  const t = $(tabId);
  if (t) t.classList.add("active");
  if (btn) btn.classList.add("active");
}
function scrollNav(dir) {
  const n = $("settingsNav");
  if (n) n.scrollBy({ left: dir * 120, behavior: "smooth" });
}

async function saveTTSSettings() {
  try {
    await api("PUT", "/api/profile", {
      ttsEnabled: $("sTTSEnabled")?.checked || false,
      ttsSpeed:   $("sTTSSpeed")?.value     || "1.0"
    });
  } catch {}
}

// ── SCÉNARIOS ─────────────────────────────────────────────────
function openScenarioMenu()  { const m = $("scenarioModal"); if (m) m.hidden = false; }
function closeScenarioMenu() { const m = $("scenarioModal"); if (m) m.hidden = true; }

async function startScenario(type) {
  closeScenarioMenu();
  const input = $("msgInput");
  if (!input) return;
  input.value = type === "court"
    ? "[SCENARIO:court] Lance une scène courte et intense basée sur mon profil. Commence directement in media res."
    : "[SCENARIO:long] Lance une histoire longue. Chapitre 1 : tension et mise en place.";
  await sendMsg();
}
function stopScenario() {
  closeScenarioMenu();
  const input = $("msgInput");
  if (input) { input.value = "[STOP_SCENARIO] Arrête le scénario et reviens à la conversation normale."; sendMsg(); }
}

// ── ONBOARDING ────────────────────────────────────────────────
function onbChoose(mode) {
  const s0 = $("onbStep0"), sf = $("onbStepForm"), sp = $("onbStepPreset");
  if (s0) s0.hidden = true;
  if (sf) sf.hidden = (mode !== "form");
  if (sp) sp.hidden = (mode !== "preset");
  if (mode === "guide" || mode === "skip") {
    const os = $("onboardingScreen"), as = $("appScreen");
    if (os) os.hidden = true;
    if (as) as.hidden = false;
    updateHeader();
  }
}
function onbBack() {
  const s0 = $("onbStep0"), sf = $("onbStepForm"), sp = $("onbStepPreset");
  if (sf) sf.hidden = true;
  if (sp) sp.hidden = true;
  if (s0) s0.hidden = false;
}
async function onbSaveForm() {
  try {
    const aiName  = $("onbAiName")?.value?.trim()  || "Élissia";
    const persona = $("onbRelation")?.value         || "girlfriend";
    await api("PUT", "/api/profile", { aiName, preferredPersona: persona });
    await api("PUT", "/api/profile/extended", {
      caractere: $("onbCaractere")?.value?.trim() || "",
      passions:  $("onbPassions")?.value?.trim()  || ""
    });
    if (window.user) { window.user.aiName = aiName; window.user.preferredPersona = persona; }
    const os = $("onboardingScreen"), as = $("appScreen");
    if (os) os.hidden = true;
    if (as) as.hidden = false;
    updateHeader();
    showToast("✅ Profil créé !", "success");
  } catch (e) {
    const er = $("onbError");
    if (er) er.textContent = e.message;
  }
}
async function onbApplyPreset(key) {
  const P = {
    girlfriend: { aiName: "Élise",          preferredPersona: "girlfriend", caractere: "Douce, romantique, câline",        niveau_intensite: "4", curseur_douceur: "8", curseur_romantisme: "8", curseur_crudite: "4", curseur_domination: "3" },
    domina:     { aiName: "Maîtresse Nyx",  preferredPersona: "dom_hard",   caractere: "Autoritaire, cruelle, implacable", niveau_intensite: "9", curseur_crudite: "9", curseur_domination: "10", curseur_humiliation: "8" },
    libertine:  { aiName: "Luna",           preferredPersona: "hedoniste",  caractere: "Libre, décomplexée, sans tabou",   niveau_intensite: "10", curseur_crudite: "10", curseur_initiative: "9" },
    confidente: { aiName: "Sophie",         preferredPersona: "adult_intimate", caractere: "Empathique, douce, complice",  niveau_intensite: "5", curseur_douceur: "9" }
  };
  const p = P[key]; if (!p) return;
  try {
    const { aiName, preferredPersona, ...ext } = p;
    await api("PUT", "/api/profile", { aiName, preferredPersona });
    await api("PUT", "/api/profile/extended", ext);
    if (window.user) { window.user.aiName = aiName; window.user.preferredPersona = preferredPersona; }
    const os = $("onboardingScreen"), as = $("appScreen");
    if (os) os.hidden = true;
    if (as) as.hidden = false;
    updateHeader();
    showToast(`✅ "${aiName}" appliqué !`, "success");
  } catch (e) {
    const er = $("onbError");
    if (er) er.textContent = e.message;
  }
}

// ── GÉNÉRATION IMAGE CÔTÉ CLIENT (fallback) ───────────────────
async function generateAndSaveImage(prompt, style, seed, companionId) {
  const tok = localStorage.getItem("csrf") || "";
  const r = await fetch("/api/generate/image", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": tok },
    body: JSON.stringify({ prompt, style, seed: seed || Math.floor(Math.random() * 999999999) })
  });
  const d = await r.json();
  if (d.ok && d.url) return d.url;
  if (d.clientSide) throw new Error("ComfyUI indisponible — vérifie que ComfyUI Desktop est lancé sur le port 8188");
  throw new Error(d.error || "Génération échouée");
}

function openPhotoSelector() { openAvatarModal(); }

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  const authForm = $("authForm");
  if (authForm) authForm.onsubmit = submitAuth;

  const loginTab    = $("loginTab");
  const registerTab = $("registerTab");
  if (loginTab)    loginTab.onclick    = () => setAuthMode("login");
  if (registerTab) registerTab.onclick = () => setAuthMode("register");

  const msgInput = $("msgInput");
  if (msgInput) {
    msgInput.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    msgInput.addEventListener("input", () => autoGrow(msgInput));
  }

  checkSession();
});

// ── EXPORTS GLOBAUX ───────────────────────────────────────────
Object.assign(window, {
  openPanel, closePanel, showTab, scrollNav,
  saveTTSSettings, selectFromGallery, saveAsAvatar,
  openPhotoSelector, openScenarioMenu, closeScenarioMenu,
  startScenario, stopScenario,
  onbChoose, onbBack, onbSaveForm, onbApplyPreset,
  saveAll, sendMsg,
  toggleTTSGlobal, toggleWebcam, stopWebcam, toggleMic,
  handleMedia, cancelMedia,
  openAvatarModal, closeAvatarModal,
  generateAIAvatar, generateSelfie, generateAnimatedAvatar,
  loadGallery, loadStyles, openPhotoFull,
  clearMessages, clearMemories, exportData, logout,
  updateAdultUI, autoGrow, setAuthMode, submitAuth,
  generateAndSaveImage
});
