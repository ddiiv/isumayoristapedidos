const { db, ordenDeTalle } = require('./db');
const colores = require('./colores');

/*
 * Pone en orden lo que llega del catálogo real.
 *
 * La planilla la cargan personas distintas a lo largo de meses, así que el
 * mismo color aparece escrito de cuatro formas y los talles mezclan mayúsculas.
 * Esto no "arregla la planilla": construye las tablas de colores y talles con
 * un nombre canónico cada uno, y apunta cada variante al suyo.
 *
 * El texto original de la variante NO se toca. Si un alias resulta estar mal,
 * se corrige el mapa y todo se reacomoda; reescribiendo el dato, el error
 * quedaría grabado sin nada con qué volver atrás.
 */

// Talles de chico: en la planilla vienen como números sueltos.
const TALLES_NINO = new Set(['2', '4', '6', '8', '10', '12', '14', '16', '18']);

function canonicoDeTalle(bruto) {
  const t = String(bruto || '').trim().toUpperCase();
  if (!t) return { nombre: 'Único', grupo: 'adulto' };
  if (t === 'UNICO' || t === 'ÚNICO') return { nombre: 'Único', grupo: 'adulto' };
  // "2xl" y "2XL" son el mismo talle; el segundo es el que se muestra.
  if (/^\d?X{1,3}L$/.test(t) || ['XS', 'S', 'M', 'L'].includes(t)) {
    return { nombre: t, grupo: 'adulto' };
  }
  if (TALLES_NINO.has(t)) return { nombre: t, grupo: 'nino' };
  return { nombre: t, grupo: 'adulto' };
}

function normalizarTodo() {
  const resumen = { colores: 0, talles: 0, variantes: 0, categoriasUnidas: 0, ofertaQuitada: 0 };

  const verColor = db.prepare('SELECT id FROM colores WHERE nombre = ?');
  const nuevoColor = db.prepare(
    'INSERT INTO colores (nombre, hex, provisorio, orden) VALUES (?, ?, 1, ?)',
  );
  const verTalle = db.prepare('SELECT id FROM talles WHERE nombre = ?');
  const nuevoTalle = db.prepare('INSERT INTO talles (nombre, grupo, orden) VALUES (?, ?, ?)');
  const atarVariante = db.prepare('UPDATE variantes SET color_id = ?, talle_id = ? WHERE id = ?');

  const correr = db.transaction(() => {
    const variantes = db.prepare('SELECT id, color, talle FROM variantes').all();

    for (const v of variantes) {
      // ── color
      const nombreColor = colores.canonico(v.color) || 'Único';
      let color = verColor.get(nombreColor);
      if (!color) {
        const hex = colores.hexSugerido(nombreColor) || colores.hexDerivado(nombreColor);
        nuevoColor.run(nombreColor, hex, 0);
        color = verColor.get(nombreColor);
        resumen.colores += 1;
      }

      // ── talle
      const { nombre: nombreTalle, grupo } = canonicoDeTalle(v.talle);
      let talle = verTalle.get(nombreTalle);
      if (!talle) {
        nuevoTalle.run(nombreTalle, grupo, ordenDeTalle(nombreTalle));
        talle = verTalle.get(nombreTalle);
        resumen.talles += 1;
      }

      atarVariante.run(color.id, talle.id, v.id);
      resumen.variantes += 1;
    }

    // Los colores se ordenan como se leen: primero los neutros, después el resto.
    db.prepare(`UPDATE colores SET orden = (
      SELECT COUNT(*) FROM variantes v WHERE v.color_id = colores.id
    ) * -1`).run();
  });

  correr();
  return resumen;
}

/*
 * Une categorías escritas de más de una forma.
 *
 * "Panalones" al lado de "Pantalones" no es una categoría: es un tipeo, y
 * aparece como una pestaña con un producto adentro. Se unen las que son
 * claramente la misma palabra —ignorando mayúsculas, acentos y el plural—; lo
 * que no sea evidente se deja como está y se une a mano desde el panel, que es
 * donde se puede ver lo que se está haciendo.
 */
