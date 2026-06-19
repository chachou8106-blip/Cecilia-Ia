/* ══════════════════════════════════════════════════════════════════════════════
   ÉLISSIA v8 — GÉNÉRATEUR VIDÉO GRATUIT LOCAL
   Utilise FFmpeg (gratuit) + images ComfyUI déjà générées
   À placer à la RACINE du projet : Elissia/video_generator.js
   ══════════════════════════════════════════════════════════════════════════════
   
   INSTALLATION :
   1. Installer FFmpeg : https://ffmpeg.org/download.html
      Windows : télécharger le zip, extraire, ajouter au PATH
      Ou via npm : npm install fluent-ffmpeg @ffmpeg-installer/ffmpeg
   
   2. Ajouter dans package.json sous "dependencies" :
      "fluent-ffmpeg": "^2.1.2",
      "@ffmpeg-installer/ffmpeg": "^1.1.0"
   
   3. Dans server.js, ajouter en haut :
      const videoGen = require('./video_generator');
   
   4. La route /api/generate/video utilisera ce module automatiquement
   ══════════════════════════════════════════════════════════════════════════════ */

'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// Détection FFmpeg
let ffmpeg, ffmpegPath;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log('[VideoGen] FFmpeg trouvé :', ffmpegPath);
} catch(e) {
  // Essayer FFmpeg système
  try {
    ffmpeg = require('fluent-ffmpeg');
    console.log('[VideoGen] FFmpeg système utilisé');
  } catch {
    console.warn('[VideoGen] FFmpeg non disponible — installez fluent-ffmpeg');
    ffmpeg = null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TYPES DE VIDÉO DISPONIBLES
// ══════════════════════════════════════════════════════════════════════════════

const VIDEO_TYPES = {
  // Zoom lent sur une image (Ken Burns effect)
  zoom_in: {
    label: 'Zoom doux',
    duration: 8,
    fps: 30,
    description: 'Zoom lent et sensuel sur la photo'
  },
  // Fondu entre plusieurs images
  slideshow: {
    label: 'Diaporama',
    duration: 12,
    fps: 24,
    description: 'Enchaînement de photos avec fondus'
  },
  // Image avec effet de pulsation
  pulse: {
    label: 'Pulsation',
    duration: 6,
    fps: 30,
    description: 'Effet pulsation sur la photo'
  },
  // Panneau horizontal (reveal de gauche à droite)
  reveal: {
    label: 'Révélation',
    duration: 5,
    fps: 30,
    description: 'Révélation progressive de gauche à droite'
  },
  // Vidéo courte pour message (3 secondes)
  short: {
    label: 'Message court',
    duration: 3,
    fps: 24,
    description: 'Courte vidéo pour bulle de message'
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// GÉNÉRATEUR PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

async function generateVideo(opts = {}) {
  const {
    inputImages = [],   // Chemins vers les images (depuis uploads/)
    type        = 'zoom_in',
    outputDir   = path.join(__dirname, 'uploads'),
    width       = 512,
    height      = 768,
    userId      = 'anon'
  } = opts;

  if (!ffmpeg) {
    return { ok: false, error: 'FFmpeg non installé. Lancez : npm install fluent-ffmpeg @ffmpeg-installer/ffmpeg' };
  }

  if (!inputImages.length) {
    return { ok: false, error: 'Aucune image fournie pour la vidéo' };
  }

  const videoConfig = VIDEO_TYPES[type] || VIDEO_TYPES.zoom_in;
  const outputName  = `vid_${userId}_${Date.now()}.mp4`;
  const outputPath  = path.join(outputDir, outputName);
  const outputUrl   = `/uploads/${outputName}`;

  try {
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg();

      if (inputImages.length === 1) {
        // ── MODE UNE SEULE IMAGE — animations CSS ──────────────────────────
        const img = inputImages[0];
        cmd.input(img).inputOptions([`-loop 1`, `-t ${videoConfig.duration}`]);

        let vf;
        switch(type) {
          case 'zoom_in':
            // Ken Burns : zoom de 1.0 à 1.15 sur la durée
            vf = `scale=${width * 2}:${height * 2},zoompan=z='min(zoom+0.001,1.15)':d=${videoConfig.duration * videoConfig.fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height},fps=${videoConfig.fps}`;
            break;
          case 'pulse':
            // Zoom in/out en boucle
            vf = `scale=${width * 2}:${height * 2},zoompan=z='1+0.05*sin(2*PI*t/2)':d=${videoConfig.duration * videoConfig.fps}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height},fps=${videoConfig.fps}`;
            break;
          case 'reveal':
            // Panneau de gauche à droite
            vf = `scale=${width}:${height},crop='min(iw*t/${videoConfig.duration},iw)':ih:0:0,pad=${width}:${height},fps=${videoConfig.fps}`;
            break;
          default:
            vf = `scale=${width}:${height},fps=${videoConfig.fps}`;
        }

        cmd
          .videoFilter(vf)
          .outputOptions([
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-movflags +faststart',
            `-t ${videoConfig.duration}`
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();

      } else {
        // ── MODE PLUSIEURS IMAGES — slideshow avec fondus ──────────────────
        const tempDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'elissia_vid_'));
        const listFile = path.join(tempDir, 'list.txt');
        const duration = Math.max(2, Math.floor(videoConfig.duration / inputImages.length));

        // Créer le fichier de liste FFmpeg
        const listContent = inputImages.map(img =>
          `file '${img.replace(/'/g, "'\\''")}'
duration ${duration}`
        ).join('\n') + `\nfile '${inputImages[inputImages.length-1].replace(/'/g, "'\\''")}'`;
        
        fs.writeFileSync(listFile, listContent);

        cmd
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .videoFilter([
            `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
            `fps=${videoConfig.fps}`,
            // Fondu enchaîné entre les images
            `xfade=transition=dissolve:duration=0.5:offset=${duration - 0.5}`
          ].join(','))
          .outputOptions([
            '-c:v libx264',
            '-preset fast',
            '-crf 23',
            '-pix_fmt yuv420p',
            '-movflags +faststart'
          ])
          .output(outputPath)
          .on('end', () => {
            // Nettoyer le temp
            try { fs.rmSync(tempDir, { recursive: true }); } catch {}
            resolve();
          })
          .on('error', (err) => {
            try { fs.rmSync(tempDir, { recursive: true }); } catch {}
            reject(err);
          })
          .run();
      }
    });

    const stats = fs.statSync(outputPath);
    console.log(`[VideoGen] ✅ ${outputName} (${Math.round(stats.size/1024)}KB)`);

    return {
      ok:         true,
      video_url:  outputUrl,
      type:       type,
      label:      videoConfig.label,
      duration:   videoConfig.duration,
      size_kb:    Math.round(stats.size / 1024)
    };

  } catch(e) {
    console.error('[VideoGen] Erreur:', e.message);
    // Nettoyer si le fichier partiel existe
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
    return { ok: false, error: e.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE EXPRESS À INTÉGRER DANS SERVER.JS
// ══════════════════════════════════════════════════════════════════════════════
//
// Ajouter dans server.js (remplace la route /api/generate/video existante) :
//
// const videoGen = require('./video_generator');
// 
// app.post("/api/generate/video", requireAuth, requireCsrf, rateLimit("genvid",5,3600000), async (req,res) => {
//   const { type = 'zoom_in', image_url, nb_images = 1 } = req.body;
//   
//   // Utiliser l'avatar existant ou générer une nouvelle image
//   const freshUser = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
//   const u = publicUser(freshUser);
//   const ext = u.extendedProfile || {};
//   
//   // Trouver les images disponibles
//   let imagePaths = [];
//   
//   if (image_url) {
//     const localPath = path.join(__dirname, image_url.replace('/uploads/', 'uploads/'));
//     if (fs.existsSync(localPath)) imagePaths.push(localPath);
//   }
//   
//   // Si pas d'image fournie, utiliser les dernières générées
//   if (!imagePaths.length) {
//     const recentPhotos = db.prepare(
//       "SELECT filename FROM media_library WHERE user_id=? AND source='ai_generated' ORDER BY rowid DESC LIMIT ?"
//     ).all(req.user.id, nb_images);
//     
//     imagePaths = recentPhotos
//       .map(p => path.join(__dirname, p.filename.replace('/uploads/', 'uploads/')))
//       .filter(p => fs.existsSync(p));
//   }
//   
//   // Fallback : générer une image d'abord
//   if (!imagePaths.length) {
//     const imgResult = await comfyGenerateImage(buildComfyPrompt(ext, 'sensuelle'), 'sensuelle', null);
//     if (imgResult) {
//       const localPath = path.join(__dirname, imgResult.replace('/uploads/', 'uploads/'));
//       if (fs.existsSync(localPath)) imagePaths.push(localPath);
//     }
//   }
//   
//   if (!imagePaths.length) {
//     return res.status(400).json({ ok: false, error: 'Aucune image disponible pour générer la vidéo' });
//   }
//   
//   const result = await videoGen.generateVideo({
//     inputImages: imagePaths,
//     type,
//     outputDir: path.join(__dirname, 'uploads'),
//     userId: req.user.id
//   });
//   
//   if (result.ok) {
//     // Enregistrer en base
//     try {
//       db.prepare("INSERT OR IGNORE INTO media_library(id,user_id,filename,mime_type,source,created_at) VALUES(?,?,?,?,?,?)")
//         .run(id(), req.user.id, result.video_url, 'video/mp4', 'ai_generated', now());
//     } catch {}
//     res.json(result);
//   } else {
//     res.status(500).json(result);
//   }
// });

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = { generateVideo, VIDEO_TYPES };
