/*
 * Fotos y guías de talles desde la tienda online (isu).
 *
 * Precios, variantes y stock vienen de STOCKER. Las fotos y las guías de
 * talles se cargan en el backoffice de la tienda, que es el que mejor las
 * maneja: acá se leen de ahí cada minuto y quedan en memoria. El
 * catálogo no espera a la tienda, y si ella no contesta se ven las fotos
 * propias, como antes.
 *
 * Lo propio manda: un producto con «fotos propias» marcado en el panel, o con
 * una guía cargada acá, muestra lo suyo. Si no, lo de la tienda.
 */
const URL_BASE = (process.env.ISU_API_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.ISU_TOKEN || '';
// El dominio público de las fotos de la tienda (R2). Sin valor por omisión: uno equivocado deja el catálogo sin fotos.
const URL_FOTOS = (process.env.ISU_FOTOS_URL || '').replace(/\/+$/, '');
// Cada minuto: la tienda borra el archivo de una foto un minuto después de sacarla, y acá no tiene que quedar apuntando a él.
const CADA = 60_000;
// La misma forma de clave que acepta el almacén de la tienda: nada que arme una URL a otro lado.
const CLAVE = /^p\/(\d{1,9}|[a-f0-9]{12})\/[a-z0-9]{8,40}$/;

let porSku = new Map();
let porVariante = new Map();

const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const texto = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/** La guía de la tienda (medidas con rango en cm) con la forma de las de acá: columnas y una fila por talle. */
function guiaDeLaTienda(g) {
  if (!g || !Array.isArray(g.medidas) || !Array.isArray(g.filas) || !g.filas.length) return null;
  const columnas = g.medidas.slice(0, 8).map((m) => texto(m?.nombre, 40) || '—');
  const cm = (r) => (Array.isArray(r) && r.every(Number.isFinite) ? (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`) : '—');
  const filas = g.filas.slice(0, 20).map((f) => Object.fromEntries([
    ['talle', texto(f?.talle, 10) || '—'],
    ...columnas.map((c, i) => [c, cm(f?.valores?.[i])]),
  ]));
  // Las de la tienda mezclan medidas del cuerpo y de la prenda: el pie de las de acá no les va.
  return { columnas, filas, nota: texto(g.nota, 500), pie: 'Medidas en centímetros.' };
}

/**
 * Las fotos de la tienda con la forma de las de acá. El color se cruza por
 * los SKU de las variantes (son los de STOCKER, los mismos en los dos
 * lados) y, si no, por el nombre; una foto de un color que acá no está
 * queda como foto general.
 */
function fotosDeLaTienda(entrada, combinaciones) {
  const colorDeSku = new Map(combinaciones.map((c) => [c.sku, c.color]));
  const colorDeNombre = new Map(combinaciones.map((c) => [normal(c.color), c.color]));
  const url = (clave, ancho) => `${URL_FOTOS}/${clave}-${ancho}.webp`;
  return entrada.fotos.map((f) => ({
    ruta: url(f.clave, 1200),
    media: url(f.clave, 800),
    miniatura: url(f.clave, 400),
    color: f.color ? (f.skus.map((s) => colorDeSku.get(s)).find(Boolean) || colorDeNombre.get(normal(f.color)) || null) : null,
  }));
}

async function actualizar() {
  const r = await fetch(`${URL_BASE}/v1/interno/catalogo-mayorista`, {
    // Sin seguir redirecciones: la credencial no tiene que viajar a otro lado.
    headers: { 'x-isu-mayorista': TOKEN }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`la tienda contestó ${r.status}`);
  const { productos } = await r.json();
  if (!Array.isArray(productos)) throw new Error('la respuesta no trae productos');
  const nuevo = new Map();
  const variantes = new Map();
  const textos = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  for (const p of productos) {
    // Sin importar mayúsculas, como el importador de la tienda.
    const sku = typeof p?.sku === 'string' ? p.sku.toUpperCase() : null;
    if (!sku || nuevo.has(sku)) continue;
    const fotos = (Array.isArray(p.fotos) ? p.fotos : [])
      .filter((f) => typeof f?.clave === 'string' && CLAVE.test(f.clave))
      .map((f) => ({ clave: f.clave, color: texto(f.color, 60), skus: textos(f.skus) }));
    const entrada = { fotos, guia: guiaDeLaTienda(p.guia) };
    nuevo.set(sku, entrada);
    // Una variante en dos productos de la tienda no sirve para enganchar.
    for (const v of textos(p.variantes)) variantes.set(v.toUpperCase(), variantes.has(v.toUpperCase()) ? null : entrada);
  }
  // Si las fotos de muestra no se ven (ISU_FOTOS_URL mal puesto), mejor las fotos propias que el catálogo sin fotos.
  // Tres de productos distintos: un archivo que falte en la tienda no apaga todo.
  const muestras = [...nuevo.values()].filter((p) => p.fotos.length).slice(0, 3).map((p) => p.fotos[0]);
  const seVe = (f) => fetch(`${URL_FOTOS}/${f.clave}-400.webp`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) }).then((x) => x.ok, () => false);
  if (muestras.length && !(await Promise.all(muestras.map(seVe))).some(Boolean)) {
    for (const p of nuevo.values()) p.fotos = [];
    console.error(`  tienda: las fotos no se ven en ${URL_FOTOS} (¿ISU_FOTOS_URL?): se muestran las propias`);
  }
  porSku = nuevo;
  porVariante = variantes;
  return nuevo.size;
}

function iniciar() {
  const faltan = ['ISU_API_URL', 'ISU_TOKEN', 'ISU_FOTOS_URL'].filter((v) => !process.env[v]);
  if (faltan.length) {
    console.log(`  tienda: falta ${faltan.join(', ')} — se usan sólo las fotos y guías propias`);
    return;
  }
  const ir = () => actualizar().catch((e) => console.error('  tienda:', e.message));
  ir();
  setInterval(ir, CADA).unref();
}

/**
 * Lo que la tienda tiene de ese producto (fotos y guía), o null. Por SKU
 * padre y, si no coincide, por los SKU de sus variantes (todas del mismo
 * producto de la tienda), como engancha el importador.
 */
function de(sku, skusVariantes = []) {
  const directo = porSku.get(String(sku || '').toUpperCase());
  if (directo) return directo;
  const encontrados = new Set(skusVariantes.map((s) => porVariante.get(String(s).toUpperCase())));
  return encontrados.size === 1 ? [...encontrados][0] || null : null;
}

/** Si están las tres variables: la lectura de la tienda está prendida. */
const activa = () => Boolean(URL_BASE && TOKEN && URL_FOTOS);

/** El origen de las fotos de la tienda, para la política de seguridad de las páginas. */
function origenFotos() {
  try {
    const u = new URL(URL_FOTOS);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { return null; }
}

module.exports = { iniciar, actualizar, de, activa, fotosDeLaTienda, guiaDeLaTienda, origenFotos };
