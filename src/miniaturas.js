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

const nombreMiniatura = (archivo) => `${path.parse(path.basename(archivo)).name}-min.webp`;

/*
 * Las fotos cargadas antes de que existieran las miniaturas se completan
 * solas al arrancar, en segundo plano.
 *
 * Así no hay que acordarse de correr nada en Railway: el primer arranque con
 * esto las genera, y los siguientes no encuentran ninguna pendiente. Van de a
 * una, para no quitarle el procesador a quien está haciendo un pedido.
 */
async function completarMiniaturas() {
  const pendientes = db.prepare('SELECT id, ruta FROM fotos WHERE miniatura IS NULL').all();
  if (!pendientes.length) return;
  const poner = db.prepare('UPDATE fotos SET miniatura = ? WHERE id = ?');
  let hechas = 0;
  let fallas = 0;
  for (const f of pendientes) {
    try {
      const original = fs.readFileSync(path.join(FOTOS_DIR, path.basename(f.ruta)));
      const nombre = nombreMiniatura(f.ruta);
      fs.writeFileSync(path.join(FOTOS_DIR, nombre), await hacerMiniatura(original));
      poner.run(`/fotos/${nombre}`, f.id);
      hechas += 1;
    } catch {
      // Sin miniatura la pantalla usa la foto entera: se ve igual, sólo pesa más.
      fallas += 1;
    }
  }
  console.log(`  miniaturas: ${hechas} hechas${fallas ? `, ${fallas} no se pudieron (se usa la foto entera)` : ''}`);
}

module.exports = { hacerMiniatura, nombreMiniatura, completarMiniaturas };
