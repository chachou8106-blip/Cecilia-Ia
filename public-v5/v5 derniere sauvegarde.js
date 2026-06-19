/* ══════════════════════════════════════════════════════════════
   ÉLISSIA v11 — Frontend Mobile Complet
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
    // ✅ v11 : scénario persistant — injecté dans chaque message
    scenarioActive,
    scenarioContext,
    scenarioType
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
  if (piperAvailable) { await speakPiper(text); } else { speakBrowser(text); }
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
    const d = await api("POST", "/api/generate/selfie", {
      style: style || "sensuelle", tenue, contexte,
      seed: Math.floor(Math.random() * 999999999),
      ext: getCurrentExt()
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
        prompt, explicit: Boolean(user?.adultMode && user?.ageConfirmed), ext: getCurrentExt()
      });
      if (d.ok && d.video_url) {
        addMsg("assistant", `🎬 ${prompt}`, d.video_url, "video/mp4");
      } else throw new Error(d.error || "Échec vidéo");
    } else {
      const style = typeGen === "gif" ? "gif" : (tenue ? tenue.split(" ")[0] : "sensuelle");
      const d = await api("POST", "/api/generate/image", {
        style, prompt, seed: Math.floor(Math.random() * 999999999), ext: getCurrentExt()
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
