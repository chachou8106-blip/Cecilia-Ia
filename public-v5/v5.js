/* ══════════════════════════════════════════════════════════════
   ÉLISSIA v12 — Frontend Mobile Complet
   ✅ v11 Bug 1 : MulterError "Unexpected field" corrigé
                  uploadManualAvatar envoie field "avatar" → /api/avatar/upload
   ✅ v11 Bug 2 : Doublons getCurrentExt() supprimés
                  pilosite/style_pilosite/couleur_pilosite définis 1x
   ✅ v11 Bug 3 : sMorphoIntime existait pas dans HTML → ajouté mobile.html
   ✅ v11 Feat 1 : Roleplay persistant — scenarioActive + scenarioContext
                   injectés dans CHAQUE sendMsg body
   ✅ v11 Feat 2 : Scénarios narratifs 12 types avec arcs
   ✅ v11 Feat 3 : Auto-sync curseurs selon persona sélectionnée
   ✅ v11 Feat 4 : Bouton ⚡ génération rapide (tenue+position+lieu) dans chat
   ✅ v11 Feat 5 : Tenues 80+ classées par genre dynamique
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

// ✅ v11 — Scénario persistant
let scenarioActive = false;
let scenarioContext = "";
let scenarioType = "";

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

// ✅ Déconnecte uniquement sur 401/403 — pas sur erreur réseau/5xx
async function checkSession() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" });
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
  loadCompanions().catch(() => {});
  updateHeader();
  scheduleProactive();
  // ✅ v13 : expressions localStorage
  if (typeof _loadExpressionsFromStorage === "function") _loadExpressionsFromStorage();

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

  const avatarUrl = user?.avatarAnimatedUrl || user?.avatarUrl || user?.personaPhotoUrl;
  if (avatarUrl) {
    if ($("avatarImg"))   { $("avatarImg").src = avatarUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji")) $("avatarEmoji").hidden = true;
    const physPreview = $("physAvatarPreview");
    const physEmoji   = $("physAvatarEmoji");
    if (physPreview) { physPreview.src = avatarUrl; physPreview.style.display = "block"; }
    if (physEmoji)   physEmoji.style.display = "none";
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

  if ($("sCorpulence"))         $("sCorpulence").value         = ext.corpulence         || "";
  if ($("sTonicite"))           $("sTonicite").value           = ext.tonicite            || "";
  if ($("sHanches"))            $("sHanches").value            = ext.hanches             || "";
  if ($("sVentre"))             $("sVentre").value             = ext.ventre              || "";
  if ($("sJambes"))             $("sJambes").value             = ext.jambes              || "";
  if ($("sTaille"))             $("sTaille").value             = ext.taille              || "";
  if ($("sPoids"))              $("sPoids").value              = ext.poids               || "";
  if ($("sTextureCheveux"))     $("sTextureCheveux").value     = ext.texture_cheveux     || "";
  // Corps féminin
  if ($("sTailleSeins"))        $("sTailleSeins").value        = ext.taille_seins        || "";
  if ($("sFormeSeins"))         $("sFormeSeins").value         = ext.forme_seins         || "";
  if ($("sTeton"))              $("sTeton").value              = ext.teton               || "";
  if ($("sFormeFesses"))        $("sFormeFesses").value        = ext.forme_fesses        || "";
  if ($("sFormeFessesShape"))   $("sFormeFessesShape").value   = ext.forme_fesses_shape  || "";
  // Anatomie intime féminine
  if ($("sStylePilosite"))      $("sStylePilosite").value      = ext.style_pilosite      || "";
  if ($("sCouleurPilosite"))    $("sCouleurPilosite").value    = ext.couleur_pilosite    || "";
  if ($("sLevresIntimes"))      $("sLevresIntimes").value      = ext.levres_intimes      || "";
  if ($("sClitoris"))           $("sClitoris").value           = ext.clitoris            || "";
  if ($("sPilosite"))           $("sPilosite").value           = ext.pilosite            || "rasée";
  // Corps masculin
  if ($("sPectoraux"))          $("sPectoraux").value          = ext.pectoraux           || "";
  if ($("sAbdominaux"))         $("sAbdominaux").value         = ext.abdominaux          || "";
  if ($("sTailleSexeM"))        $("sTailleSexeM").value        = ext.taille_sexe_m       || "";
  if ($("sEpaisseurSexeM"))     $("sEpaisseurSexeM").value     = ext.epaisseur_sexe_m    || "";
  if ($("sFormeSexeM"))         $("sFormeSexeM").value         = ext.forme_sexe_m        || "";
  if ($("sCirconcis"))          $("sCirconcis").value          = ext.circoncis           || "";
  if ($("sTesticules"))         $("sTesticules").value         = ext.testicules          || "";
  if ($("sPilositeMasc"))       $("sPilositeMasc").value       = ext.pilosite_masc       || "";

  document.dispatchEvent(new Event("profileLoaded"));

  // Nouveaux champs v11-v12
  if ($("sAnatomieLibre"))       $("sAnatomieLibre").checked        = ext.anatomie_libre === "true" || ext.anatomie_libre === true;
  if ($("sStatutChirurgical"))   $("sStatutChirurgical").value      = ext.statut_chirurgical || "";
  if ($("sLongueurCheveux"))     $("sLongueurCheveux").value        = ext.longueur_cheveux || "longs";
  if ($("sCheveux"))             $("sCheveux").value                = ext.cheveux          || "";
  if ($("sYeux"))                $("sYeux").value                   = ext.yeux             || "";
  if ($("sCouleurPeau"))         $("sCouleurPeau").value            = ext.couleur_peau     || "claire";
  if ($("sTailleLevres"))        $("sTailleLevres").value           = ext.taille_levres    || "normales";
  if ($("sMorphoIntime"))        $("sMorphoIntime").value           = ext.morpho_intime    || "naturelle normale";
  if ($("sLunettes"))            $("sLunettes").value               = ext.lunettes         || "";
  if ($("sBijoux"))              $("sBijoux").value                 = ext.bijoux           || "";
  if ($("sCollierBijou"))        $("sCollierBijou").value           = ext.collier_bijou    || "";
  if ($("sBouclesOreilles"))     $("sBouclesOreilles").value        = ext.boucles_oreilles || "";
  if ($("sBracelet"))            $("sBracelet").value               = ext.bracelet         || "";
  if ($("sTatouages"))           $("sTatouages").value              = ext.tatouages        || "";
  if ($("sPiercings"))           $("sPiercings").value              = ext.piercings        || "";
  if ($("sStyle"))               $("sStyle").value                  = ext.style            || "";
  if ($("sTenuePreferee"))       $("sTenuePreferee").value          = ext.tenue_preferee   || "";
  if ($("sMaquillage"))          $("sMaquillage").value             = ext.maquillage       || "";

  if ($("sCaractere"))  $("sCaractere").value  = ext.caractere  || "";
  if ($("sPassions"))   $("sPassions").value   = ext.passions   || "";
  if ($("sProfession")) $("sProfession").value = ext.profession || "";
  if ($("sHumour"))     $("sHumour").value     = ext.humour     || "taquin";
  if ($("sJalousie"))   $("sJalousie").value   = ext.jalousie   || "légère";
  if ($("sValeurs"))    $("sValeurs").value    = ext.valeurs    || "";

  if ($("sPersona"))         $("sPersona").value         = u.preferredPersona   || "girlfriend";
  if ($("sKinks"))           $("sKinks").value           = ext.kinks            || "";
  if ($("sFantasmes"))       $("sFantasmes").value       = ext.fantasmes        || "";
  if ($("sPratiques"))       $("sPratiques").value       = ext.pratiques        || "";
  if ($("sLimites"))         $("sLimites").value         = ext.limites          || "";
  if ($("sRythme"))          $("sRythme").value          = ext.rythme           || "toujours disponible";
  if ($("sPreferencesChat")) $("sPreferencesChat").value = ext.preferences_chat || "très cru et explicite";

  if ($("sRelation"))    $("sRelation").value    = ext.relation    || u.relationshipStyle || "romantique";
  if ($("sProactivite")) $("sProactivite").value = ext.proactivite || "normale";

  if ($("sNiveauIntensite"))    $("sNiveauIntensite").value    = ext.niveau_intensite    || "7";
  if ($("sInitiativeSexuelle")) $("sInitiativeSexuelle").value = ext.initiative_sexuelle || "normale";
  if ($("niveauVal"))           $("niveauVal").textContent     = ext.niveau_intensite    || "7";

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
  syncCurseurLabels();

  if ($("sTTSEnabled")) $("sTTSEnabled").checked = u.ttsEnabled || false;
  if ($("sTTSSpeed"))   $("sTTSSpeed").value     = u.ttsSpeed   || "1.0";
  if ($("sAutoPhoto"))  $("sAutoPhoto").checked  = ext.auto_photo === "true" || ext.auto_photo === true;
  if ($("sWebSearch"))  $("sWebSearch").checked  = Boolean(u.webSearchEnabled);

  if ($("sAgeConfirm")) $("sAgeConfirm").checked = Boolean(u.ageConfirmed);
  if ($("sAdultMode"))  $("sAdultMode").checked  = Boolean(u.adultMode);

  updateAdultUI();
}

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

function updateCurseurLabels() { syncCurseurLabels(); }

function updateAdultUI() {
  const age   = $("sAgeConfirm")?.checked;
  const adult = $("sAdultMode")?.checked;
  if ($("adultWarning")) $("adultWarning").hidden = !(age && adult);
  if ($("sexContent"))   $("sexContent").hidden   = !(age && adult);
  if ($("adultGate"))    $("adultGate").hidden    = !!(age && adult);
}

// ✅ v11 : Auto-sync curseurs selon persona
function syncCurseursParPersona(persona) {
  const PRESETS = {
    dom_hard:          { curseur_douceur:"1", curseur_crudite:"10", curseur_domination:"10", curseur_humiliation:"9", curseur_romantisme:"1", curseur_initiative:"9" },
    dom_soft:          { curseur_douceur:"4", curseur_crudite:"7",  curseur_domination:"8",  curseur_humiliation:"5", curseur_romantisme:"4", curseur_initiative:"7" },
    homme_dom:         { curseur_douceur:"3", curseur_crudite:"8",  curseur_domination:"9",  curseur_humiliation:"6", curseur_romantisme:"3", curseur_initiative:"8" },
    sub_hard:          { curseur_douceur:"9", curseur_crudite:"8",  curseur_domination:"1",  curseur_humiliation:"8", curseur_romantisme:"5", curseur_initiative:"1" },
    sub_soft:          { curseur_douceur:"8", curseur_crudite:"5",  curseur_domination:"2",  curseur_humiliation:"4", curseur_romantisme:"7", curseur_initiative:"2" },
    bdsm_complet:      { curseur_douceur:"2", curseur_crudite:"9",  curseur_domination:"8",  curseur_humiliation:"8", curseur_romantisme:"3", curseur_initiative:"7" },
    adult_intimate:    { curseur_douceur:"6", curseur_crudite:"7",  curseur_domination:"5",  curseur_humiliation:"3", curseur_romantisme:"6", curseur_initiative:"6" },
    hedoniste:         { curseur_douceur:"6", curseur_crudite:"9",  curseur_domination:"4",  curseur_humiliation:"3", curseur_romantisme:"4", curseur_initiative:"9" },
    girlfriend:        { curseur_douceur:"8", curseur_crudite:"4",  curseur_domination:"3",  curseur_humiliation:"1", curseur_romantisme:"9", curseur_initiative:"5" },
    asexuel_romantique:{ curseur_douceur:"10",curseur_crudite:"1",  curseur_domination:"1",  curseur_humiliation:"0", curseur_romantisme:"10",curseur_initiative:"2" },
    fetichiste:        { curseur_douceur:"5", curseur_crudite:"8",  curseur_domination:"6",  curseur_humiliation:"5", curseur_romantisme:"3", curseur_initiative:"6" },
    exhib:             { curseur_douceur:"5", curseur_crudite:"8",  curseur_domination:"4",  curseur_humiliation:"3", curseur_romantisme:"4", curseur_initiative:"9" },
    echangiste:        { curseur_douceur:"5", curseur_crudite:"9",  curseur_domination:"4",  curseur_humiliation:"2", curseur_romantisme:"4", curseur_initiative:"8" },
    bisexuel:          { curseur_douceur:"6", curseur_crudite:"7",  curseur_domination:"4",  curseur_humiliation:"2", curseur_romantisme:"6", curseur_initiative:"6" },
    pan:               { curseur_douceur:"7", curseur_crudite:"7",  curseur_domination:"4",  curseur_humiliation:"2", curseur_romantisme:"7", curseur_initiative:"6" },
  };
  const p = PRESETS[persona];
  if (!p) return;
  const map = {
    sCurseurDouceur:"curseur_douceur", sCurseurCrudite:"curseur_crudite",
    sCurseurDomination:"curseur_domination", sCurseurHumiliation:"curseur_humiliation",
    sCurseurRomantisme:"curseur_romantisme", sCurseurInitiative:"curseur_initiative"
  };
  for (const [elId, key] of Object.entries(map)) {
    if ($(elId) && p[key] !== undefined) $(elId).value = p[key];
  }
  syncCurseurLabels();
  showToast("🎛️ Curseurs synchronisés avec la persona", "info");
}

// ── HELPER : snapshot du profil courant ───────────────────────
// ✅ v11 : Doublons supprimés — pilosite/style_pilosite/couleur_pilosite 1x chacun
function getCurrentExt() {
  return {
    // Identité
    user_genre: $("sUserGenre")?.value || user?.extendedProfile?.user_genre || "homme",
    genre:      $("sGenre")?.value     || user?.extendedProfile?.genre       || "femme",
    age:        $("sAge")?.value       || user?.extendedProfile?.age         || "25",
    origine:    $("sOrigine")?.value   || user?.extendedProfile?.origine     || "",
    langue:     $("sLangue")?.value    || user?.extendedProfile?.langue      || "français",
    histoire:   $("sHistoire")?.value  || user?.extendedProfile?.histoire    || "",
    // Physique global
    corpulence:       $("sCorpulence")?.value      || user?.extendedProfile?.corpulence       || "",
    tonicite:         $("sTonicite")?.value         || user?.extendedProfile?.tonicite         || "",
    taille:           $("sTaille")?.value           || user?.extendedProfile?.taille           || "",
    poids:            $("sPoids")?.value            || user?.extendedProfile?.poids            || "",
    hanches:          $("sHanches")?.value          || user?.extendedProfile?.hanches          || "",
    ventre:           $("sVentre")?.value           || user?.extendedProfile?.ventre           || "",
    jambes:           $("sJambes")?.value           || user?.extendedProfile?.jambes           || "",
    longueur_cheveux: $("sLongueurCheveux")?.value  || user?.extendedProfile?.longueur_cheveux || "",
    texture_cheveux:  $("sTextureCheveux")?.value   || user?.extendedProfile?.texture_cheveux  || "",
    cheveux:          $("sCheveux")?.value          || user?.extendedProfile?.cheveux          || "",
    yeux:             $("sYeux")?.value             || user?.extendedProfile?.yeux             || "",
    couleur_peau:     $("sCouleurPeau")?.value      || user?.extendedProfile?.couleur_peau     || "",
    taille_levres:    $("sTailleLevres")?.value     || user?.extendedProfile?.taille_levres    || "",
    maquillage:       $("sMaquillage")?.value       || user?.extendedProfile?.maquillage       || "",
    // Corps féminin
    taille_seins:       $("sTailleSeins")?.value       || user?.extendedProfile?.taille_seins      || "",
    forme_seins:        $("sFormeSeins")?.value        || user?.extendedProfile?.forme_seins        || "",
    teton:              $("sTeton")?.value             || user?.extendedProfile?.teton              || "",
    forme_fesses:       $("sFormeFesses")?.value       || user?.extendedProfile?.forme_fesses       || "",
    forme_fesses_shape: $("sFormeFessesShape")?.value  || user?.extendedProfile?.forme_fesses_shape || "",
    // Anatomie intime féminine — 1x chacun (bug doublons corrigé)
    pilosite:         $("sPilosite")?.value         || user?.extendedProfile?.pilosite         || "",
    style_pilosite:   $("sStylePilosite")?.value    || user?.extendedProfile?.style_pilosite   || "",
    couleur_pilosite: $("sCouleurPilosite")?.value  || user?.extendedProfile?.couleur_pilosite || "",
    levres_intimes:   $("sLevresIntimes")?.value    || user?.extendedProfile?.levres_intimes   || "",
    clitoris:         $("sClitoris")?.value         || user?.extendedProfile?.clitoris         || "",
    morpho_intime:    $("sMorphoIntime")?.value     || user?.extendedProfile?.morpho_intime    || "",
    // Corps masculin
    pectoraux:        $("sPectoraux")?.value        || user?.extendedProfile?.pectoraux        || "",
    abdominaux:       $("sAbdominaux")?.value       || user?.extendedProfile?.abdominaux       || "",
    taille_sexe_m:    $("sTailleSexeM")?.value      || user?.extendedProfile?.taille_sexe_m    || "",
    epaisseur_sexe_m: $("sEpaisseurSexeM")?.value   || user?.extendedProfile?.epaisseur_sexe_m || "",
    forme_sexe_m:     $("sFormeSexeM")?.value       || user?.extendedProfile?.forme_sexe_m     || "",
    circoncis:        $("sCirconcis")?.value        || user?.extendedProfile?.circoncis         || "",
    testicules:       $("sTesticules")?.value       || user?.extendedProfile?.testicules        || "",
    pilosite_masc:    $("sPilositeMasc")?.value     || user?.extendedProfile?.pilosite_masc    || "",
    // Anatomie hybride / trans
    anatomie_libre:       $("sAnatomieLibre")?.checked ? "true" : (user?.extendedProfile?.anatomie_libre || ""),
    statut_chirurgical:   $("sStatutChirurgical")?.value || user?.extendedProfile?.statut_chirurgical || "",
    // Accessoires
    tatouages:        $("sTatouages")?.value       || user?.extendedProfile?.tatouages        || "",
    piercings:        $("sPiercings")?.value       || user?.extendedProfile?.piercings        || "",
    style:            $("sStyle")?.value           || user?.extendedProfile?.style            || "",
    tenue_preferee:   $("sTenuePreferee")?.value   || user?.extendedProfile?.tenue_preferee   || "",
    // ✅ v13 — Bijoux & lunettes
    lunettes:         $("sLunettes")?.value        || user?.extendedProfile?.lunettes         || "",
    bijoux:           $("sBijoux")?.value          || user?.extendedProfile?.bijoux           || "",
    collier_bijou:    $("sCollierBijou")?.value    || user?.extendedProfile?.collier_bijou    || "",
    boucles_oreilles: $("sBouclesOreilles")?.value || user?.extendedProfile?.boucles_oreilles || "",
    bracelet:         $("sBracelet")?.value        || user?.extendedProfile?.bracelet         || "",
    // Caractère
    caractere:  $("sCaractere")?.value  || user?.extendedProfile?.caractere  || "",
    passions:   $("sPassions")?.value   || user?.extendedProfile?.passions   || "",
    profession: $("sProfession")?.value || user?.extendedProfile?.profession || "",
    humour:     $("sHumour")?.value     || user?.extendedProfile?.humour     || "taquin",
    jalousie:   $("sJalousie")?.value   || user?.extendedProfile?.jalousie   || "légère",
    valeurs:    $("sValeurs")?.value    || user?.extendedProfile?.valeurs    || "",
    // Sexualité
    kinks:            $("sKinks")?.value           || user?.extendedProfile?.kinks            || "",
    fantasmes:        $("sFantasmes")?.value       || user?.extendedProfile?.fantasmes        || "",
    pratiques:        $("sPratiques")?.value       || user?.extendedProfile?.pratiques        || "",
    limites:          $("sLimites")?.value         || user?.extendedProfile?.limites          || "",
    rythme:           $("sRythme")?.value          || user?.extendedProfile?.rythme           || "toujours disponible",
    preferences_chat: $("sPreferencesChat")?.value || user?.extendedProfile?.preferences_chat || "très cru et explicite",
    // Relation & intensité
    relation:    $("sRelation")?.value    || user?.extendedProfile?.relation    || "romantique",
    proactivite: $("sProactivite")?.value || user?.extendedProfile?.proactivite || "normale",
    niveau_intensite:    $("sNiveauIntensite")?.value    || user?.extendedProfile?.niveau_intensite    || "7",
    initiative_sexuelle: $("sInitiativeSexuelle")?.value || user?.extendedProfile?.initiative_sexuelle || "normale",
    // Curseurs
    curseur_douceur:     $("sCurseurDouceur")?.value     || user?.extendedProfile?.curseur_douceur     || "5",
    curseur_crudite:     $("sCurseurCrudite")?.value     || user?.extendedProfile?.curseur_crudite     || "7",
    curseur_domination:  $("sCurseurDomination")?.value  || user?.extendedProfile?.curseur_domination  || "7",
    curseur_humiliation: $("sCurseurHumiliation")?.value || user?.extendedProfile?.curseur_humiliation || "5",
    curseur_romantisme:  $("sCurseurRomantisme")?.value  || user?.extendedProfile?.curseur_romantisme  || "3",
    curseur_initiative:  $("sCurseurInitiative")?.value  || user?.extendedProfile?.curseur_initiative  || "7",
    // Préférences conservées en mémoire
    mes_jouets:       user?.extendedProfile?.mes_jouets       || "",
    envies_pratiques: user?.extendedProfile?.envies_pratiques || ""
  };
}

// ── SAUVEGARDER ───────────────────────────────────────────────
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
      ttsEnabled:        $("sTTSEnabled")?.checked  || false,
      ttsSpeed:          $("sTTSSpeed")?.value      || "1.0",
      rgpdConsent: true
    };

    const d = await api("PUT", "/api/profile", profileData);
    user = d.user;

    const extData = {
      ...getCurrentExt(),
      auto_photo: String($("sAutoPhoto")?.checked || false)
    };

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
    const cid = window._activeCompanionId || null;
    const data = await api("GET", "/api/state" + (cid ? "?companionId=" + cid : ""));
    user = { ...user, ...data.user };
    const el = $("chatMessages");
    if (!el) return;
    el.innerHTML = "";
    if (!data.messages?.length) {
      addMsg("assistant", "Coucou 💗 Je suis là. Parle-moi de tout et de rien !");
      return;
    }
    data.messages.forEach(m => {
    const entry = addMsg(m.role, m.content, m.mediaUrl, m.mediaType);
    if (entry?.wrap && m.id) entry.wrap.dataset.msgId = m.id;
  });
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
  return E[user?.preferredPersona || "girlfriend"] || "💜";
}

function addMsg(role, text, mediaUrl, mediaType) {
  const el = $("chatMessages");
  if (!el) return null;

  const wrap = document.createElement("div");
  wrap.className = "msg msg-" + role;

  if (role === "assistant") {
    const avatarDiv = document.createElement("div");
    avatarDiv.className = "msg-avatar";
    const avatarUrl = user?.avatarUrl || user?.personaPhotoUrl;
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
    const isVideo = (mediaType || "").startsWith("video") || mediaUrl.includes("_vid_") || mediaUrl.endsWith(".mp4");
    const mediaEl = document.createElement(isVideo ? "video" : "img");
    mediaEl.src = mediaUrl;
    // ✅ v13 : photos cliquables pour agrandir + gestion erreur 404
    if (!isVideo) {
      mediaEl.style.cssText = "max-width:100%;max-height:320px;border-radius:12px;cursor:pointer;object-fit:cover;box-shadow:0 4px 16px rgba(0,0,0,.5)";
      mediaEl.onclick = () => typeof openPhotoFull === "function" && openPhotoFull(mediaUrl);
      mediaEl.onerror = () => { mediaDiv.style.display = "none"; }; // Cacher les 404
    } else {
      mediaEl.controls = true;
      mediaEl.style.cssText = "max-width:100%;border-radius:12px;";
      mediaEl.onerror = () => { mediaDiv.style.display = "none"; };
    }
    mediaDiv.appendChild(mediaEl);
    wrap.appendChild(mediaDiv);
  }

  if (role === "assistant" && /\[(IMG_GEN|VID_GEN|PHOTO|VIDEO)/.test(text || "")) {
    processMediaTagsInMessage(bubble, text || "");
  }

  // ✅ v13 : Bouton 🗑️ supprimer sur chaque message
  const delBtn = document.createElement("button");
  delBtn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.5);border:none;border-radius:50%;width:22px;height:22px;color:#e55;font-size:11px;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:10;padding:0";
  delBtn.textContent = "✕";
  delBtn.title = "Supprimer ce message";
  delBtn.onclick = async (ev) => {
    ev.stopPropagation();
    const msgId = wrap.dataset.msgId;
    if (!msgId) { wrap.remove(); return; }
    try {
      await refreshCsrf();
      const d = await fetch(`/api/messages/${msgId}`, {
        method:"DELETE", credentials:"same-origin",
        headers:{"X-CSRF-Token":csrf}
      });
      const r = await d.json();
      if (r.ok) wrap.remove();
      else showToast("❌ " + r.error, "error");
    } catch(e) { wrap.remove(); } // Supprimer localement même si erreur réseau
  };
  wrap.style.position = "relative";
  wrap.appendChild(delBtn);
  // Afficher/masquer le bouton au survol
  wrap.addEventListener("mouseenter", () => { delBtn.style.display = "flex"; });
  wrap.addEventListener("mouseleave", () => { delBtn.style.display = "none"; });
  // Touch : tap long = afficher
  let longPress;
  wrap.addEventListener("touchstart", () => { longPress = setTimeout(() => { delBtn.style.display = "flex"; }, 600); });
  wrap.addEventListener("touchend", () => clearTimeout(longPress));

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
      const rawStyle    = m[1] || m[2] || "";
      const style       = rawStyle.split(":")[0] || "sensuelle";
      const extraPrompt = rawStyle.includes(":") ? rawStyle.split(":").slice(1).join(":") : "";
      const data = await api("POST", "/api/generate/image", {
        style,
        prompt: extraPrompt,
        seed: Math.floor(Math.random() * 999999999),
        ext: getCurrentExt()
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
        vid.src = data.video_url; vid.controls = true;
        vid.style.cssText = "width:100%;max-width:300px;border-radius:12px;margin-top:4px;display:block;";
        el.innerHTML = ""; el.appendChild(vid);
      } else el.textContent = "❌ Vidéo non disponible";
    } catch (e) { el.textContent = "❌ " + e.message; }
  }
}

// ── ENVOI MESSAGE v11 : scénario persistant injecté ───────────
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

  const ext = getCurrentExt();
  let body = {
    message: text,
    persona: $("sPersona")?.value || user?.preferredPersona || "girlfriend",
    aiName:  $("sAiName")?.value  || user?.aiName            || "Élissia",
    userName: user?.displayName   || "Mon amour",
    adultMode: Boolean($("sAdultMode")?.checked && $("sAgeConfirm")?.checked),
    ext,
    // ✅ v11 : scénario persistant
    scenarioActive,
    scenarioContext,
    scenarioType,
    // ✅ v12 : multi-compagnons — companion actif
    companionId: window._activeCompanionId || null
  };

  // Média
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
      cancelMedia();
    }
  }

  // Webcam
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
  if (typeof _startAvatarSpeakAnim === "function") _startAvatarSpeakAnim(text);
  if (piperAvailable) { await speakPiper(text); } else { speakBrowser(text); }
  if (typeof _stopAvatarSpeakAnim === "function") _stopAvatarSpeakAnim();
}

function speakBrowser(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\[.*?\]/g, "").slice(0, 600));
  u.lang = "fr-FR"; u.rate = parseFloat($("sTTSSpeed")?.value || "0.95"); u.pitch = 1.1;
  const voices    = speechSynthesis.getVoices();
  const preferred = ["Microsoft Hortense", "Google français", "Microsoft Julie"];
  for (const name of preferred) {
    const v = voices.find(v => v.name.includes(name));
    if (v) { u.voice = v; break; }
  }
  if (!u.voice) { const fv = voices.find(v => v.lang.startsWith("fr")); if (fv) u.voice = fv; }
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
  const rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false; rec.start();
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
    const video = $("webcamVideo"), preview = $("webcamPreview");
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
  const preview = $("mediaPreview"), label = $("mediaPreviewLabel"), img = $("mediaPreviewImg");
  if (preview) preview.hidden = false;
  if (label)   label.textContent = file.name;
  if (img && file.type.startsWith("image/")) { img.src = URL.createObjectURL(file); img.hidden = false; }
}

function cancelMedia() {
  mediaFile = null;
  const preview = $("mediaPreview"); if (preview) preview.hidden = true;
  const input = $("mediaInput");   if (input)   input.value = "";
}

// ── AVATAR ────────────────────────────────────────────────────
function openAvatarModal() {
  if ($("avatarModal")) $("avatarModal").hidden = false;
  const avatarUrl = user?.avatarUrl || user?.personaPhotoUrl;
  if (avatarUrl) {
    if ($("avatarModalImg"))   { $("avatarModalImg").src = avatarUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";
  }
}
function closeAvatarModal() { if ($("avatarModal")) $("avatarModal").hidden = true; }

// ✅ v11 BUG FIX MulterError: Unexpected field
// Avant : fd.append("file", file) → /api/media/upload → crash Multer (attend "media")
// Après : fd.append("avatar", file) → /api/avatar/upload (route dédiée attend "avatar")
function uploadManualAvatar() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) { input.remove(); return; }
    try {
      showToast("⏳ Upload en cours...", "info");
      await refreshCsrf();
      const fd = new FormData();
      fd.append("avatar", file);  // ✅ FIX : "avatar" pas "file"
      const r = await fetch("/api/avatar/upload", {  // ✅ FIX : route dédiée
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrf },
        body: fd
      });
      const d = await r.json();
      if (!d.ok && !d.url) throw new Error(d.error || "Upload échoué");
      const url = d.url || d.avatarUrl;
      if (url) {
        await saveAsAvatar(url);
      }
      closeAvatarModal();
      showToast("✅ Photo importée !", "success");
    } catch (e) {
      showToast("❌ " + e.message, "error");
      console.error("[uploadManualAvatar]", e);
    } finally {
      input.remove();
    }
  };
  input.click();
}

async function generateAIAvatar(style = "portrait", tenue = null) {
  const statusEl = $("avatarStatus") || $("avatarGenStatus");
  if (statusEl) statusEl.textContent = "⏳ Génération en cours... (30-60s)";
  try {
    await refreshCsrf();
    const d = await api("POST", "/api/generate/avatar", {
      style, tenue: tenue || null,
      seed: Math.floor(Math.random() * 999999999),
      ext: getCurrentExt()
    });
    if (!d.ok) throw new Error(d.error || "Erreur génération");
    const avatarUrl = d.url;
    if ($("avatarImg"))        { $("avatarImg").src = avatarUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji"))      $("avatarEmoji").hidden = true;
    if ($("avatarModalImg"))   { $("avatarModalImg").src = avatarUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";
    if (user) { user.avatarUrl = avatarUrl; user.personaPhotoUrl = avatarUrl; }
    updateHeader();
    document.querySelectorAll(".msg-avatar img").forEach(i => { i.src = avatarUrl; });
    document.querySelectorAll(".msg-avatar").forEach(d => {
      if (!d.querySelector("img")) {
        const img = document.createElement("img");
        img.src = avatarUrl; img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover";
        d.textContent = ""; d.appendChild(img);
      }
    });
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

async function generateAnimatedAvatar() {
  const statusEl     = $("avatarStatus");
  const progressWrap = $("gifProgressWrap");
  const progressBar  = $("gifProgressBar");
  const progressLbl  = $("gifProgressLabel");

  if (statusEl)     statusEl.textContent     = "⏳ Génération vidéo animée...";
  if (progressWrap) progressWrap.hidden      = false;
  if (progressBar)  progressBar.style.width  = "5%";
  if (progressLbl)  progressLbl.textContent  = "Initialisation...";

  try {
    await refreshCsrf();
    let pct = 5;
    const progTimer = setInterval(() => {
      pct = Math.min(pct + 3, 90);
      if (progressBar) progressBar.style.width = pct + "%";
      if (progressLbl) progressLbl.textContent = pct < 30 ? "Génération des poses..." : pct < 60 ? "Assemblage FFmpeg..." : "Encodage MP4...";
    }, 2000);

    const d = await api("POST", "/api/generate/avatar/animated", {
      frames: 6, style: "portrait", ext: getCurrentExt()
    });
    clearInterval(progTimer);
    if (!d.ok) throw new Error(d.error || "Erreur vidéo");

    if (progressBar) progressBar.style.width = "100%";
    if (progressLbl) progressLbl.textContent = "✅ Vidéo prête !";

    const vidUrl = d.url + "?t=" + Date.now();
    if ($("avatarImg"))        { $("avatarImg").src = vidUrl; $("avatarImg").hidden = false; }
    if ($("avatarEmoji"))      $("avatarEmoji").hidden = true;
    if ($("avatarModalImg"))   { $("avatarModalImg").src = vidUrl; $("avatarModalImg").style.display = "block"; }
    if ($("avatarModalEmoji")) $("avatarModalEmoji").style.display = "none";
    document.querySelectorAll(".msg-avatar img").forEach(i => { i.src = vidUrl; });
    if (user) { user.avatarUrl = d.url; user.personaPhotoUrl = d.url; }
    updateHeader();
    showToast("🎞️ Vidéo animée créée !", "success");
    if (statusEl) statusEl.textContent = "✅ Avatar vidéo actif !";
    setTimeout(() => { if (progressWrap) progressWrap.hidden = true; }, 3000);
  } catch (e) {
    if ($("gifProgressWrap")) $("gifProgressWrap").hidden = true;
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    showToast("❌ " + e.message, "error");
    console.error("[vidéo avatar]", e);
  }
}

async function generateVideoChatContext() {
  const statusEl = $("avatarGenStatus") || $("physGenStatus");
  if (statusEl) statusEl.textContent = "⏳ Vidéo en cours... (60-120s)";
  showToast("🎬 Génération vidéo depuis notre conversation...", "info");
  try {
    await refreshCsrf();
    const explicit = Boolean(user?.adultMode && user?.ageConfirmed);
    const d = await api("POST", "/api/generate/video/chat", {
      explicit, ext: getCurrentExt()
    });
    if (!d.ok) throw new Error(d.error || "Erreur vidéo");
    const url = d.video_url || d.url;
    addMsg("assistant", "🎬 Voilà une petite vidéo pour toi... 😘", url, "video/mp4");
    if (statusEl) statusEl.textContent = "✅ Vidéo créée !";
    showToast("✅ Vidéo créée !", "success");
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    showToast("❌ " + e.message, "error");
    console.error("[videoChat]", e);
  }
}

async function generateSelfie(style, tenue, contexte) {
  showToast(`🎨 Génération ${style || "selfie"}...`, "info");
  try {
    await refreshCsrf();
    const _cidSelf = window._activeCompanionId || null;
    const _compSelf = _cidSelf ? (window._companions||[]).find(c=>c.id===_cidSelf) : null;
    const d = await api("POST", "/api/generate/selfie", {
      style: style || "sensuelle", tenue, contexte,
      seed: Math.floor(Math.random() * 999999999),
      companionId: _cidSelf,
      ext: _compSelf ? _compSelf.profile : getCurrentExt()
    });
    if (!d.ok) throw new Error(d.error);
    showToast("✨ Photo générée !", "success");
    addMsg("assistant", `[Photo générée — ${style}]`, d.url, "image/png");
    if ($("galleryPanel") && $("galleryPanel").open) loadGallery();
    return d.url;
  } catch (e) { showToast("❌ " + e.message, "error"); }
}

// ── ⚡ GÉNÉRATION RAPIDE depuis le chat ───────────────────────
function openGenRapide() {
  const el = $("genRapideSheet");
  if (el) el.hidden = false;
}
function closeGenRapide() {
  const el = $("genRapideSheet");
  if (el) el.hidden = true;
}

async function lancerGenRapide() {
  const genre = $("sGenre")?.value || "femme";
  const tenue   = $("grTenue")?.value   || "";
  const position = $("grPosition")?.value || "";
  const lieu    = $("grLieu")?.value    || "";
  const ambiance = $("grAmbiance")?.value || "";
  const typeGen = $("grType")?.value || "photo";
  // ✅ v13 : Compagnon actif → son profil exact, pas le profil user
  const activeCompId = window._activeCompanionId || null;
  const activeComp = activeCompId ? (window._companions||[]).find(c=>c.id===activeCompId) : null;

  if (!tenue && !position && !lieu) {
    showToast("Choisis au moins une tenue, position ou lieu", "info");
    return;
  }

  closeGenRapide();

  const parts = [];
  if (tenue)    parts.push(tenue);
  if (position) parts.push(position);
  if (lieu)     parts.push(lieu);
  if (ambiance) parts.push(ambiance);
  const prompt = parts.join(", ");

  showToast(`🎨 Génération ${typeGen} en cours...`, "info");

  try {
    await refreshCsrf();
    if (typeGen === "video") {
      const d = await api("POST", "/api/generate/video", {
        prompt, explicit: Boolean(user?.adultMode && user?.ageConfirmed),
        companionId: activeCompId,
        ext: activeComp ? activeComp.profile : getCurrentExt()
      });
      if (d.ok && d.video_url) {
        addMsg("assistant", `🎬 ${prompt}`, d.video_url, "video/mp4");
      } else throw new Error(d.error || "Échec vidéo");
    } else {
      const style = typeGen === "gif" ? "gif" : (tenue ? tenue.split(" ")[0] : "sensuelle");
      const d = await api("POST", "/api/generate/image", {
        style, prompt, seed: Math.floor(Math.random() * 999999999),
        companionId: activeCompId,
        ext: activeComp ? activeComp.profile : getCurrentExt()
      });
      if (d.ok && d.url) {
        addMsg("assistant", `📸 ${prompt}`, d.url, "image/png");
        if ($("galleryPanel") && $("galleryPanel").open) loadGallery();
      } else throw new Error(d.error || "Échec génération");
    }
    showToast("✨ Généré !", "success");
  } catch (e) {
    showToast("❌ " + e.message, "error");
  }
}

// ── GALERIE ───────────────────────────────────────────────────
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
      img.src = p.filename; img.loading = "lazy";
      img.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;display:block;cursor:pointer;border:2px solid transparent;transition:border-color .15s";
      img.onmouseover = () => { img.style.borderColor = "#ff3f91"; };
      img.onmouseout  = () => { img.style.borderColor = "transparent"; };
      img.onclick = () => openPhotoFull(p.filename);
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "💾"; saveBtn.title = "Définir comme avatar";
      saveBtn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.75);border:none;color:#fff;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:13px";
      saveBtn.onclick = async (e) => { e.stopPropagation(); await saveAsAvatar(p.filename); closeAvatarModal(); };
      cell.appendChild(img); cell.appendChild(saveBtn); panel.appendChild(cell);
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
  img.src = url; img.style.cssText = "max-width:95vw;max-height:95vh;border-radius:12px";
  overlay.appendChild(img); document.body.appendChild(overlay);
}

// ── STYLES TENUES v11 — 80+ tenues filtrées par genre ─────────
const STYLES_PAR_GENRE = {
  commun: [
    { id:"portrait",       emoji:"🎭", label:"Portrait"         },
    { id:"portrait_sourire",emoji:"😊", label:"Sourire"         },
    { id:"casual",         emoji:"👗", label:"Casual"           },
    { id:"sport",          emoji:"🏋️", label:"Sport / Fitness"  },
    { id:"outdoor",        emoji:"🌿", label:"Outdoor / Nature"  },
    { id:"plage",          emoji:"🏖️", label:"Plage"            },
    { id:"bain",           emoji:"🛁", label:"Bain / Douche"    },
    { id:"cosplay",        emoji:"🎮", label:"Cosplay"          },
    { id:"fantasy",        emoji:"🧝", label:"Fantasy"          },
    { id:"uniforme_medecin",emoji:"🩺",label:"Médecin"          },
    { id:"uniforme_police", emoji:"👮",label:"Police"           },
    { id:"uniforme_maitresse",emoji:"🎓",label:"Professeure"   },
  ],
  femme: [
    { id:"lingerie_noir",   emoji:"🖤", label:"Lingerie noire"  },
    { id:"lingerie_rouge",  emoji:"❤️", label:"Lingerie rouge"  },
    { id:"lingerie_blanc",  emoji:"🤍", label:"Lingerie blanche"},
    { id:"lingerie_latex",  emoji:"⚡", label:"Latex"           },
    { id:"string",          emoji:"🔥", label:"String seul"     },
    { id:"body",            emoji:"💃", label:"Body"            },
    { id:"bustier",         emoji:"✨", label:"Bustier"         },
    { id:"corset",          emoji:"🎀", label:"Corset"          },
    { id:"robe_soiree",     emoji:"💎", label:"Robe de soirée"  },
    { id:"robe_courte",     emoji:"🌸", label:"Mini-robe"       },
    { id:"bikini",          emoji:"👙", label:"Bikini"          },
    { id:"monokini",        emoji:"🌊", label:"Monokini"        },
    { id:"nuisette",        emoji:"🌙", label:"Nuisette"        },
    { id:"pyjama_sexy",     emoji:"😴", label:"Pyjama sexy"     },
    { id:"chemise_homme",   emoji:"👔", label:"Chemise homme"   },
    { id:"cuir_veste",      emoji:"🖤", label:"Cuir / Veste"    },
    { id:"dominatrice",     emoji:"👑", label:"Dominatrice"     },
    { id:"maitresse",       emoji:"⛓️", label:"Maîtresse BDSM"  },
    { id:"soumise",         emoji:"🙇", label:"Soumise"         },
    { id:"bondage",         emoji:"🔗", label:"Bondage"         },
    { id:"harnais",         emoji:"⛓️", label:"Harnais"         },
    { id:"collant_resille", emoji:"🕷️", label:"Résille"         },
    { id:"talons_nus",      emoji:"👠", label:"Nue + talons"    },
    { id:"nue",             emoji:"🔥", label:"Nue"             },
    { id:"selfie_lit",      emoji:"🛏️", label:"Au lit"          },
    { id:"buste_nu",        emoji:"🌸", label:"Buste nu"        },
    { id:"yoga",            emoji:"🧘", label:"Yoga"            },
    { id:"cheerleader",     emoji:"📣", label:"Cheerleader"     },
    { id:"nurse",           emoji:"💉", label:"Infirmière"      },
    { id:"servante",        emoji:"🎀", label:"Servante"        },
    { id:"gothique",        emoji:"🕯️", label:"Gothique"        },
    { id:"pin_up",          emoji:"💋", label:"Pin-up"          },
    { id:"lolita",          emoji:"🎀", label:"Lolita"          },
    { id:"kimono",          emoji:"🌸", label:"Kimono"          },
    { id:"lingerie_garter",emoji:"🎀",  label:"Porte-jarretelles"},
  ],
  homme: [
    { id:"costume",        emoji:"🤵", label:"Costume"          },
    { id:"chemise_ouverte",emoji:"👔", label:"Chemise ouverte"  },
    { id:"jean_casual",    emoji:"👖", label:"Jean casual"      },
    { id:"boxers",         emoji:"🩲", label:"Boxer seul"       },
    { id:"nu_masculin",    emoji:"🔥", label:"Nu"               },
    { id:"sport_masc",     emoji:"🏋️", label:"Sport / Gym"     },
    { id:"militaire",      emoji:"🎖️", label:"Militaire"       },
    { id:"motard",         emoji:"🏍️", label:"Motard"          },
    { id:"cuir_masc",      emoji:"🖤", label:"Cuir"             },
    { id:"dom_masc",       emoji:"👊", label:"Dominant"         },
    { id:"sous_masc",      emoji:"🙇", label:"Soumis"           },
    { id:"bondage_masc",   emoji:"🔗", label:"Bondage masc."    },
    { id:"latex_masc",     emoji:"⚡", label:"Latex"            },
    { id:"harness_masc",   emoji:"⛓️", label:"Harnais"          },
    { id:"peignoir",       emoji:"🛁", label:"Peignoir"         },
    { id:"nu_lit",         emoji:"🛏️", label:"Nu au lit"        },
  ],
  trans: [
    { id:"lingerie_trans",   emoji:"🌈", label:"Lingerie trans"  },
    { id:"robe_trans",       emoji:"🌈", label:"Robe"            },
    { id:"sport_trans",      emoji:"🏋️", label:"Sport"           },
    { id:"casual_trans",     emoji:"👗", label:"Casual"           },
    { id:"dom_trans",        emoji:"👑", label:"Dominant(e)"     },
    { id:"sub_trans",        emoji:"🙇", label:"Soumis(e)"       },
    { id:"nu_trans",         emoji:"🔥", label:"Nu(e)"           },
    { id:"harnais_trans",    emoji:"⛓️", label:"Harnais"         },
    { id:"latex_trans",      emoji:"⚡", label:"Latex"           },
    { id:"kimono_trans",     emoji:"🌸", label:"Kimono"          },
  ],
  nonbinaire: [
    { id:"androgyne_casual",emoji:"🌈", label:"Androgyne casual" },
    { id:"androgyne_elegance",emoji:"✨",label:"Élégance"         },
    { id:"kawaii",          emoji:"🎀", label:"Kawaii"           },
    { id:"dark_nb",         emoji:"🖤", label:"Dark / Gothique"  },
    { id:"nu_nb",           emoji:"🔥", label:"Nu(e)"            },
    { id:"sport_nb",        emoji:"🏋️", label:"Sport"           },
    { id:"dom_nb",          emoji:"👑", label:"Dominant(e)"      },
    { id:"latex_nb",        emoji:"⚡", label:"Latex"            },
  ]
};

const STYLES_FALLBACK = [
  ...STYLES_PAR_GENRE.commun,
  ...STYLES_PAR_GENRE.femme.slice(0, 10)
];

async function loadStyles() {
  const grid = $("stylesGrid");
  if (!grid) return;

  const genre = ($("sGenre")?.value || "femme").toLowerCase();
  let styles = [...STYLES_PAR_GENRE.commun];

  if (genre.includes("trans") || genre.includes("non-binaire") || genre.includes("fluide")) {
    if (genre.includes("non-binaire") || genre.includes("fluide")) {
      styles = [...styles, ...STYLES_PAR_GENRE.nonbinaire];
    } else {
      styles = [...styles, ...STYLES_PAR_GENRE.trans];
      // Ajouter selon genre trans
      if (genre.includes("femme trans")) styles = [...styles, ...STYLES_PAR_GENRE.femme];
      if (genre.includes("homme trans")) styles = [...styles, ...STYLES_PAR_GENRE.homme];
    }
  } else if (genre === "homme" || genre === "homme cisgenre") {
    styles = [...styles, ...STYLES_PAR_GENRE.homme];
  } else {
    styles = [...styles, ...STYLES_PAR_GENRE.femme];
  }

  function renderStyles(stylesArr) {
    grid.innerHTML = "";
    stylesArr.forEach(s => {
      const btn = document.createElement("button");
      btn.className = "style-btn";
      btn.style.cssText = "background:#1e1b2e;border:1px solid #ff3f91;border-radius:12px;padding:10px 6px;cursor:pointer;color:#fff;text-align:center;transition:.2s;min-width:70px";
      btn.innerHTML = `<div style="font-size:24px">${esc(s.emoji)}</div><div style="font-size:11px;margin-top:3px;color:#ddd;word-break:break-word">${esc(s.label)}</div>`;
      btn.onclick = () => { generateAIAvatar(s.id); closeAvatarModal(); };
      grid.appendChild(btn);
    });
  }

  renderStyles(styles);

  try {
    const d = await api("GET", "/api/generate/styles");
    if (d.ok && d.styles?.length) renderStyles(d.styles);
  } catch {
    console.info("[loadStyles] API indisponible, styles locaux utilisés");
  }
}

// ── GALERIE OVERLAY ───────────────────────────────────────────
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
  header.appendChild(h2); header.appendChild(closeBtn); ov.appendChild(header);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:6px";
  d.photos.forEach(p => {
    const cell = document.createElement("div");
    cell.style.cssText = "position:relative;cursor:pointer;border-radius:8px;overflow:hidden";
    const img = document.createElement("img");
    img.src = p.filename; img.loading = "lazy";
    img.style.cssText = "width:100%;aspect-ratio:1;object-fit:cover;display:block;border:2px solid transparent;transition:border-color .15s";
    img.onmouseover = () => { img.style.borderColor = "#ff3f91"; };
    img.onmouseout  = () => { img.style.borderColor = "transparent"; };
    img.onclick = () => openPhotoFull(p.filename);
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾"; saveBtn.title = "Définir comme avatar";
    saveBtn.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.75);border:none;color:#fff;border-radius:6px;padding:3px 7px;cursor:pointer;font-size:13px";
    saveBtn.onclick = async (e) => { e.stopPropagation(); await saveAsAvatar(p.filename); ov.remove(); };
    cell.appendChild(img); cell.appendChild(saveBtn); grid.appendChild(cell);
  });
  ov.appendChild(grid); document.body.appendChild(ov);
}

async function saveAsAvatar(url) {
  try {
    await refreshCsrf();
    await fetch("/api/avatar", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ avatar: url })
    });
    if (user) { user.avatarUrl = url; user.personaPhotoUrl = url; }
    if (window.user) { window.user.avatarUrl = url; window.user.personaPhotoUrl = url; }
    updateHeader();
    document.querySelectorAll(".msg-avatar img").forEach(i => { i.src = url; });
    document.querySelectorAll(".msg-avatar").forEach(d => {
      if (!d.querySelector("img")) {
        const img = document.createElement("img");
        img.src = url; img.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover";
        d.textContent = ""; d.appendChild(img);
      }
    });
    showToast("✅ Avatar mis à jour !", "success");
  } catch (e) { showToast("❌ " + e.message, "error"); }
}

async function clearMessages() {
  if (!confirm("Effacer toute la conversation ?")) return;
  const cid = window._activeCompanionId || null;
  await api("DELETE", "/api/messages" + (cid ? "?companionId=" + cid : ""));
  await loadMessages();
  showToast("Conversation effacée", "info");
}

async function clearMemories() {
  if (!confirm("Effacer tous les souvenirs ?")) return;
  await api("DELETE", "/api/memories");
  showToast("Souvenirs effacés", "info");
}

function exportData() { location.href = "/api/export"; }

// ── PROACTIVITÉ ───────────────────────────────────────────────
function scheduleProactive() {
  if (proactiveTimer) clearInterval(proactiveTimer);
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
            prompt: msg.content, style: "realistic",
            seed: Math.floor(Math.random() * 999999999),
            ext: getCurrentExt()
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

// ── PANNEAU ───────────────────────────────────────────────────
function openPanel() {
  if ($("settingsPanel"))   $("settingsPanel").hidden   = false;
  if ($("settingsOverlay")) $("settingsOverlay").hidden = false;
}
function closePanel() {
  if ($("settingsPanel"))   $("settingsPanel").hidden   = true;
  if ($("settingsOverlay")) $("settingsOverlay").hidden = true;
}
function showTab(tabId, btn) {
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".snav-btn").forEach(b => b.classList.remove("active"));
  const t = $(tabId); if (t) t.classList.add("active");
  if (btn) btn.classList.add("active");
}
function scrollNav(dir) {
  const n = $("settingsNav"); if (n) n.scrollBy({ left: dir * 120, behavior: "smooth" });
}
async function saveTTSSettings() {
  try {
    await api("PUT", "/api/profile", { ttsEnabled: $("sTTSEnabled")?.checked || false, ttsSpeed: $("sTTSSpeed")?.value || "1.0" });
  } catch {}
}

// ── SCÉNARIOS v11 — persistants avec 12 types + arcs ─────────
const SCENARIOS_LIB = [
  { id:"retrouvailles",   emoji:"💕", label:"Retrouvailles",    type:"court", context:"Vous ne vous êtes pas vus depuis longtemps. La tension est palpable. Elle arrive enfin." },
  { id:"premiere_nuit",   emoji:"🌙", label:"Première nuit",    type:"long",  context:"C'est la première fois que vous passez la nuit ensemble. Tout est nouveau, électrique." },
  { id:"boss_secretaire", emoji:"💼", label:"Boss & Secrétaire",type:"court", context:"Roleplay bureau : elle est ta secrétaire ambitieuse, tu es son patron exigeant." },
  { id:"vacances",        emoji:"🏖️", label:"Vacances à la mer",type:"long",  context:"Une semaine au soleil, rien à faire sauf profiter. La chaleur délie les corps." },
  { id:"bdsm_contrat",    emoji:"⛓️", label:"Contrat BDSM",    type:"long",  context:"Vous établissez et testez les termes d'un contrat Dom/Sub. Elle joue son rôle." },
  { id:"fantasy_elfe",    emoji:"🧝", label:"Fantasy / Elfe",   type:"long",  context:"Univers fantastique : elle est une elfe mystérieuse rencontrée en forêt la nuit." },
  { id:"medecin",         emoji:"🩺", label:"Médecin / Patient",type:"court", context:"Elle est médecin. Toi le patient nerveux. Une consultation qui dérape doucement." },
  { id:"voisine",         emoji:"🏠", label:"La voisine",       type:"court", context:"Elle frappe à ta porte pour emprunter quelque chose. La conversation s'éternise." },
  { id:"inconnus",        emoji:"🍸", label:"Deux inconnus",    type:"court", context:"Un bar. Vous ne vous connaissez pas. Elle t'aborde. Jeu de séduction pur." },
  { id:"soumission",      emoji:"🙇", label:"Soumission totale",type:"long",  context:"Elle t'appartient pour la nuit. Obéissance absolue à chaque mot que tu prononces." },
  { id:"domination",      emoji:"👑", label:"Domination",       type:"long",  context:"Tu lui appartiens ce soir. Elle dirige. Tu obéis. Sans discussion." },
  { id:"exhib_public",    emoji:"📸", label:"Exhib en public",  type:"court", context:"Lieu semi-public. Elle veut prendre des risques. La peur et l'excitation se mêlent." },
];

function openScenarioMenu()  { const m = $("scenarioModal"); if (m) m.hidden = false; renderScenarioLib(); }
function closeScenarioMenu() { const m = $("scenarioModal"); if (m) m.hidden = true;  }

function renderScenarioLib() {
  const grid = $("scenarioLibGrid");
  if (!grid) return;
  grid.innerHTML = "";
  SCENARIOS_LIB.forEach(s => {
    const btn = document.createElement("button");
    btn.className = "scenario-lib-btn";
    btn.style.cssText = `
      background:${scenarioActive && scenarioContext === s.context ? "linear-gradient(135deg,#ff3f91,#a855f7)" : "#1e1b2e"};
      border:1px solid #ff3f91;border-radius:12px;padding:10px 8px;cursor:pointer;
      color:#fff;text-align:left;display:flex;align-items:flex-start;gap:8px;width:100%;
    `;
    btn.innerHTML = `
      <span style="font-size:22px;flex-shrink:0">${esc(s.emoji)}</span>
      <div>
        <div style="font-size:13px;font-weight:600">${esc(s.label)}</div>
        <div style="font-size:11px;color:#bbb;margin-top:2px">${esc(s.context.slice(0, 70))}…</div>
      </div>
    `;
    btn.onclick = () => activerScenario(s);
    grid.appendChild(btn);
  });
}

async function activerScenario(s) {
  closeScenarioMenu();
  scenarioActive  = true;
  scenarioContext = s.context;
  scenarioType    = s.type;

  // Mettre à jour le badge dans la barre
  const badge = $("scenarioBadge");
  if (badge) { badge.textContent = `🎬 ${s.label}`; badge.hidden = false; }

  const input = $("msgInput");
  if (input) {
    input.value = `[SCENARIO:${s.type}] ${s.context} — Commence directement in media res, je suis là, tu n'attends pas. Reste TOUJOURS dans ce personnage et ce contexte jusqu'à ce que je dise STOP.`;
    await sendMsg();
  }
}

async function startScenario(type) {
  closeScenarioMenu();
  scenarioActive  = true;
  scenarioContext = type === "court"
    ? "Scène courte et intense. Tu improvises une situation basée sur mon profil."
    : "Histoire longue. Chapitre 1 : tension et mise en place. Tu n'en sors jamais.";
  scenarioType    = type;

  const badge = $("scenarioBadge");
  if (badge) { badge.textContent = type === "court" ? "🎬 Scène courte" : "📖 Histoire longue"; badge.hidden = false; }

  const input = $("msgInput");
  if (input) {
    input.value = type === "court"
      ? "[SCENARIO:court] Lance une scène courte et intense basée sur mon profil. Commence directement in media res. Reste dans ce contexte jusqu'à ce que je dise STOP."
      : "[SCENARIO:long] Lance une histoire longue. Chapitre 1 : tension et mise en place. N'en sors jamais sans que je dise STOP.";
    await sendMsg();
  }
}

function stopScenario() {
  scenarioActive  = false;
  scenarioContext = "";
  scenarioType    = "";
  const badge = $("scenarioBadge");
  if (badge) badge.hidden = true;
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
    if (os) os.hidden = true; if (as) as.hidden = false; updateHeader();
  }
}
function onbBack() {
  const s0 = $("onbStep0"), sf = $("onbStepForm"), sp = $("onbStepPreset");
  if (sf) sf.hidden = true; if (sp) sp.hidden = true; if (s0) s0.hidden = false;
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
    if (os) os.hidden = true; if (as) as.hidden = false;
    updateHeader(); showToast("✅ Profil créé !", "success");
  } catch (e) { const er = $("onbError"); if (er) er.textContent = e.message; }
}
async function onbApplyPreset(key) {
  const P = {
    girlfriend: { aiName:"Élise",         preferredPersona:"girlfriend",    caractere:"Douce, romantique, câline",        niveau_intensite:"4", curseur_douceur:"8", curseur_romantisme:"8", curseur_crudite:"4", curseur_domination:"3" },
    domina:     { aiName:"Maîtresse Nyx", preferredPersona:"dom_hard",      caractere:"Autoritaire, cruelle, implacable", niveau_intensite:"9", curseur_crudite:"9", curseur_domination:"10", curseur_humiliation:"8" },
    libertine:  { aiName:"Luna",          preferredPersona:"hedoniste",     caractere:"Libre, décomplexée, sans tabou",   niveau_intensite:"10", curseur_crudite:"10", curseur_initiative:"9" },
    confidente: { aiName:"Sophie",        preferredPersona:"adult_intimate",caractere:"Empathique, douce, complice",      niveau_intensite:"5", curseur_douceur:"9" }
  };
  const p = P[key]; if (!p) return;
  try {
    const { aiName, preferredPersona, ...ext } = p;
    await api("PUT", "/api/profile", { aiName, preferredPersona });
    await api("PUT", "/api/profile/extended", ext);
    if (window.user) { window.user.aiName = aiName; window.user.preferredPersona = preferredPersona; }
    const os = $("onboardingScreen"), as = $("appScreen");
    if (os) os.hidden = true; if (as) as.hidden = false;
    updateHeader(); showToast(`✅ "${aiName}" appliqué !`, "success");
  } catch (e) { const er = $("onbError"); if (er) er.textContent = e.message; }
}

async function generateAndSaveImage(prompt, style, seed) {
  const tok = localStorage.getItem("csrf") || "";
  const r = await fetch("/api/generate/image", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": tok },
    body: JSON.stringify({ prompt, style, seed: seed || Math.floor(Math.random() * 999999999), ext: getCurrentExt() })
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
  const loginTab = $("loginTab"), registerTab = $("registerTab");
  if (loginTab)    loginTab.onclick    = () => setAuthMode("login");
  if (registerTab) registerTab.onclick = () => setAuthMode("register");
  const msgInput = $("msgInput");
  if (msgInput) {
    msgInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
    msgInput.addEventListener("input",   () => autoGrow(msgInput));
  }
  // Auto-sync curseurs quand persona change
  const personaSel = $("sPersona");
  if (personaSel) {
    personaSel.addEventListener("change", () => {
      if (confirm(`Synchroniser les curseurs avec "${personaSel.value}" ?`)) {
        syncCurseursParPersona(personaSel.value);
      }
    });
  }
  checkSession();
});

// ── EXPORTS GLOBAUX ───────────────────────────────────────────
Object.assign(window, {
  openPhotoFull,
  openPanel, closePanel, showTab, scrollNav,
  saveTTSSettings, selectFromGallery, saveAsAvatar,
  openPhotoSelector, openScenarioMenu, closeScenarioMenu,
  startScenario, stopScenario, activerScenario,
  onbChoose, onbBack, onbSaveForm, onbApplyPreset,
  saveAll, sendMsg,
  toggleTTSGlobal, toggleWebcam, stopWebcam, toggleMic,
  handleMedia, cancelMedia,
  openAvatarModal, closeAvatarModal,
  generateAIAvatar, generateSelfie, generateAnimatedAvatar,
  generateVideoChatContext,
  uploadManualAvatar,
  loadGallery, loadStyles, openPhotoFull,
  clearMessages, clearMemories, exportData, logout,
  updateAdultUI, autoGrow, setAuthMode, submitAuth,
  generateAndSaveImage, getCurrentExt,
  syncCurseursParPersona,
  openGenRapide, closeGenRapide, lancerGenRapide,
  // Note: toggleAnatomieLibre, loadMemoriesTab, addMemoryManual
  // sont définis dans le <script> inline de mobile.html → déjà globaux
});

// ══ MULTI-COMPAGNONS v12 ══════════════════════════════════════

// Compagnon actif courant (null = profil principal)
window._activeCompanionId   = null;
window._activeCompanionName = null;
window._companions = [];

// Charger la liste des compagnons
async function loadCompanions() {
  try {
    const d = await api("GET", "/api/companions/preview");
    if (!d.ok) return;
    window._companions = d.companions || [];
    renderCompanionBar();
  } catch(e) { console.warn("[companions]", e.message); }
}

// Changer de compagnon actif
async function switchCompanion(companionId, companionName) {
  window._activeCompanionId   = companionId;
  window._activeCompanionName = companionName;
  // Mettre à jour le header
  if ($("aiNameDisplay")) $("aiNameDisplay").textContent = companionName || user?.aiName || "Élissia";
  // ✅ Vider le badge du compagnon qu'on vient d'ouvrir
  if (window._companions) {
    window._companions = window._companions.map(c =>
      c.id === companionId ? {...c, messageCount: 0} : c
    );
  }
  // Recharger les messages de ce compagnon
  const cid = companionId;
  const data = await api("GET", "/api/state" + (cid ? "?companionId=" + cid : ""));
  user = { ...user, ...data.user };
  const el = $("chatMessages");
  if (!el) return;
  el.innerHTML = "";
  if (!data.messages?.length) {
    addMsg("assistant", `Coucou 💗 Je suis ${companionName}. Dis-moi tout !`);
    return;
  }
  data.messages.forEach(m => {
    const entry = addMsg(m.role, m.content, m.mediaUrl, m.mediaType);
    if (entry?.wrap && m.id) entry.wrap.dataset.msgId = m.id;
  });
  // Mettre à jour la barre compagnons
  renderCompanionBar();
  showToast(`💬 ${companionName}`, "info");
}

// Afficher la barre de sélection compagnons
function renderCompanionBar() {
  let bar = $("companionBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "companionBar";
    bar.style.cssText = "display:flex;gap:8px;padding:8px 12px;overflow-x:auto;background:#0f0d1a;border-bottom:1px solid rgba(255,63,145,.2);scroll-behavior:smooth;-webkit-overflow-scrolling:touch";
    const chatMessages = $("chatMessages");
    if (chatMessages?.parentNode) chatMessages.parentNode.insertBefore(bar, chatMessages);
  }
  bar.innerHTML = "";

  // Bouton "principal" (pas de compagnon)
  const mainBtn = document.createElement("button");
  mainBtn.style.cssText = `flex-shrink:0;background:${!window._activeCompanionId ? "linear-gradient(135deg,#ff3f91,#a855f7)" : "#1e1b2e"};border:1px solid #ff3f91;border-radius:24px;padding:4px 12px 4px 8px;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap`;
  const mainAvatar = user?.avatarUrl ? `<img src="${user.avatarUrl}" style="width:24px;height:24px;border-radius:50%;object-fit:cover">` : "💗";
  mainBtn.innerHTML = `${mainAvatar} ${user?.aiName || "Élissia"}`;
  mainBtn.onclick = () => switchCompanion(null, user?.aiName || "Élissia");
  bar.appendChild(mainBtn);

  // Boutons compagnons
  for (const c of (window._companions || [])) {
    const btn = document.createElement("button");
    const isActive = window._activeCompanionId === c.id;
    btn.style.cssText = `flex-shrink:0;background:${isActive ? "linear-gradient(135deg,#ff3f91,#a855f7)" : "#1e1b2e"};border:1px solid ${isActive ? "#ff3f91" : "#444"};border-radius:24px;padding:4px 12px 4px 8px;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap`;
    const ava = c.avatarUrl ? `<img src="${c.avatarUrl}" style="width:24px;height:24px;border-radius:50%;object-fit:cover">` : "💕";
    btn.innerHTML = `${ava} ${c.name}`;
    btn.onclick = () => switchCompanion(c.id, c.name);
    // ✅ Badge seulement si pas le compagnon actif
    if (c.messageCount > 0 && window._activeCompanionId !== c.id) {
      const badge = document.createElement("span");
      badge.style.cssText = "background:#ff3f91;color:#fff;border-radius:10px;padding:1px 5px;font-size:10px;margin-left:2px;flex-shrink:0";
      badge.textContent = c.messageCount > 99 ? "99+" : c.messageCount;
      btn.appendChild(badge);
    }
    // ✎ Bouton modifier
    const editBtn = document.createElement("button");
    editBtn.style.cssText = "background:rgba(255,255,255,.1);border:none;border-radius:50%;width:20px;height:20px;margin-left:2px;cursor:pointer;color:#aaa;font-size:10px;padding:0;flex-shrink:0;display:flex;align-items:center;justify-content:center";
    editBtn.textContent = "✎";
    editBtn.title = "Modifier " + c.name;
    editBtn.onclick = (ev) => { ev.stopPropagation(); openNewCompanionModal(c); };
    const wrap = document.createElement("div");
    wrap.style.cssText = "flex-shrink:0;display:flex;align-items:center";
    wrap.appendChild(btn);
    wrap.appendChild(editBtn);
    bar.appendChild(wrap);
  }

  // Bouton + ajouter compagnon
  const addBtn = document.createElement("button");
  addBtn.style.cssText = "flex-shrink:0;background:#1e1b2e;border:1px dashed #555;border-radius:24px;padding:4px 12px;color:#888;font-size:12px;cursor:pointer;white-space:nowrap";
  addBtn.textContent = "+ Compagnon";
  addBtn.onclick = () => openNewCompanionModal();
  bar.appendChild(addBtn);

  // Bouton multi-chat si ≥2 compagnons
  if ((window._companions || []).length >= 2) {
    const multiBtn = document.createElement("button");
    multiBtn.style.cssText = "flex-shrink:0;background:linear-gradient(135deg,#1e1b2e,#2a1040);border:1px solid #a855f7;border-radius:24px;padding:4px 12px;color:#a855f7;font-size:12px;cursor:pointer;white-space:nowrap";
    multiBtn.textContent = "🎭 Multi-chat";
    multiBtn.onclick = () => openMultiChatModal();
    bar.appendChild(multiBtn);
  }
}

// Modal création nouveau compagnon
function openNewCompanionModal() {
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px";
  ov.innerHTML = `
    <div style="background:#13111e;border:1px solid #ff3f91;border-radius:20px;padding:20px;width:100%;max-width:380px;max-height:90vh;overflow-y:auto">
      <h3 style="color:#ff3f91;margin:0 0 16px">✨ Nouveau compagnon</h3>
      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Prénom</label>
      <input id="newCompName" placeholder="Élise, Nyx, Marco..." style="width:100%;background:#1e1b2e;border:1px solid #ff3f91;border-radius:10px;padding:8px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Genre</label>
      <select id="newCompGenre" style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;margin-bottom:12px">
        <option value="femme">Femme cisgenre</option>
        <option value="homme">Homme cisgenre</option>
        <option value="femme trans">Femme trans</option>
        <option value="homme trans">Homme trans</option>
        <option value="non-binaire">Non-binaire</option>
        <option value="fluide">Genre fluide</option>
      </select>
      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Persona</label>
      <select id="newCompPersona" style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;margin-bottom:12px">
        <option value="girlfriend">Petite amie tendre</option>
        <option value="dom_hard">Dominatrice HARD</option>
        <option value="dom_soft">Dominatrice douce</option>
        <option value="sub_hard">Soumis-e HARD</option>
        <option value="adult_intimate">Intime adulte</option>
        <option value="hedoniste">Hédoniste</option>
        <option value="bdsm_complet">BDSM complet</option>
        <option value="boyfriend">Petit ami</option>
        <option value="homme_dom">Dominant masculin</option>
        <option value="trans_femme">Trans femme</option>
        <option value="trans_masc">Trans masc</option>
        <option value="non_binaire">Non-binaire</option>
        <option value="bisexuel">Bisexuel-le</option>
        <option value="libertin">Libertin-e</option>
      </select>
      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Caractère (quelques mots)</label>
      <input id="newCompCaractere" placeholder="Douce, joueur, autoritaire..." style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;margin-bottom:12px;box-sizing:border-box">
      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Âge</label>
      <input id="newCompAge" type="number" value="25" min="18" max="65" style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;margin-bottom:16px;box-sizing:border-box">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button onclick="this.closest('div[style]').parentElement.remove()" style="background:#1e1b2e;border:1px solid #555;border-radius:12px;padding:10px;color:#aaa;cursor:pointer">Annuler</button>
        <button onclick="saveNewCompanion()" style="background:linear-gradient(135deg,#ff3f91,#a855f7);border:none;border-radius:12px;padding:10px;color:#fff;font-weight:700;cursor:pointer">Créer ✨</button>
      </div>
      <p id="newCompError" style="color:#e55;font-size:12px;margin-top:8px;text-align:center"></p>
    </div>
  `;
  document.body.appendChild(ov);
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
}

async function saveNewCompanion() {
  const name = $("newCompName")?.value?.trim();
  if (!name) { if ($("newCompError")) $("newCompError").textContent = "Prénom obligatoire"; return; }
  try {
    const d = await api("POST", "/api/companions", {
      name,
      persona: $("newCompPersona")?.value || "girlfriend",
      profile: {
        genre: $("newCompGenre")?.value || "femme",
        age: $("newCompAge")?.value || "25",
        caractere: $("newCompCaractere")?.value || ""
      }
    });
    if (!d.ok) throw new Error(d.error || "Erreur");
    document.getElementById("multiChatOv")?.remove(); document.querySelector("div[style*='inset:0']")?.remove();
    await loadCompanions();
    await switchCompanion(d.id, name);
    showToast(`✨ ${name} créé-e !`, "success");
  } catch(e) { if ($("newCompError")) $("newCompError").textContent = e.message; }
}

// Modal multi-chat
// ✅ v13 — Modal multi-chat complet avec bouton vidéo de scène
function openMultiChatModal() {
  const comps = window._companions || [];
  if (!comps.length) { showToast("Aucun compagnon — crée-en un d'abord", "info"); return; }
  const ov = document.createElement("div");
  ov.id = "multiChatOv";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto";

  const checkboxesHtml = comps.map(c => `
    <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#1e1b2e;border-radius:12px;cursor:pointer;border:1px solid #333;transition:border-color .2s" onmouseenter="this.style.borderColor='#a855f7'" onmouseleave="this.style.borderColor='#333'">
      <input type="checkbox" value="${c.id}" data-name="${c.name}" style="width:18px;height:18px;accent-color:#ff3f91;flex-shrink:0">
      ${c.avatarUrl ? `<img src="${c.avatarUrl}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0">` : '<span style="font-size:20px">💕</span>'}
      <div style="flex:1;min-width:0">
        <div style="color:#fff;font-size:14px;font-weight:600">${c.name}</div>
        <div style="color:#888;font-size:11px">${c.persona}</div>
      </div>
    </label>
  `).join("");

  ov.innerHTML = `
    <div style="background:#13111e;border:1px solid #a855f7;border-radius:20px;padding:20px;width:100%;max-width:420px;max-height:92vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="color:#a855f7;margin:0;font-size:18px">🎭 Multi-chat</h3>
        <button onclick="document.getElementById('multiChatOv')?.remove()" style="background:none;border:none;color:#888;font-size:24px;cursor:pointer;padding:0">✕</button>
      </div>
      <p style="color:#888;font-size:12px;margin:0 0 12px">Sélectionne les compagnons qui participent à la scène.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${checkboxesHtml}</div>

      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Contexte de scène (optionnel)</label>
      <textarea id="multiScenarioCtx" rows="4" placeholder="Ex: Nyx entre dans la pièce où Marco l'attend à genoux, nu. Elle porte sa combinaison latex..." style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;box-sizing:border-box;resize:none;margin-bottom:12px;font-size:13px"></textarea>

      <label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">Message d'amorce (optionnel)</label>
      <input id="multiMsgInput" placeholder="Laisser vide pour un message automatique..." style="width:100%;background:#1e1b2e;border:1px solid #555;border-radius:10px;padding:8px;color:#fff;margin-bottom:14px;box-sizing:border-box;font-size:13px">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <button onclick="document.getElementById('multiChatOv')?.remove()" style="background:#1e1b2e;border:1px solid #555;border-radius:12px;padding:10px;color:#aaa;cursor:pointer;font-size:14px">Annuler</button>
        <button onclick="startMultiChat()" style="background:linear-gradient(135deg,#a855f7,#ff3f91);border:none;border-radius:12px;padding:10px;color:#fff;font-weight:700;cursor:pointer;font-size:14px">Lancer 🎭</button>
      </div>

      <!-- Bouton vidéo de scène -->
      <div style="background:#1a1530;border:1px solid rgba(168,85,247,.3);border-radius:14px;padding:12px">
        <p style="font-size:12px;color:#a855f7;font-weight:700;margin:0 0 4px">🎬 Générer une vidéo de cette scène</p>
        <p style="font-size:11px;color:#888;margin:0 0 10px">Perplexity construit le prompt → ComfyUI génère les frames → FFmpeg assemble le MP4</p>
        <button onclick="launchSceneVideo()" style="width:100%;background:linear-gradient(135deg,#2a1040,#1a1530);border:1px solid #a855f7;border-radius:10px;padding:8px;color:#a855f7;font-size:13px;cursor:pointer;font-weight:600">🎬 Générer la vidéo</button>
        <p id="multiChatVideoStatus" style="font-size:11px;color:#a855f7;text-align:center;margin:6px 0 0;min-height:16px"></p>
      </div>
    </div>
  `;
  document.body.appendChild(ov);
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
}

async function startMultiChat() {
  const checked = Array.from(document.querySelectorAll('#multiChatModal input[type=checkbox]:checked, div[style*="inset:0"] input[type=checkbox]:checked'));
  const companionIds   = checked.map(c => c.value);
  const companionNames = checked.map(c => c.dataset.name);
  if (companionIds.length < 1) { showToast("Sélectionne au moins un compagnon", "info"); return; }
  const scenarioContext = $("multiScenarioCtx")?.value || "";
  // ✅ Sauvegarder pour le bouton vidéo de scène
  window._lastMultiChatIds = companionIds;
  window._lastMultiChatContext = scenarioContext;
  const message = document.getElementById("multiMsgInput")?.value?.trim() || $("msgInput")?.value?.trim() || "Bonsoir à tous 😊";

  document.querySelector("div[style*='inset:0']")?.remove();

  const input = $("msgInput"); if (input) { input.value = ""; autoGrow(input); }
  addMsg("user", message);
  showToast(`🎭 ${companionNames.join(", ")} en train de répondre...`, "info");

  try {
    await refreshCsrf();
    const r = await fetch("/api/multi-chat", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ message, companionIds, scenarioContext })
    });
    if (!r.ok) throw new Error("Erreur serveur");

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    // Bulles temporaires pour chaque compagnon
    const bubbles = {};

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "companion_start") {
          // Créer une bulle pour ce compagnon
          const comp = (window._companions || []).find(c => c.id === ev.companionId);
          const entry = addMsg("assistant", "");
          if (entry) {
            // Ajouter l'en-tête compagnon
            const nameTag = document.createElement("div");
            nameTag.style.cssText = "font-size:11px;color:#ff3f91;font-weight:700;margin-bottom:4px";
            nameTag.textContent = ev.companionName;
            entry.bubble.parentNode.insertBefore(nameTag, entry.bubble);
            bubbles[ev.companionId] = entry.bubble;
          }
        }
        if (ev.type === "token" && bubbles[ev.companionId]) {
          bubbles[ev.companionId].textContent = (bubbles[ev.companionId].textContent || "") + ev.token;
          $("chatMessages")?.scrollTo(0, $("chatMessages")?.scrollHeight);
        }
        if (ev.type === "companion_done" && bubbles[ev.companionId]) {
          bubbles[ev.companionId].innerHTML = esc(ev.reply || "");
        }
      }
    }
    showToast("🎭 Scène terminée", "success");
  } catch(e) { showToast("❌ " + e.message, "error"); }
}

// Ajouter au startApp
const _origStartApp = window.startApp;
Object.assign(window, {
  loadCompanions, switchCompanion, renderCompanionBar,
  openNewCompanionModal, saveNewCompanion,
  openMultiChatModal, startMultiChat
});

// Surcharger startApp pour charger les compagnons au démarrage
document.addEventListener("DOMContentLoaded", () => {
  const origCheckSession = window.checkSession;
});// ✅ v13 — Modal compagnon COMPLET — parité totale avec le profil principal
function openNewCompanionModal(editCompanion) {
  const isEdit = !!editCompanion;
  const p = editCompanion?.profile || {};

  const ov = document.createElement("div");
  ov.id = "newCompModalOv";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:9000;overflow-y:auto;-webkit-overflow-scrolling:touch";

  const f = (id,val) => `<input id="${id}" value="${(val||"").replace(/"/g,"&quot;")}" style="width:100%;background:#1e1b2e;border:1px solid #333;border-radius:10px;padding:8px;color:#fff;margin-bottom:10px;box-sizing:border-box;font-size:14px">`;
  const ft = (id,ph,val) => `<input id="${id}" placeholder="${ph}" value="${(val||"").replace(/"/g,"&quot;")}" style="width:100%;background:#1e1b2e;border:1px solid #333;border-radius:10px;padding:8px;color:#fff;margin-bottom:10px;box-sizing:border-box;font-size:14px">`;
  const fn = (id,val,min,max) => `<input id="${id}" type="number" value="${val||25}" min="${min||18}" max="${max||99}" style="width:100%;background:#1e1b2e;border:1px solid #333;border-radius:10px;padding:8px;color:#fff;margin-bottom:10px;box-sizing:border-box;font-size:14px">`;
  const lbl = t => `<label style="font-size:12px;color:#aaa;display:block;margin-bottom:4px">${t}</label>`;
  const sec = (ico,t) => `<p style="font-size:11px;font-weight:700;color:#ff3f91;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px;padding-bottom:6px;border-bottom:1px solid rgba(255,63,145,.25)">${ico} ${t}</p>`;
  const sel = (id, opts, val) => {
    const optsHtml = opts.map(([v,l]) => `<option value="${v}"${v===(val||"")?" selected":""}>${l}</option>`).join("");
    return `<select id="${id}" style="width:100%;background:#1e1b2e;border:1px solid #333;border-radius:10px;padding:8px;color:#fff;margin-bottom:10px;font-size:14px">${optsHtml}</select>`;
  };
  const range = (id,val,min,max,step) => `<input id="${id}" type="range" min="${min}" max="${max}" step="${step||1}" value="${val||5}" style="width:100%;margin-bottom:10px;accent-color:#ff3f91">`;
  const g2 = (a,b) => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${a}${b}</div>`;

  ov.innerHTML = `
  <div style="background:#13111e;border:1px solid #ff3f91;border-radius:20px;padding:20px;width:100%;max-width:440px;margin:20px auto;box-sizing:border-box">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h3 style="color:#ff3f91;margin:0;font-size:18px">${isEdit?"✏️ Modifier":"✨ Nouveau"} compagnon</h3>
      <button onclick="document.getElementById('newCompModalOv')?.remove()" style="background:none;border:none;color:#888;font-size:26px;cursor:pointer;line-height:1;padding:0">✕</button>
    </div>

    ${sec("🪪","Identité")}
    ${lbl("Prénom *")}${ft("ncName","Élise, Nyx, Marco...",isEdit?editCompanion.name:"")}
    ${g2(
      lbl("Genre")+sel("ncGenre",[
        ["femme","Femme cisgenre"],["homme","Homme cisgenre"],
        ["femme trans","Femme trans"],["homme trans","Homme trans"],
        ["non-binaire","Non-binaire"],["fluide","Genre fluide"],
        ["intersexe","Intersexe"]
      ],p.genre||"femme"),
      lbl("Âge")+fn("ncAge",p.age||"25",18,99)
    )}
    ${lbl("Origine / Ethnicité")}${ft("ncOrigine","Française, Japonaise, Brésilienne...",p.origine)}
    ${lbl("Persona / Rôle")}${sel("ncPersona",[
      ["girlfriend","Petite amie tendre 💕"],["boyfriend","Petit ami 💙"],
      ["dom_hard","Dominatrice HARD 🔥"],["dom_soft","Dominatrice douce 🌸"],
      ["homme_dom","Dominant masculin 💪"],["sub_hard","Soumis-e HARD 🔗"],
      ["sub_soft","Soumis-e doux-ce 🌹"],["adult_intimate","Intime adulte 🌙"],
      ["hedoniste","Hédoniste ✨"],["bdsm_complet","BDSM complet ⛓️"],
      ["trans_femme","Trans femme 🦋"],["trans_masc","Trans masculin 🦅"],
      ["non_binaire","Non-binaire 🌈"],["bisexuel","Bisexuel-le 💜"],
      ["libertin","Libertin-e 🎭"],["romantique","Romantique pur-e 🌹"],
      ["asexuel_romantique","Asexuel romantique 🤍"]
    ],isEdit?editCompanion.persona:"girlfriend")}
    ${lbl("Caractère (traits clés)")}${ft("ncCaractere","Autoritaire, douce, joueur...",p.caractere)}
    ${lbl("Passions & hobbies")}${ft("ncPassions","Musique, yoga, moto...",p.passions)}
    ${lbl("Profession")}${ft("ncProfession","Médecin, artiste, avocate...",p.profession)}

    ${sec("📐","Silhouette")}
    ${g2(
      lbl("Corpulence")+sel("ncCorpulence",[
        ["mince","Mince"],["élancée","Élancée / longiligne"],
        ["athlétique","Athlétique"],["musclée","Musclée / fitness"],
        ["pulpeuse","Pulpeuse / voluptueuse"],["ronde","Ronde / curvy"],
        ["BBW généreuse","BBW très généreuse"],["petite et compacte","Petite et compacte"]
      ],p.corpulence),
      lbl("Tonicité")+sel("ncTonicite",[
        ["très tonique","Très tonique / dur"],["tonique","Tonique / ferme"],
        ["normal","Normal"],["souple","Souple / doux"]
      ],p.tonicite)
    )}
    ${g2(
      lbl("Taille")+ft("ncTaille","1m68, 1m85...",p.taille),
      lbl("Poids")+ft("ncPoids","55kg, 80kg...",p.poids)
    )}

    ${sec("💇","Visage & Cheveux")}
    ${g2(
      lbl("Couleur cheveux")+sel("ncCheveux",[
        ["Brune","Brune (naturelle)"],["Brune foncée","Brune très foncée"],
        ["Noire","Noire de jais"],["Blonde","Blonde naturelle"],
        ["Blonde platine","Blonde platine"],["Rousse","Rousse"],
        ["Châtain","Châtain"],["Grise","Grise / argentée"],
        ["Coloré rose","Colorée — Rose"],["Coloré bleu","Colorée — Bleu"],
        ["Coloré rouge","Colorée — Rouge vif"],["Coloré violet","Colorée — Violet"],
        ["Ombré","Ombré / balayage"],["Rasé","Rasé / tondu"]
      ],p.cheveux),
      lbl("Longueur")+sel("ncLgCheveux",[
        ["rasé","Rasé / tondu"],["très courts","Très courts (< 3cm)"],
        ["cheveux courts","Courts"],["cheveux mi-courts","Mi-courts"],
        ["cheveux mi-longs","Mi-longs"],["cheveux longs","Longs"],
        ["cheveux très longs","Très longs (taille/hanches)"],["cheveux ultra-longs","Ultra-longs (genoux+)"]
      ],p.longueur_cheveux)
    )}
    ${g2(
      lbl("Texture cheveux")+sel("ncTextureCheveux",[
        ["lisses","Lisses / raides"],["ondulés","Ondulés"],
        ["bouclés","Bouclés"],["frisés","Frisés"],
        ["crépus","Crépus / afro"]
      ],p.texture_cheveux),
      lbl("Couleur yeux")+sel("ncYeux",[
        ["marron","Marron"],["noisette","Noisette"],
        ["verts","Verts"],["bleus","Bleus"],
        ["gris","Gris / ardoise"],["noir","Noir (en amande)"],
        ["violet","Violet (rare)"],["hétérochromie","Hétérochromie"]
      ],p.yeux)
    )}
    ${g2(
      lbl("Couleur peau")+sel("ncPeau",[
        ["claire","Claire / pâle"],["mate olive","Mate / olive"],
        ["dorée bronzée","Dorée / bronzée"],["caramel miel","Caramel / miel"],
        ["brune chocolat","Brune"],["ébène noire","Ébène / noire"],
        ["asiatique","Asiatique / porcelaine"],["métisse","Métisse"]
      ],p.couleur_peau),
      lbl("Lèvres")+sel("ncLevres",[
        ["lèvres fines discrètes","Fines / discrètes"],
        ["lèvres normales","Normales"],["lèvres charnues","Charnues"],
        ["bouche pulpeuse","Pulpeuses / sensuelles"],
        ["lèvres très pulpeuses","Très pulpeuses"]
      ],p.taille_levres)
    )}
    ${lbl("Maquillage")}${ft("ncMaquillage","Smoky eyes, rouge lèvres, naturel...",p.maquillage)}

    ${sec("🍑","Corps féminin")}
    <p style="font-size:11px;color:#888;margin:0 0 8px">(Laisser vide si personnage masculin)</p>
    ${g2(
      lbl("Taille seins")+sel("ncTailleSeins",[
        ["","—"],["seins plats bonnet A-","Plats / bonnet A"],
        ["petits seins bonnet A","Petits / bonnet A"],
        ["seins bonnet B","Bonnet B"],
        ["seins moyens bonnet C","Moyens / bonnet C"],
        ["seins bonnet D","Bonnet D"],
        ["gros seins bonnet DD-E","Gros / DD-E"],
        ["seins XXL bonnet F","XXL / bonnet F"],
        ["seins XXL bonnet G et plus","Immenses / bonnet G+"]
      ],p.taille_seins),
      lbl("Forme seins")+sel("ncFormeSeins",[
        ["","—"],["naturels tombants","Naturels / tombants"],
        ["naturels ronds","Naturels / ronds"],
        ["fermes ronds","Fermes / ronds"],
        ["implants ronds","Implants / ronds"],
        ["implants haut perchés","Implants / haut perchés"]
      ],p.forme_seins)
    )}
    ${g2(
      lbl("Tétons")+sel("ncTetons",[
        ["","—"],["tétons roses petits","Roses / petits"],
        ["tétons rosés moyens","Rosés / moyens"],
        ["tétons bruns","Bruns"],
        ["tétons foncés grands","Foncés / grands"],
        ["tétons percés","Percés"]
      ],p.teton),
      lbl("Forme fesses")+sel("ncFormeFesses",[
        ["","—"],["fesses plates","Plates"],
        ["fesses rondes normales","Rondes / normales"],
        ["fesses rondes généreuses","Rondes / généreuses"],
        ["gros cul BBW","Très généreuses / BBW"],
        ["fesses musclées","Musclées / sport"],
        ["implants fesses","Implants / rehaussées"]
      ],p.forme_fesses)
    )}
    ${g2(
      lbl("Hanches")+sel("ncHanches",[
        ["","—"],["hanches étroites fines","Étroites / fines"],
        ["hanches normales","Normales"],
        ["hanches larges","Larges"],
        ["hanches très larges","Très larges / marquées"]
      ],p.hanches),
      lbl("Ventre")+sel("ncVentre",[
        ["","—"],["ventre plat tonique","Plat / tonique"],
        ["ventre plat normal","Plat / normal"],
        ["légère rondeur naturelle","Légère rondeur"],
        ["ventre rond généreux","Rond / généreux"],
        ["ventre BBW","BBW / très rond"]
      ],p.ventre)
    )}
    ${lbl("Jambes")}${sel("ncJambes",[
      ["","—"],["jambes fines et longues","Fines et longues"],
      ["jambes normales","Normales"],["jambes musclées","Musclées / sport"],
      ["jambes potelées","Potelées / rondes"],["cuisses pulpeuses","Cuisses très pulpeuses"]
    ],p.jambes)}

    ${sec("🏋️","Corps masculin")}
    <p style="font-size:11px;color:#888;margin:0 0 8px">(Laisser vide si personnage féminin)</p>
    ${g2(
      lbl("Pectoraux")+sel("ncPectoraux",[
        ["","—"],["pectoraux fins discrets","Fins / discrets"],
        ["pectoraux normaux","Normaux"],
        ["pectoraux développés","Développés"],
        ["gros pectoraux musclés","Très développés / imposants"]
      ],p.pectoraux),
      lbl("Abdominaux")+sel("ncAbdominaux",[
        ["","—"],["ventre discret","Discret / sans définition"],
        ["légère tablette","Légère tablette"],
        ["tablette 4 cubes","4 cubes"],
        ["tablette 6 cubes","6 cubes marqués"],
        ["tablette 8 cubes","8 cubes / compétition"]
      ],p.abdominaux)
    )}
    ${g2(
      lbl("Taille sexe (masculin)")+sel("ncTailleSexeM",[
        ["","—"],["sexe petit moins de 10cm","Petit (< 10cm)"],
        ["sexe moyen 12 à 15cm","Moyen (12-15cm)"],
        ["sexe grand 15 à 19cm","Grand (15-19cm)"],
        ["sexe très grand 19 à 23cm","Très grand (19-23cm)"],
        ["sexe XXL plus de 23cm","XXL (> 23cm)"]
      ],p.taille_sexe_m),
      lbl("Épaisseur")+sel("ncEpaisseurSexeM",[
        ["","—"],["sexe fin mince","Fin / mince"],
        ["sexe normal","Normal"],
        ["sexe épais","Épais"],
        ["sexe épaisse grosse circonférence","Très épais / imposant"]
      ],p.epaisseur_sexe_m)
    )}
    ${g2(
      lbl("Forme du gland")+sel("ncFormeSexeM",[
        ["","—"],["sexe gland normal","Normal"],
        ["sexe gland large en champignon","Large / en champignon"],
        ["sexe gland fin allongé","Fin / allongé"],
        ["sexe légèrement courbé","Légèrement courbé"]
      ],p.forme_sexe_m),
      lbl("Circoncision")+sel("ncCirconcis",[
        ["","—"],["circoncis","Circoncis"],
        ["non circoncis","Non circoncis / prépuce"],
        ["partiellement","Partiellement"]
      ],p.circoncis)
    )}
    ${lbl("Testicules")}${sel("ncTesticules",[
      ["","—"],["testicules normaux","Normaux"],
      ["testicules petits discrets","Petits / discrets"],
      ["testicules imposants","Imposants / généreux"]
    ],p.testicules)}

    ${sec("🔓","Anatomie & Transition")}
    <div style="display:flex;align-items:center;gap:10px;background:#1a1530;border:1px solid rgba(255,200,0,.3);border-radius:12px;padding:10px;margin-bottom:10px">
      <input type="checkbox" id="ncAnatomieLibre" ${p.anatomie_libre==="true"?"checked":""} style="width:18px;height:18px;accent-color:#fbbf24;flex-shrink:0">
      <label for="ncAnatomieLibre" style="font-size:13px;color:#fbbf24;cursor:pointer">🔓 Anatomie hybride / libre (montrer tout quelle que soit le genre)</label>
    </div>
    ${lbl("Statut chirurgical / Transition")}${sel("ncStatutChir",[
      ["","—"],["non opéré pré-op","Non opéré / pré-op"],
      ["partiellement opéré","Partiellement opéré"],
      ["opéré haut","Opéré haut uniquement (torse)"],
      ["opéré bas vaginoplastie","Opéré bas — vaginoplastie"],
      ["opéré bas phalloplastie","Opéré bas — phalloplastie"],
      ["opéré complet","Opéré complet"]
    ],p.statut_chirurgical)}

    ${sec("🌿","Pilosité intime")}
    ${g2(
      lbl("Pilosité")+sel("ncPilosite",[
        ["rasée","Rasée / épilée complète"],
        ["mini triangle","Mini triangle / lanière"],
        ["triangle classique","Triangle classique"],
        ["pilosité naturelle légère","Naturelle légère"],
        ["pilosité normale taillée","Normale / taillée"],
        ["pilosité naturelle fournie","Naturelle fournie / bush"]
      ],p.pilosite),
      lbl("Style")+sel("ncStylePilosite",[
        ["rasée épilée complète","Rasée / épilée"],
        ["naturelle courte légère","Naturelle courte"],
        ["pilosité taillée fine","Taillée fine"],
        ["pilosité normale taillée","Normale / taillée"],
        ["naturelle fournie","Naturelle fournie"]
      ],p.style_pilosite)
    )}
    ${lbl("Morphologie intime")}${sel("ncMorphoIntime",[
      ["","—"],["petite discrète","Petite / discrète"],
      ["normale","Normale"],["généreux ouvert","Généreux / ouvert"],
      ["grandes lèvres proéminentes","Grandes lèvres proéminentes"],
      ["clitoris développé","Clitoris développé"]
    ],p.morpho_intime)}

    ${sec("💎","Style & Accessoires")}
    ${g2(
      lbl("Style vestimentaire")+ft("ncStyle","Cuir, latex, casual, lingerie...",p.style),
      lbl("Tenue préférée")+ft("ncTenue","Harnais cuir, nuisette...",p.tenue_preferee)
    )}
    ${lbl("Lunettes")}${sel("ncLunettes",[
      ["","Sans lunettes"],
      ["lunettes carrées noires","Carrées noires"],
      ["lunettes rondes dorées","Rondes dorées"],
      ["lunettes soleil aviateur","Soleil aviateur"],
      ["lunettes cat-eye","Cat-eye"],
      ["lunettes transparentes","Transparentes"],
      ["lunettes soleil noires","Soleil noires"]
    ],p.lunettes)}
    ${lbl("Bijoux (description libre)")}${ft("ncBijoux","Collier or, bracelets acier...",p.bijoux)}
    ${lbl("Tatouages")}${ft("ncTatouages","Dragon dos, phoenix, manchette bras...",p.tatouages)}
    ${lbl("Piercings")}${ft("ncPiercings","Septum, tétons, nombril, labret...",p.piercings)}

    ${sec("🔥","Sexualité")}
    ${lbl("Kinks & pratiques")}${ft("ncKinks","Bondage, pegging, fist, humiliation...",p.kinks)}
    ${lbl("Fantasmes")}${ft("ncFantasmes","Scénarios, situations...",p.fantasmes)}
    ${lbl("Limites absolues")}${ft("ncLimites","(vide = uniquement l'illégal)",p.limites)}
    ${lbl("Niveau intensité")}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      ${range("ncNiveau",p.niveau_intensite||"7",1,10,1)}
      <span id="ncNiveauVal" style="color:#ff3f91;font-weight:700;min-width:16px;text-align:center">${p.niveau_intensite||7}</span>
    </div>
    <p style="font-size:11px;color:#888;margin:0 0 12px;text-align:center">Curseurs de personnalité</p>
    ${[
      ["ncDouceur","💞 Douceur",p.curseur_douceur||"5"],
      ["ncCrudite","🔥 Crudité",p.curseur_crudite||"5"],
      ["ncDomination","⛓️ Domination",p.curseur_domination||"5"],
      ["ncHumiliation","😈 Humiliation",p.curseur_humiliation||"3"],
      ["ncRomantisme","🌹 Romantisme",p.curseur_romantisme||"5"]
    ].map(([id,lbl,val])=>`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <span style="font-size:12px;color:#aaa;width:120px;flex-shrink:0">${lbl}</span>
        <input type="range" id="${id}" min="0" max="10" value="${val}" style="flex:1;accent-color:#ff3f91">
        <span id="${id}Val" style="color:#ff3f91;font-weight:700;min-width:16px;text-align:right">${val}</span>
      </div>`).join("")}
    ${lbl("Initiative sexuelle")}${sel("ncInitiative",[
      ["aucune","Aucune — attend toujours"],
      ["rare","Rare — sur demande"],
      ["normale","Normale"],
      ["fréquente","Fréquente — prend souvent les devants"],
      ["totale","Totale — toujours actif-ve"]
    ],p.initiative_sexuelle)}

    ${isEdit ? `<div style="margin-bottom:12px;padding:10px;background:#1a1530;border-radius:12px;border:1px solid rgba(255,63,145,.2)">
      <p style="font-size:12px;color:#ff3f91;font-weight:700;margin:0 0 8px">📸 Générer une photo avec ce profil exact</p>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button onclick="generateCompanionAvatar('${editCompanion.id}','${editCompanion.name?.replace(/'/g,"\'")||"?"}','portrait')" style="background:#1e1b2e;border:1px solid #ff3f91;border-radius:10px;padding:6px 12px;color:#ff3f91;font-size:12px;cursor:pointer">🎭 Portrait</button>
        <button onclick="generateCompanionAvatar('${editCompanion.id}','${editCompanion.name?.replace(/'/g,"\'")||"?"}','sensuelle')" style="background:#1e1b2e;border:1px solid #a855f7;border-radius:10px;padding:6px 12px;color:#a855f7;font-size:12px;cursor:pointer">💜 Sensuelle</button>
        <button onclick="generateCompanionAvatar('${editCompanion.id}','${editCompanion.name?.replace(/'/g,"\'")||"?"}','nue')" style="background:#1e1b2e;border:1px solid #e55;border-radius:10px;padding:6px 12px;color:#e55;font-size:12px;cursor:pointer">🔥 Nue</button>
      </div>
      <p id="compAvatarStatus_${editCompanion.id}" style="font-size:11px;color:#888;margin:6px 0 0;min-height:16px"></p>
    </div>` : ""}
    <div style="display:grid;grid-template-columns:${isEdit?"1fr 1fr 1fr":"1fr 1fr"};gap:8px;margin-top:20px">
      ${isEdit?`<button onclick="deleteCompanion('${editCompanion.id}','${editCompanion.name?.replace(/'/g,"\'")}')" style="background:#1e1b2e;border:1px solid #e55;border-radius:12px;padding:10px;color:#e55;cursor:pointer;font-size:13px">🗑️ Supprimer</button>`:""}
      <button onclick="document.getElementById('newCompModalOv')?.remove()" style="background:#1e1b2e;border:1px solid #555;border-radius:12px;padding:10px;color:#aaa;cursor:pointer">Annuler</button>
      <button onclick="saveNewCompanion('${isEdit?editCompanion.id:""}')" style="background:linear-gradient(135deg,#ff3f91,#a855f7);border:none;border-radius:12px;padding:10px;color:#fff;font-weight:700;cursor:pointer">${isEdit?"💾 Sauvegarder":"Créer ✨"}</button>
    </div>
    <p id="newCompError" style="color:#e55;font-size:12px;margin-top:8px;text-align:center"></p>
  </div>`;

  document.body.appendChild(ov);
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };

  // Sliders live
  document.getElementById("ncNiveau")?.addEventListener("input", e => {
    const v = document.getElementById("ncNiveauVal");
    if (v) v.textContent = e.target.value;
  });
  ["ncDouceur","ncCrudite","ncDomination","ncHumiliation","ncRomantisme"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", e => {
      const v = document.getElementById(id+"Val");
      if (v) v.textContent = e.target.value;
    });
  });
}

async function saveNewCompanion(editId) {
  const name = document.getElementById("ncName")?.value?.trim();
  if (!name) { const err=$("newCompError"); if(err)err.textContent="Prénom obligatoire"; return; }
  const profile = {
    genre:            document.getElementById("ncGenre")?.value || "femme",
    age:              document.getElementById("ncAge")?.value || "25",
    origine:          document.getElementById("ncOrigine")?.value || "",
    caractere:        document.getElementById("ncCaractere")?.value || "",
    passions:         document.getElementById("ncPassions")?.value || "",
    profession:       document.getElementById("ncProfession")?.value || "",
    corpulence:       document.getElementById("ncCorpulence")?.value || "",
    tonicite:         document.getElementById("ncTonicite")?.value || "",
    taille:           document.getElementById("ncTaille")?.value || "",
    poids:            document.getElementById("ncPoids")?.value || "",
    cheveux:          document.getElementById("ncCheveux")?.value || "",
    longueur_cheveux: document.getElementById("ncLgCheveux")?.value || "",
    texture_cheveux:  document.getElementById("ncTextureCheveux")?.value || "",
    yeux:             document.getElementById("ncYeux")?.value || "",
    couleur_peau:     document.getElementById("ncPeau")?.value || "",
    taille_levres:    document.getElementById("ncLevres")?.value || "",
    maquillage:       document.getElementById("ncMaquillage")?.value || "",
    taille_seins:     document.getElementById("ncTailleSeins")?.value || "",
    forme_seins:      document.getElementById("ncFormeSeins")?.value || "",
    teton:            document.getElementById("ncTetons")?.value || "",
    forme_fesses:     document.getElementById("ncFormeFesses")?.value || "",
    hanches:          document.getElementById("ncHanches")?.value || "",
    ventre:           document.getElementById("ncVentre")?.value || "",
    jambes:           document.getElementById("ncJambes")?.value || "",
    pectoraux:        document.getElementById("ncPectoraux")?.value || "",
    abdominaux:       document.getElementById("ncAbdominaux")?.value || "",
    taille_sexe_m:    document.getElementById("ncTailleSexeM")?.value || "",
    epaisseur_sexe_m: document.getElementById("ncEpaisseurSexeM")?.value || "",
    forme_sexe_m:     document.getElementById("ncFormeSexeM")?.value || "",
    circoncis:        document.getElementById("ncCirconcis")?.value || "",
    testicules:       document.getElementById("ncTesticules")?.value || "",
    anatomie_libre:   document.getElementById("ncAnatomieLibre")?.checked ? "true" : "",
    statut_chirurgical:document.getElementById("ncStatutChir")?.value || "",
    pilosite:         document.getElementById("ncPilosite")?.value || "",
    style_pilosite:   document.getElementById("ncStylePilosite")?.value || "",
    morpho_intime:    document.getElementById("ncMorphoIntime")?.value || "",
    lunettes:         document.getElementById("ncLunettes")?.value || "",
    bijoux:           document.getElementById("ncBijoux")?.value || "",
    tatouages:        document.getElementById("ncTatouages")?.value || "",
    piercings:        document.getElementById("ncPiercings")?.value || "",
    style:            document.getElementById("ncStyle")?.value || "",
    tenue_preferee:   document.getElementById("ncTenue")?.value || "",
    kinks:            document.getElementById("ncKinks")?.value || "",
    fantasmes:        document.getElementById("ncFantasmes")?.value || "",
    limites:          document.getElementById("ncLimites")?.value || "",
    niveau_intensite: document.getElementById("ncNiveau")?.value || "7",
    curseur_douceur:  document.getElementById("ncDouceur")?.value || "5",
    curseur_crudite:  document.getElementById("ncCrudite")?.value || "5",
    curseur_domination:document.getElementById("ncDomination")?.value || "5",
    curseur_humiliation:document.getElementById("ncHumiliation")?.value || "3",
    curseur_romantisme:document.getElementById("ncRomantisme")?.value || "5",
    initiative_sexuelle:document.getElementById("ncInitiative")?.value || "normale",
  };
  const persona = document.getElementById("ncPersona")?.value || "girlfriend";
  try {
    const d = editId
      ? await api("PUT", `/api/companions/${editId}`, { name, persona, profile })
      : await api("POST", "/api/companions", { name, persona, profile });
    if (!d.ok) throw new Error(d.error || "Erreur");
    document.getElementById("newCompModalOv")?.remove();
    await loadCompanions();
    if (!editId) await switchCompanion(d.id, name);
    showToast(editId ? `✅ ${name} mis à jour !` : `✨ ${name} créé-e !`, "success");
  } catch(e) { const err=$("newCompError"); if(err) err.textContent=e.message; }
}



// ═══════════════════════════════════════════════════════
// v13 — AVATAR PARLANT : expressions + animation TTS
// ═══════════════════════════════════════════════════════
let _avatarPhotos = [];
let _avatarPhotoIdx = 0;
let _speakingInterval = null;
let _expressionPhotos = { neutre:null, souriante:null, sensuelle:null, surprise:null };

function _loadExpressionsFromStorage() {
  for (const key of ["neutre","souriante","sensuelle","surprise"]) {
    const url = localStorage.getItem(`elissia_expr_${key}`);
    if (url) _expressionPhotos[key] = url;
  }
}

function _startAvatarSpeakAnim(text) {
  const img = $("avatarImg");
  if (!img || img.hidden) return;
  const t = (text||"").toLowerCase();
  let expr = "neutre";
  if (/😊|💕|❤️|amour|câlin|tendre|doux/.test(text)) expr = "souriante";
  else if (/🔥|désir|envie|veux|excit|humide|dur|queue|bite|chatte|jouiss|orgasm/.test(text)) expr = "sensuelle";
  else if (/!{2,}|surprise|quoi|non|oh|ah|enfin/.test(text)) expr = "surprise";
  const exprUrl = _expressionPhotos[expr];
  if (exprUrl) { img.dataset.originalSrc = img.dataset.originalSrc || img.src; img.src = exprUrl; }
  img.style.transition = "transform 0.15s ease";
  let tick = 0;
  _speakingInterval = setInterval(() => {
    tick++;
    img.style.transform = `scale(${1 + Math.sin(tick * 0.8) * 0.03})`;
    img.style.filter = `brightness(${1 + Math.sin(tick * 0.5) * 0.08})`;
  }, 120);
}

function _stopAvatarSpeakAnim() {
  if (_speakingInterval) { clearInterval(_speakingInterval); _speakingInterval = null; }
  const img = $("avatarImg");
  if (!img) return;
  img.style.transform = "";
  img.style.filter = "";
  if (img.dataset.originalSrc) { img.src = img.dataset.originalSrc; delete img.dataset.originalSrc; }
}

async function generateExpressionPhotos() {
  const statusEl = $("expressionStatus");
  if (statusEl) statusEl.textContent = "⏳ Génération des 4 expressions...";
  const expressions = [
    { key:"neutre",    style:"portrait" },
    { key:"souriante", style:"portrait_sourire" },
    { key:"sensuelle", style:"buste_nu" },
    { key:"surprise",  style:"portrait" },
  ];
  let done = 0;
  for (const ex of expressions) {
    try {
      const d = await api("POST", "/api/generate/avatar", { style:ex.style, seed:Math.floor(Math.random()*999999), ext:getCurrentExt() });
      if (d.ok && d.url) {
        _expressionPhotos[ex.key] = d.url;
        localStorage.setItem(`elissia_expr_${ex.key}`, d.url);
        done++;
        if (statusEl) statusEl.textContent = `✅ ${done}/4 — ${ex.key}`;
      }
    } catch(e) { console.warn("[expr]", ex.key, e.message); }
  }
  showToast(`${done} expressions prêtes !`, "success");
}

// ═══════════════════════════════════════════════════════
// v13 — SÉLECTEUR PHOTO RAPIDE (swiper dans le header)
// ═══════════════════════════════════════════════════════
async function openPhotoSwiper() {
  let existing = $("photoSwiper");
  if (existing) { existing.remove(); return; }
  let photos = [];
  try {
    // ✅ v13 : Si compagnon actif → galerie filtrée sur ses photos uniquement
    const cid = window._activeCompanionId;
    const url = cid ? `/api/companions/${cid}/photos` : "/api/gallery";
    const d = await api("GET", url);
    photos = cid
      ? (d.photos||[]).map(p => ({filename: p.url, style: p.style}))
      : (d.photos||[]);
  } catch(e) { console.warn("[swiper]", e.message); }
  const currentUrl = user?.avatarUrl || user?.personaPhotoUrl;
  if (currentUrl && !photos.find(p=>p.filename===currentUrl)) photos.unshift({filename:currentUrl,style:"actuelle"});
  if (!photos.length) { openAvatarModal(); return; }

  const swiper = document.createElement("div");
  swiper.id = "photoSwiper";
  swiper.style.cssText = "position:fixed;top:60px;left:0;right:0;z-index:800;background:#0a0818;border-bottom:1px solid rgba(255,63,145,.4);padding:10px 12px;display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;scroll-behavior:smooth;box-shadow:0 4px 20px rgba(0,0,0,.7)";

  photos.forEach(p => {
    const cell = document.createElement("div");
    cell.style.cssText = "flex-shrink:0;position:relative;cursor:pointer";
    const img = document.createElement("img");
    img.src = p.filename;
    const isCurrent = p.filename === currentUrl;
    img.style.cssText = `width:72px;height:72px;border-radius:12px;object-fit:cover;border:2px solid ${isCurrent?"#ff3f91":"rgba(255,255,255,.15)"};transition:border-color .2s`;
    img.onclick = async () => {
      await saveAsAvatar(p.filename);
      swiper.querySelectorAll("img").forEach(el => el.style.borderColor="rgba(255,255,255,.15)");
      img.style.borderColor = "#ff3f91";
      showToast("✅ Photo changée !", "success");
    };
    img.onerror = () => { cell.remove(); }; // Supprimer silencieusement les 404
    if (isCurrent) {
      const crown = document.createElement("div");
      crown.style.cssText = "position:absolute;top:-4px;right:-4px;background:#ff3f91;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff";
      crown.textContent = "✓";
      cell.appendChild(crown);
    }
    cell.appendChild(img);
    swiper.appendChild(cell);
  });

  // Bouton importer
  const importBtn = document.createElement("div");
  importBtn.style.cssText = "flex-shrink:0;width:72px;height:72px;border-radius:12px;border:2px dashed #38bdf8;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;gap:4px";
  importBtn.innerHTML = '<span style="font-size:20px">📁</span><span style="font-size:9px;color:#38bdf8">Importer</span>';
  importBtn.onclick = () => { swiper.remove(); uploadManualAvatar(); };
  swiper.appendChild(importBtn);

  const genBtn = document.createElement("div");
  genBtn.style.cssText = "flex-shrink:0;width:72px;height:72px;border-radius:12px;border:2px dashed #ff3f91;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;gap:4px";
  genBtn.innerHTML = '<span style="font-size:20px">✨</span><span style="font-size:9px;color:#ff3f91">Générer</span>';
  genBtn.onclick = () => { swiper.remove(); generateAIAvatar("portrait"); };
  swiper.appendChild(genBtn);

  document.body.appendChild(swiper);
  setTimeout(() => {
    document.addEventListener("click", function closeSwiper(e) {
      if (!swiper.contains(e.target) && e.target.id !== "avatarZone" && !$("avatarZone")?.contains(e.target)) {
        swiper.remove();
        document.removeEventListener("click", closeSwiper);
      }
    });
  }, 150);
}

// ═══════════════════════════════════════════════════════
// v13 — SCÈNE VIDÉO MULTI-PERSONNAGES
// ═══════════════════════════════════════════════════════
async function generateSceneVideo(scenarioContext, companionIds) {
  if (!companionIds?.length) { showToast("Sélectionne au moins un compagnon", "info"); return; }
  showToast("🎬 Génération vidéo multi-personnages... (2-5 min)", "info");
  const statusEl = $("multiChatVideoStatus");
  if (statusEl) statusEl.textContent = "⏳ Perplexity construit le prompt...";
  try {
    await refreshCsrf();
    const explicit = Boolean(user?.adultMode && user?.ageConfirmed);
    const r = await fetch("/api/generate/scene-video", {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},
      body:JSON.stringify({ scenarioContext, companionIds, style:explicit?"nue":"sensuelle" })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error||"Erreur");
    const names = d.companions?.join(", ")||"Scène";
    addMsg("assistant", `🎬 Scène vidéo : ${names}`, d.url, "video/mp4");
    if (statusEl) statusEl.textContent = `✅ Vidéo prête (${d.frames} frames)`;
    showToast("🎬 Vidéo de scène créée !", "success");
    if ($("galleryPanel")?.open) loadGallery();
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ "+e.message;
    showToast("❌ "+e.message, "error");
  }
}

function launchSceneVideo() {
  const checkboxes = document.querySelectorAll('#multiChatOv input[type=checkbox]:checked, div[style*="inset:0"] input[type=checkbox]:checked');
  const ids = Array.from(checkboxes).map(c=>c.value);
  const ctx = document.getElementById("multiScenarioCtx")?.value||"";
  if (!ids.length) { showToast("Sélectionne des compagnons", "info"); return; }
  window._lastMultiChatIds = ids;
  window._lastMultiChatContext = ctx;
  document.querySelector("div[style*='inset:0']")?.remove();
  generateSceneVideo(ctx, ids);
}

// ═══════════════════════════════════════════════════════
// v13 — PWA SERVICE WORKER
// ═══════════════════════════════════════════════════════
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(reg => {
      console.log("[PWA] SW enregistré ✅", reg.scope);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        nw?.addEventListener("statechange", () => {
          if (nw.state==="installed" && navigator.serviceWorker.controller)
            showToast("🔄 Mise à jour dispo — recharge l'app", "info");
        });
      });
    }).catch(e => console.warn("[PWA] SW:", e));
  });
  let deferredPrompt=null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferredPrompt=e;
    const btn=$("pwaInstallBtn"); if(btn) btn.hidden=false;
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt=null;
    showToast("✅ ÉLISSIA installée !", "success");
    const btn=$("pwaInstallBtn"); if(btn) btn.hidden=true;
  });
  window._installPWA = async () => {
    if (!deferredPrompt) { showToast("Déjà installée ou navigateur non compatible", "info"); return; }
    deferredPrompt.prompt();
    const {outcome} = await deferredPrompt.userChoice;
    deferredPrompt=null;
    if (outcome==="accepted") showToast("🎉 Installation en cours...", "success");
  };
}

// ═══════════════════════════════════════════════════════
// Ajouter les nouvelles fonctions aux exports globaux
// ═══════════════════════════════════════════════════════
Object.assign(window, {
  openPhotoSwiper, generateExpressionPhotos, _startAvatarSpeakAnim, _stopAvatarSpeakAnim,
  _loadExpressionsFromStorage, generateSceneVideo, launchSceneVideo
});


// ══ GÉNÉRATION PHOTO COMPAGNON (profil exact) v13 ════════════
async function generateCompanionAvatar(companionId, companionName, style) {
  const st = style || "portrait";
  showToast(`⏳ Génération ${companionName} (${st})...`, "info");
  const statusEl = document.getElementById("compAvatarStatus_" + companionId);
  if (statusEl) statusEl.textContent = "⏳ En cours...";
  try {
    await refreshCsrf();
    const r = await fetch(`/api/companions/${companionId}/generate-avatar`, {
      method:"POST", credentials:"same-origin",
      headers:{"Content-Type":"application/json","X-CSRF-Token":csrf},
      body: JSON.stringify({ style:st, seed:Math.floor(Math.random()*999999) })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "Erreur");
    // Mettre à jour l'avatar dans la barre compagnons
    await loadCompanions();
    if (statusEl) statusEl.textContent = "✅ Photo générée !";
    showToast(`✅ ${companionName} — nouvelle photo !`, "success");
    return d.url;
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    showToast("❌ " + e.message, "error");
  }
}

// Supprimer une photo de la galerie
async function deleteGalleryPhoto(filename, el) {
  if (!confirm("Supprimer cette photo définitivement ?")) return;
  try {
    await refreshCsrf();
    const r = await fetch(`/api/gallery/${encodeURIComponent(filename.replace("/uploads/",""))}`, {
      method:"DELETE", credentials:"same-origin",
      headers:{"X-CSRF-Token":csrf}
    });
    const d = await r.json();
    if (d.ok) { el?.closest(".gallery-item")?.remove(); showToast("🗑️ Photo supprimée", "info"); }
    else showToast("❌ " + d.error, "error");
  } catch(e) { showToast("❌ " + e.message, "error"); }
}

Object.assign(window, { generateCompanionAvatar, deleteGalleryPhoto });
