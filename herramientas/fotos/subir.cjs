/*
 * Sube al portal las fotos que dejó preparar.py.
 *
 * Entra por la misma puerta que el panel —la cuenta de administrador y la ruta
 * de subida de fotos—, así que sirve igual para la copia local y para Railway,
 * y respeta las mismas reglas: el tope por producto, los tipos de archivo, y
 * que el color exista en ese producto.
 *
 * Anota lo que ya subió en la carpeta preparada. Si se corta a la mitad —se cae
 * la conexión, se cierra la computadora—, volver a correrlo sigue donde quedó
 * en vez de duplicar las fotos que ya estaban.
 *
 * Uso:  node herramientas/fotos/subir.cjs CARPETA --api https://tu-dominio [--solo SKU,…] [--menos SKU,…]
 *       (usa ADMIN_EMAIL y ADMIN_PASSWORD del .env o del entorno)
 */
require('../../src/entorno').cargarEnv();
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const carpeta = args[0];
const i = args.indexOf('--api');
const api = i === -1 ? '' : String(args[i + 1] || '').replace(/\/+$/, '');
if (!carpeta || !api) {
  console.error('Uso: node herramientas/fotos/subir.cjs CARPETA --api https://tu-dominio');
  process.exit(1);
}
// --solo A,B sube sólo esos productos; --menos A,B sube todos menos esos.
const lista = (flag) => {
  const k = args.indexOf(flag);
  return k === -1 ? null : String(args[k + 1] || '').split(',').map((x) => x.trim()).filter(Boolean);
};
const solo = lista('--solo');
const menos = lista('--menos') || [];
const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
if (!email || !password) {
  console.error('Faltan ADMIN_EMAIL y ADMIN_PASSWORD (en el .env o por delante del comando).');
  process.exit(1);
}

const manifiesto = JSON.parse(fs.readFileSync(path.join(carpeta, 'manifiesto.json'), 'utf8'));
const archivoEstado = path.join(carpeta, 'subidas.json');
const estado = fs.existsSync(archivoEstado) ? JSON.parse(fs.readFileSync(archivoEstado, 'utf8')) : {};
const guardar = () => fs.writeFileSync(archivoEstado, JSON.stringify(estado, null, 1));

let cookie = '';
async function pedir(ruta, op = {}) {
  const r = await fetch(api + ruta, { ...op, headers: { ...(op.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  let json = null;
  try { json = await r.json(); } catch { /* sin cuerpo */ }
  return { status: r.status, json };
}

(async () => {
  const entrar = await pedir('/api/sesion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (entrar.status !== 200 || entrar.json?.rol !== 'admin') {
    console.error(`No pude entrar como administrador en ${api}: ${entrar.status} ${entrar.json?.message || ''}`);
    process.exit(1);
  }

  let subidas = 0; let yaEstaban = 0; let problemas = 0;
  for (const [sku, fotos] of Object.entries(manifiesto.productos)) {
    if ((solo && !solo.includes(sku)) || menos.includes(sku)) continue;
    const det = await pedir(`/api/admin/productos/${encodeURIComponent(sku)}`);
    if (det.status !== 200) {
      console.log(`  ✖ ${sku}: no existe en ${api}`);
      problemas += fotos.length;
      continue;
    }
    const idDe = Object.fromEntries((det.json.colores || []).map((c) => [c.nombre, c.id]));
    let enEste = 0;
    for (const f of fotos) {
      const clave = `${api}|${sku}|${f.md5}`;
      if (estado[clave]) { yaEstaban += 1; continue; }
      const fd = new FormData();
      fd.append('foto', new Blob([fs.readFileSync(path.join(carpeta, f.archivo))], { type: 'image/jpeg' }), path.basename(f.archivo));
      /*
       * El color se busca por nombre en ESTE servidor: el número de un color
       * en la base local no es el mismo que en Railway.
       */
      if (f.color && idDe[f.color]) fd.append('colorId', String(idDe[f.color]));
      else if (f.color) console.log(`  · ${sku}: ${f.color} no está en este producto, va como foto general`);
      const r = await pedir(`/api/admin/productos/${encodeURIComponent(sku)}/fotos`, { method: 'POST', body: fd });
      if (r.status === 200) {
        estado[clave] = r.json.ruta; guardar(); subidas += 1; enEste += 1;
      } else {
        problemas += 1;
        console.log(`  ✖ ${sku} ${f.archivo}: ${r.status} ${r.json?.message || ''}`);
        if (/máximo/i.test(r.json?.message || '')) break;   // lleno: las que siguen tampoco entran
      }
    }
    if (enEste) console.log(`  ${sku}: ${enEste} subidas`);
  }
  console.log(`\nListo: ${subidas} subidas, ${yaEstaban} ya estaban, ${problemas} con problema.`);
})();
