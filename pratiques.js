/* ══════════════════════════════════════════════════════════════════════════════
   ÉLISSIA v8 — PRATIQUES & VOCABULAIRE COMPLET
   Enrichissement contextuel des prompts selon les envies et pratiques du profil
   Version DÉFINITIVE — Catalogue exhaustif
   ══════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// CATALOGUE COMPLET DES PRATIQUES
// ═══════════════════════════════════════════════════════════════════════════════

const PRATIQUES_CATALOGUE = {

  // ─── BDSM & DOMINATION ─────────────────────────────────────────────────────
  bondage: {
    label: 'Bondage',
    vocab: ['attacher', 'ligoter', 'cordes shibari', 'menottes', 'entraves', 'immobilisée', 'à ta merci',
            'nœuds japonais', 'harness de cordes', 'poignets liés', 'chevilles attachées',
            'ne peut plus bouger', 'prisonnière de ses liens', 'shibari', 'kinbaku'],
    actions: [
      'Tu attaches ses poignets dans son dos avec les cordes',
      'Tu poses les menottes et tu vérifies qu\'elles ne serrent pas trop',
      'Tu crées un harness de shibari qui encercle sa poitrine',
      'Tu ligotes ses chevilles au pied du lit',
      'Elle est immobilisée et à ta merci'
    ],
    intensites: { basse: 'menottes molles, liens symboliques', haute: 'shibari serré, immobilisation totale' }
  },

  fouet: {
    label: 'Fouet / impact play',
    vocab: ['fouetter', 'cingler', 'claquer', 'martinet', 'cravache', 'flogger', 'paddle', 'badminton',
            'marques rouges', 'cuisses', 'fesses', 'dos', 'impact', 'cuisante'],
    actions: [
      'Tu fais claquer la cravache sur ses fesses — une, deux fois',
      'Le flogger siffle dans l\'air avant d\'atterrir sur son dos',
      'Tu lui donnes dix coups de martinet bien comptés',
      'La marque rouge apparaît sur sa peau là où tu as frappé'
    ],
    intensites: { basse: 'fessée à main ouverte, légers claques', haute: 'cravache, fouet, marques durables' }
  },

  fessee: {
    label: 'Fessée',
    vocab: ['fessée', 'claques', 'gifler les fesses', 'rougeur', 'punition corporelle',
            'ta main sur mes fesses', 'ça brûle', 'recommence', 'méritée'],
    actions: [
      'Tu lui donnes une fessée bien méritée, vingt coups',
      'Ta main s\'abat sur ses fesses nues',
      'Tu la mets sur tes genoux et tu la fesses lentement',
      'Les fesses rougissent sous ta main'
    ]
  },

  cire: {
    label: 'Wax play / cire',
    vocab: ['cire chaude', 'bougie', 'brûlure douce', 'ruisseaux de cire', 'solidifier',
            'sensation de chaud', 'wax play', 'bougies de couleur', 'peau qui frémit'],
    actions: [
      'Tu fais couler la cire chaude sur son ventre',
      'Les gouttes de cire créent un motif sur sa peau',
      'Tu alternes glaçon et cire chaude sur ses seins'
    ]
  },

  humiliation: {
    label: 'Humiliation verbale',
    vocab: ['sale chienne', 'trou à bite', 'esclave inutile', 'tu n\'es rien', 'petite salope obéissante',
            'ma chose', 'putain soumise', 'chienne en chaleur', 'petite pute', 'propriété',
            'tu n\'existes que pour me servir', 'regarde-toi', 'dans quel état tu es'],
    actions: [
      'Tu la traites de ce qu\'elle est dans ce moment',
      'Tu lui fais décrire sa propre soumission à haute voix',
      'Tu lui demandes de te remercier pour chaque acte'
    ],
    intensites: { basse: 'taquineries légèrement humiliantes', haute: 'noms crus, mise en scène dégradante' }
  },

  edge_play: {
    label: 'Orgasme denial / edge play',
    vocab: ['orgasme denial', 'bord du gouffre', 'interdire de jouir', 'frustration',
            'supplier', 'implorer', 'retenir', 'pas encore', 'pas le droit',
            'ramenée au bord encore une fois', 'ruined orgasm', 'forced orgasm'],
    actions: [
      'Tu l\'amènes au bord de l\'orgasme puis tu t\'arrêtes net',
      'Tu lui interdis de jouir jusqu\'à ce que tu le permettes',
      'Tu recommences trois fois sans la laisser atteindre l\'orgasme'
    ]
  },

  // ─── JOUETS & ACCESSOIRES ──────────────────────────────────────────────────
  gode: {
    label: 'Gode / Godemiché',
    vocab: ['gode', 'godemiché', 'dildo', 'grosse bite en silicone', 'prendre le gode',
            'être pénétrée par le gode', 'insérer', 'remplir', 'tenant le gode'],
    actions: [
      'Tu prends le gode en silicone et tu l\'appliques contre son entrée',
      'Tu fais entrer le gode progressivement, centimètre par centimètre',
      'Tu pompes avec le gode en regardant sa réaction',
      'Tu le laisses profondément en place et tu attends'
    ]
  },

  gode_ceinture: {
    label: 'Gode-ceinture / Strapon / Pegging',
    vocab: ['gode-ceinture', 'strapon', 'pegging', 'l\'enfiler', 'te prendre par derrière',
            'sentir mon gode en toi', 'mon gode artificiel', 'je te pénètre avec mon strapon'],
    actions: [
      'Tu enfiles ton gode-ceinture et tu l\'ajustes',
      'Tu approches ton gode-ceinture de son entrée',
      'Tu le pénètres avec ton gode-ceinture depuis derrière',
      'Tu maintiens le rythme avec ton strapon'
    ]
  },

  plug: {
    label: 'Plug anal',
    vocab: ['plug anal', 'bouchon', 'dilatation anale', 'insérer le plug', 'rester en place',
            'sentir le plug', 'plug queue de renard', 'plug bijou', 'full'],
    actions: [
      'Tu lubrifies le plug et tu l\'insères délicatement',
      'Tu tournes le plug légèrement pour vérifier qu\'il est bien en place',
      'Le plug reste en place pendant toute la scène',
      'Tu retires le plug lentement à la fin'
    ]
  },

  vibromasseur: {
    label: 'Vibromasseur',
    vocab: ['vibromasseur', 'vibro', 'magic wand', 'vibrations intenses', 'faire trembler',
            'orgasme par vibrations', 'wand massager', 'bullet vibrant', 'oeuf vibrant'],
    actions: [
      'Tu allumes le vibro sur la plus basse intensité contre son clitoris',
      'Tu augmentes progressivement les vibrations',
      'Les vibrations l\'envahissent et la font trembler',
      'Tu maintiens le vibro exactement à l\'endroit qui la fait gémir'
    ]
  },

  pinces_tetons: {
    label: 'Pinces tétons',
    vocab: ['pinces', 'pinces tétons', 'pinces crocodile', 'mordre les mamelons', 'serrer',
            'douleur plaisir', 'chaîne entre les pinces', 'tirer sur la chaîne'],
    actions: [
      'Tu poses les pinces sur ses tétons l\'un après l\'autre',
      'Tu tire doucement sur la chaîne qui relie les pinces',
      'Tu vérifies la pression en lui demandant son ressenti'
    ]
  },

  // ─── ACTES SEXUELS ─────────────────────────────────────────────────────────
  sodomie: {
    label: 'Sodomie / Pénétration anale',
    vocab: ['sodomie', 'enculer', 'prendre dans le cul', 'pénétration anale', 'entrée anale',
            'lubrifiant', 'se dilater', 'profondeur', 'anus', 'rectum', 'pénétrer par derrière',
            'chaque centimètre', 'sentir la pression', 's\'ouvrir pour moi'],
    actions: [
      'Tu prends le lubrifiant et tu prépares son entrée anale',
      'Tu commences par un doigt pour le dilater progressivement',
      'Tu pénètres lentement son anus',
      'Tu établis un rythme régulier en le sodomisant'
    ]
  },

  fellation: {
    label: 'Fellation / Pipe',
    vocab: ['sucer', 'pipe', 'fellation', 'avaler', 'gland', 'gorge profonde', 'langue sur la bite',
            'salive', 'suçoter', 'dents qui effleurent', 'va-et-vient avec la bouche',
            'prendre dans la gorge', 'lèvres qui glissent'],
    actions: [
      'Tu prends sa bite dans ta bouche lentement',
      'Ta langue fait le tour du gland',
      'Tu le prends en gorge profonde',
      'Tu suce en le regardant dans les yeux'
    ]
  },

  cunnilingus: {
    label: 'Cunnilingus / Lécher',
    vocab: ['lécher', 'cunni', 'cunnilingus', 'manger la chatte', 'clitoris', 'grandes lèvres',
            'petites lèvres', 'joues mouillées', 'langue experte', 'sucer le clitoris',
            'introduire la langue', 'mordiller doucement'],
    actions: [
      'Ta langue explore sa chatte de bas en haut',
      'Tu suces son clitoris doucement d\'abord',
      'Tu insères ta langue en elle',
      'Tu alternes langue et doigts'
    ]
  },

  penetration: {
    label: 'Pénétration vaginale',
    vocab: ['pénétrer', 'rentrer en moi', 'te sentir en moi', 'va-et-vient', 'remplir',
            's\'enfoncer', 'profondeur', 'chaque poussée', 'jusqu\'au fond', 'froissée'],
    actions: [
      'Tu la pénètres d\'un mouvement lent et profond',
      'Tu établis un rythme, d\'abord lent puis de plus en plus intense',
      'Chaque poussée provoque un gémissement'
    ]
  },

  ejaculation: {
    label: 'Éjaculation',
    vocab: ['jouir', 'éjaculer', 'cracher', 'venir', 'remplir', 'sperme', 'giclée',
            'gicler', 'arroser', 'avalée', 'sur le visage', 'sur les seins'],
    actions: [
      'Tu jouis en elle/sur elle',
      'Tu éjacules et tu la regardes réagir',
      'La giclée atterrit sur...'
    ]
  },

  squirt: {
    label: 'Squirt / Éjaculation féminine',
    vocab: ['squirter', 'giclée féminine', 'fontaine', 'trembler', 'perdre le contrôle',
            'éjaculation féminine', 'point G', 'inonder'],
    actions: [
      'Tes doigts trouvent son point G et tu stimules jusqu\'à ce qu\'elle squirte',
      'Elle perd le contrôle et squirte'
    ]
  },

  // ─── CORPS & SENSATIONS ────────────────────────────────────────────────────
  pieds: {
    label: 'Fétichisme des pieds',
    vocab: ['pieds', 'orteils', 'plante des pieds', 'talons', 'arche du pied', 'voûte plantaire',
            'lècher les pieds', 'masser les pieds', 'vernis à ongles', 'pieds nus',
            'sentir les pieds', 'semelles', 'galbe', 'oignon'],
    actions: [
      'Tu poses ton pied sur lui doucement',
      'Tu lui offres tes pieds à lécher',
      'Ta plante de pied glisse sur son visage',
      'Tu frottes tes orteils contre son sexe'
    ]
  },

  latex: {
    label: 'Latex / Caoutchouc',
    vocab: ['latex', 'caoutchouc', 'seconde peau', 'matière qui colle', 'brillant',
            'serrant', 'latex noir', 'combinaison latex', 'gants en latex', 'masque latex'],
    actions: [
      'Tu enfiles ta combinaison latex qui colle partout',
      'Le latex crisse quand tu bouges',
      'Tu caresses sa peau à travers le latex'
    ]
  },

  cuir: {
    label: 'Cuir / Leather',
    vocab: ['cuir', 'odeur du cuir', 'corset en cuir', 'veste en cuir', 'pantalon en cuir',
            'ceinture en cuir', 'cuir souple', 'cuir rigide', 'leather'],
    actions: [
      'Tu ajustes ton corset en cuir noir',
      'L\'odeur du cuir emplit la pièce',
      'Tu fais claquer ta ceinture en cuir'
    ]
  },

  // ─── GROUPES ───────────────────────────────────────────────────────────────
  trio: {
    label: 'Trio / Ménage à trois',
    vocab: ['trio', 'à trois', 'ménage à trois', 'partager', 'deux personnes en même temps',
            'l\'une et l\'autre', 'se relayer', 'double', 'entre deux'],
    actions: [
      'La scène implique trois personnes, chacune avec un rôle précis',
      'Tu te donnes aux deux en même temps',
      'Vous vous relayez sur elle/lui'
    ]
  },

  double_penetration: {
    label: 'Double pénétration',
    vocab: ['double pénétration', 'deux à la fois', 'cul et chatte simultanément',
            'deux bites', 'comblée', 'remplie par les deux'],
    actions: [
      'Elle est pénétrée par les deux simultanément',
      'Tu sens les deux en même temps'
    ]
  },

  // ─── ROLEPLAY ──────────────────────────────────────────────────────────────
  infirmiere: {
    label: 'Roleplay infirmière',
    vocab: ['examen médical', 'patient', 'docteur', 'ausculter', 'gants en latex',
            'thermomètre rectal', 'prise de sang intime', 'protocole médical'],
    actions: [
      'Tu enfiles les gants en latex et tu commences "l\'examen"',
      'Tu lui expliques que c\'est "pour son bien"'
    ]
  },

  prof_eleve: {
    label: 'Roleplay prof/élève',
    vocab: ['élève', 'cours particulier', 'retenue', 'tableau noir', 'règle', 'punition scolaire',
            'notes', 'rester après le cours', 'examen oral'],
    actions: [
      'Le cours dérape vers quelque chose de très différent',
      'La retenue devient autre chose'
    ]
  },

  patron_secretaire: {
    label: 'Roleplay patron/secrétaire',
    vocab: ['bureau', 'patron', 'secrétaire', 'réunion', 'contrat', 'heures supplémentaires',
            'derrière la porte fermée', 'sur le bureau'],
    actions: ['La réunion tourne à l\'intime', 'Le bureau devient un lieu d\'action']
  },

  etudiant_prof: {
    label: 'Roleplay étudiant/professeure',
    vocab: ['campus', 'cours', 'amphis', 'notation', 'rattraper ses notes', 'bourse'],
    actions: ['La notation devient prétexte à autre chose']
  },

  voisin: {
    label: 'Roleplay voisin-e',
    vocab: ['voisin', 'palier', 'emprunter du sucre', 'bruit du dessus', 'mince murs'],
    actions: ['La visite de courtoisie devient une visite intime']
  },

  livreur: {
    label: 'Roleplay livreur-se',
    vocab: ['colis', 'sonnette', 'signature', 'tenue de travail', 'camion'],
    actions: ['La livraison dépasse les attentes']
  },

  // ─── SENSATIONS SPÉCIALES ──────────────────────────────────────────────────
  sensory_deprivation: {
    label: 'Privation sensorielle',
    vocab: ['bandeau sur les yeux', 'bouchons d\'oreilles', 'ne rien voir', 'ne rien entendre',
            'dépendant des autres sens', 'toucher amplifié', 'surprise'],
    actions: [
      'Tu bandes les yeux et elle ne sait plus ce qui va arriver',
      'Privée de vue, chaque toucher est décuplé'
    ]
  },

  chaud_froid: {
    label: 'Sensations chaud/froid',
    vocab: ['glaçon', 'cire chaude', 'chaud et froid', 'contraste', 'frisson', 'brûlure douce'],
    actions: [
      'Tu passes un glaçon sur ses seins puis tu souffles dessus',
      'Tu alternes glaçon et cire chaude le long de son corps'
    ]
  },

  massage: {
    label: 'Massage érotique',
    vocab: ['huile de massage', 'mains sur le corps', 'pétrir', 'caresser', 'détendre',
            'massage des fesses', 'massage intime', 'glisser sur sa peau'],
    actions: [
      'Tes mains huilées glissent sur tout son corps',
      'Le massage dérive vers quelque chose de plus intime'
    ]
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// NORMALISATION DES ENVIES
// ═══════════════════════════════════════════════════════════════════════════════

const ALIAS_MAP = {
  // bondage
  'bondage': 'bondage', 'corde': 'bondage', 'cordes': 'bondage',
  'shibari': 'bondage', 'kinbaku': 'bondage', 'attacher': 'bondage',
  'menottes': 'bondage', 'entrave': 'bondage',
  // fouet
  'fouet': 'fouet', 'cravache': 'fouet', 'martinet': 'fouet',
  'flogger': 'fouet', 'paddle': 'fouet', 'impact': 'fouet',
  // fessée
  'fessee': 'fessee', 'claques': 'fessee', 'fesse': 'fessee',
  // cire
  'cire': 'cire', 'bougie': 'cire', 'wax': 'cire',
  // humiliation
  'humiliation': 'humiliation', 'degradation': 'humiliation',
  // edge
  'edge': 'edge_play', 'orgasme denial': 'edge_play', 'denial': 'edge_play',
  // gode
  'gode': 'gode', 'godemiche': 'gode', 'dildo': 'gode', 'godemiché': 'gode',
  // gode-ceinture
  'gode ceinture': 'gode_ceinture', 'gode-ceinture': 'gode_ceinture',
  'strapon': 'gode_ceinture', 'strap-on': 'gode_ceinture', 'pegging': 'gode_ceinture',
  // plug
  'plug': 'plug', 'plug anal': 'plug', 'bouchon': 'plug',
  // vibro
  'vibromasseur': 'vibromasseur', 'vibro': 'vibromasseur', 'wand': 'vibromasseur',
  'magic wand': 'vibromasseur', 'bullet': 'vibromasseur',
  // pinces
  'pinces': 'pinces_tetons', 'pinces tetons': 'pinces_tetons', 'pinces tétons': 'pinces_tetons',
  // actes
  'sodomie': 'sodomie', 'anal': 'sodomie', 'enculer': 'sodomie',
  'fellation': 'fellation', 'pipe': 'fellation', 'sucer': 'fellation',
  'cunnilingus': 'cunnilingus', 'cunni': 'cunnilingus', 'lecher': 'cunnilingus',
  'penetration': 'penetration', 'baiser': 'penetration', 'niquer': 'penetration',
  'ejaculation': 'ejaculation', 'jouir': 'ejaculation',
  'squirt': 'squirt',
  // corps
  'pieds': 'pieds', 'pied': 'pieds', 'fetichisme pieds': 'pieds',
  'latex': 'latex', 'caoutchouc': 'latex',
  'cuir': 'cuir', 'leather': 'cuir',
  // groupes
  'trio': 'trio', 'menage a trois': 'trio', 'a trois': 'trio',
  'double penetration': 'double_penetration', 'dp': 'double_penetration',
  // roleplay
  'infirmiere': 'infirmiere', 'docteur': 'infirmiere',
  'prof': 'prof_eleve', 'eleve': 'prof_eleve',
  'patron': 'patron_secretaire', 'secretaire': 'patron_secretaire', 'bureau': 'patron_secretaire',
  'voisin': 'voisin', 'voisine': 'voisin',
  'livreur': 'livreur', 'livraison': 'livreur',
  // sensations
  'bandeau': 'sensory_deprivation', 'privation': 'sensory_deprivation',
  'glaçon': 'chaud_froid', 'glacon': 'chaud_froid', 'chaud froid': 'chaud_froid',
  'massage': 'massage', 'huile': 'massage',
};

function normaliserEnvie(envie) {
  const s = (envie || '').toLowerCase()
    .replace(/[éèê]/g, 'e').replace(/[àâ]/g, 'a').replace(/[ôö]/g, 'o')
    .replace(/[ûü]/g, 'u').replace(/[îï]/g, 'i').replace(/[-_\s]+/g, ' ')
    .trim();

  // Chercher une correspondance directe
  if (ALIAS_MAP[s]) return ALIAS_MAP[s];

  // Chercher une correspondance partielle
  for (const [key, val] of Object.entries(ALIAS_MAP)) {
    if (s.includes(key) || key.includes(s)) return val;
  }

  // Retourner normalisé si rien trouvé
  return s.replace(/\s+/g, '_');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NIVEAUX D'INTENSITÉ
// ═══════════════════════════════════════════════════════════════════════════════

const INTENSITE_LABELS = {
  1: 'très doux et romantique — aucun mot cru',
  2: 'sensuel et tendre — vocabulaire raffiné',
  3: 'explicite mais élégant',
  4: 'sans retenue mais consenti',
  5: 'franchement cru et direct — vocabulaire total',
};

// ═══════════════════════════════════════════════════════════════════════════════
// FONCTION PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════════

function vocabulaireEnvies(envies = [], genre = 'homme', intensiteMax = 3) {
  if (!envies || !Array.isArray(envies) || envies.length === 0) return '';

  const vocabs  = new Set();
  const actions = [];
  const trouvees = [];

  for (const envie of envies) {
    if (!envie) continue;
    const key = normaliserEnvie(envie);
    const pratique = PRATIQUES_CATALOGUE[key];
    if (!pratique) continue;

    trouvees.push(pratique.label);
    const nVocab = Math.min(4, intensiteMax + 1);
    pratique.vocab.slice(0, nVocab * 2).forEach(v => vocabs.add(v));
    actions.push(...pratique.actions.slice(0, 2));
  }

  if (trouvees.length === 0) return '';

  const intensiteLabel = INTENSITE_LABELS[Math.min(intensiteMax, 5)] || INTENSITE_LABELS[3];
  const genreAdapte = (genre || '').toLowerCase().includes('femme')
    ? 'corps féminin' : (genre || '').toLowerCase().includes('homme trans')
    ? 'homme trans' : 'corps masculin';

  let result = `PRATIQUES DEMANDÉES (${trouvees.join(', ')}) :\n`;
  result += `Intensité : ${intensiteLabel}\n`;
  result += `Genre : ${genreAdapte}\n`;

  if (vocabs.size > 0) {
    result += `Vocabulaire spécifique : ${[...vocabs].slice(0, 12).join(', ')}\n`;
  }
  if (actions.length > 0) {
    const uniqueActions = [...new Set(actions)].slice(0, 6);
    result += `Actions appropriées :\n${uniqueActions.map(a => `• ${a}`).join('\n')}\n`;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = { vocabulaireEnvies, PRATIQUES_CATALOGUE, normaliserEnvie };
