const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');

/*
 * Copias de la base, una por día, las últimas siete, dentro del volumen.
 *
 * Cubren lo que más pasa: un pedido borrado sin querer, una importación que
 * pisó precios, una base que quedó mal. No cubren perder el volumen entero:
 * para eso está «Descargar respaldo» en el panel (GET /api/admin/respaldo),
 * que baja una copia al momento para guardarla fuera de Railway.
 *
 * `db.backup` copia en caliente y consistente con el WAL: copiar el archivo
 * .db a mano mientras el portal escribe puede dar una base rota.
 */
const DIR = path.join(DATA_DIR, 'respaldos');
const GUARDAR = 7;

async function respaldar(nombre = `isuwaya-${new Date().toISOString().slice(0, 10)}.db`) {
  fs.mkdirSync(DIR, { recursive: true });
  const destino = path.join(DIR, nombre);
  await db.backup(destino);
  return destino;
}

/** Los diarios que sobran (los más viejos); cualquier otro archivo de la carpeta no se toca. */
const vencidos = (nombres, guardar = GUARDAR) => {
  const diarios = nombres.filter((f) => /^isuwaya-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  return diarios.slice(0, Math.max(0, diarios.length - guardar));
};
assert.deepEqual(vencidos(['isuwaya-2026-01-03.db', 'otro.db', 'isuwaya-2026-01-01.db', 'isuwaya-2026-01-02.db'], 2), ['isuwaya-2026-01-01.db']);

function podar() {
  for (const f of vencidos(fs.readdirSync(DIR))) fs.rmSync(path.join(DIR, f), { force: true });
}

async function respaldoDiario() {
  try { await respaldar(); podar(); } catch (e) { console.error('  respaldo:', e.message); }
}

module.exports = { respaldar, respaldoDiario };