function unirCategoriasParecidas() {
  /*
   * El plural se saca como `es` o `s`, en ese orden.
   *
   * Sacando sólo la `s`, "pantalones" queda en "pantalone" y no coincide con
   * "pantalon": el singular y el plural terminan en grupos distintos y la
   * unión no pasa. Es exactamente el caso que esto viene a resolver.
   */
  const raiz = (n) => colores.plano(n)
    .replace(/[^a-z ]/g, '')      // signos y números
    .trim()
    .replace(/es$/, '')
    .replace(/s$/, '')
    .replace(/ /g, '');

  // Errores de tipeo conocidos del catálogo, que la raíz sola no junta.
  const CORRECCIONES = { panalone: 'pantalon', panalon: 'pantalon' };

  const categorias = db.prepare('SELECT * FROM categorias').all();
  const grupos = new Map();
  for (const c of categorias) {
    const r0 = raiz(c.nombre);
    const r = CORRECCIONES[r0] || r0;
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r).push(c);
  }

  let unidas = 0;
  const correr = db.transaction(() => {
    for (const lista of grupos.values()) {
      if (lista.length < 2) continue;
      /*
       * Gana la que más productos tiene, y a igualdad la mejor escrita.
       *
       * Es la que la gente viene usando: quedarse con la de un producto
       * renombraría veintitrés en lugar de uno.
       */
      const conCuenta = lista.map((c) => ({
        ...c,
        n: db.prepare('SELECT COUNT(*) n FROM productos WHERE categoria_id = ?').get(c.id).n,
      })).sort((a, b) => b.n - a.n || b.nombre.length - a.nombre.length);

      const destino = conCuenta[0];
      for (const otra of conCuenta.slice(1)) {
        db.prepare('UPDATE productos SET categoria_id = ? WHERE categoria_id = ?').run(destino.id, otra.id);
        db.prepare('DELETE FROM categorias WHERE id = ?').run(otra.id);
        unidas += 1;
      }
    }
  });
  correr();
  return unidas;
}

/*
 * Saca del catálogo mayorista la categoría OFERTA y sus productos.
 *
 * No es una categoría de prendas: son tres importes sueltos ("8MIL", "15MIL")
 * cargados como si fueran talles. En un catálogo donde se pide por color y
 * talle, no hay forma de que eso signifique algo.
 */
function quitarOferta() {
  /*
   * Se van por dos caminos: la categoría OFERTA, y los productos que dicen
   * OFERTA en el título aunque estén en otra categoría ("Baggy OFERTA 18mil",
   * cargado en Pantalones). El precio va en el nombre porque son liquidaciones
   * puntuales, no artículos del catálogo mayorista.
   */
  const productos = db.prepare(`
    SELECT p.id FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE UPPER(c.nombre) = 'OFERTA' OR UPPER(p.titulo) LIKE '%OFERTA%'`).all();

  const correr = db.transaction(() => {
    for (const p of productos) {
      db.prepare('DELETE FROM variantes WHERE producto_id = ?').run(p.id);
      db.prepare('DELETE FROM fotos_color WHERE producto_id = ?').run(p.id);
      db.prepare('DELETE FROM productos WHERE id = ?').run(p.id);
    }
    // Y la categoría, ahora que quedó sin nada adentro.
    db.prepare("DELETE FROM categorias WHERE UPPER(nombre) = 'OFERTA'").run();
    // Cualquier otra que haya quedado vacía tampoco tiene por qué figurar:
    // una pestaña que no muestra nada es una pestaña que frustra.
    db.prepare(`DELETE FROM categorias WHERE id NOT IN (
      SELECT DISTINCT categoria_id FROM productos WHERE categoria_id IS NOT NULL)`).run();
  });
  correr();
  return productos.length;
}

/** Todo junto: lo que corre después de cada importación. */
function ordenarCatalogo() {
  const ofertaQuitada = quitarOferta();
  const categoriasUnidas = unirCategoriasParecidas();
  const resumen = normalizarTodo();
  return { ...resumen, categoriasUnidas, ofertaQuitada };
}

module.exports = { ordenarCatalogo, normalizarTodo, unirCategoriasParecidas, quitarOferta, canonicoDeTalle };
