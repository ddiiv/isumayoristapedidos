const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { db, FOTOS_DIR } = require('./db');

/*
 * Miniaturas de las fotos.
 *
 * La tira de miniaturas del panel mostraba las fotos enteras achicadas por el
 * navegador: cada cuadradito de cincuenta píxeles bajaba una foto de 1440×1920
 * de unos 100 KB. Con cincuenta fotos por producto, en un teléfono con
 * datos la tira quedaba en gris un buen rato. La miniatura es la misma foto a
 * 240×320 —el doble de lo que se ve, para que siga nítida en pantallas
 * densas— y pesa unos 5 KB.
 */
const ANCHO = 240;
const ALTO = 320;

/*
 * Y una mediana, para todo lo demás.
 *
 * La foto de cada fila del catálogo y la grande del panel bajaban también el
 * original de 1280×1920, que llega a medio mega, para mostrarse de 120 a 380
 * píxeles de ancho. A 720×1080 sigue nítida en la pantalla de un teléfono de
 * densidad 3 y pesa una fracción. El original queda guardado igual.
 */
const ANCHO_MEDIA = 720;
const ALTO_MEDIA = 1080;

/**
 * La miniatura de una imagen. Si sharp no la puede abrir, no es una imagen
 * aunque el navegador haya dicho que sí: tira error, y quien sube lo rechaza.
 */
function hacerMiniatura(buffer) {
  return sharp(buffer)
    .rotate()   // respeta la orientación que guardó la cámara
    .resize(ANCHO, ALTO, { fit: 'cover', position: 'top', withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
}

/** La versión mediana: la foto entera, sin recortar, a lo sumo de 720×1080. */
function hacerMedia(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(ANCHO_MEDIA, ALTO_MEDIA, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 76 })
    .toBuffer();
}

const nombreMiniatura = (archivo) => `${path.parse(path.basename(archivo)).name}-min.webp`;
const nombreMedia = (archivo) => `${path.parse(path.basename(archivo)).name}-med.webp`;

/*
 * Las fotos cargadas antes de que existieran estas versiones se completan
 * solas al arrancar, en segundo plano.
 *
 * Así no hay que acordarse de correr nada en Railway: el primer arranque con
 * esto las genera, y los siguientes no encuentran ninguna pendiente. Van de a
 * una, para no quitarle el procesador a quien está haciendo un pedido.
 */
async function completarMiniaturas() {
  const pendientes = db.prepare('SELECT id, ruta, miniatura, media FROM fotos WHERE miniatura IS NULL OR media IS NULL').all();
  if (!pendientes.length) return;
  const ponerMini = db.prepare('UPDATE fotos SET miniatura = ? WHERE id = ?');
  const ponerMedia = db.prepare('UPDATE fotos SET media = ? WHERE id = ?');
  let hechas = 0;
  let fallas = 0;
  for (const f of pendientes) {
    try {
      const original = fs.readFileSync(path.join(FOTOS_DIR, path.basename(f.ruta)));
      if (!f.miniatura) {
        const nombre = nombreMiniatura(f.ruta);
        fs.writeFileSync(path.join(FOTOS_DIR, nombre), await hacerMiniatura(original));
        ponerMini.run(`/fotos/${nombre}`, f.id);
      }
      if (!f.media) {
        const nombre = nombreMedia(f.ruta);
        fs.writeFileSync(path.join(FOTOS_DIR, nombre), await hacerMedia(original));
        ponerMedia.run(`/fotos/${nombre}`, f.id);
      }
      hechas += 1;
    } catch {
      // Sin estas versiones la pantalla usa la foto entera: se ve igual, sólo pesa más.
      fallas += 1;
    }
  }
  console.log(`  versiones chicas de las fotos: ${hechas} hechas${fallas ? `, ${fallas} no se pudieron (se usa la foto entera)` : ''}`);
}

module.exports = { hacerMiniatura, hacerMedia, nombreMiniatura, nombreMedia, completarMiniaturas };
