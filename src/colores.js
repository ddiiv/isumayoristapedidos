/*
 * Colores: un nombre canónico, un hex, y los alias con los que llegan.
 *
 * El catálogo real trae el mismo color escrito de varias formas —"Negro",
 * "Negra", "Nero", "Nego"— porque lo carga gente distinta en momentos
 * distintos. Sin unificar, el cliente ve cuatro cuadritos del mismo negro y la
 * matriz de talles se parte en cuatro filas que son una sola.
 *
 * Se unifican por alias y NO se toca el texto original de la variante: si un
 * alias resulta estar mal, se corrige el mapa y el catálogo se acomoda solo. Si
 * se reescribiera el dato, el error quedaría grabado y no habría con qué volver.
 *
 * Los hex son PROVISORIOS: son una aproximación al nombre para que la pantalla
 * no arranque en gris. Se editan desde el panel, con la muestra al lado.
 */

/*
 * Los veinte colores oficiales de ISUWAYA.
 *
 * Son los que están cargados como valores del atributo "Color" en STOCKER, con
 * SU ortografía: "Beish" y no "Beige", "Melang" y no "Melange", "Bordo" sin
 * tilde. Corregirles la escritura sería inventar un nombre que no usa nadie del
 * negocio, y el día que alguien busque "Beish" en el panel no lo encuentra.
 *
 * Los hex son PROVISORIOS: aproximan el nombre para que la pantalla no arranque
 * en gris. Se editan desde el panel, con la muestra al lado.
 */
const OFICIALES = [
  'Beish', 'Negro', 'Verde', 'Rojo', 'Blanco', 'Melang', 'Topo', 'Violeta',
  'Chocolate', 'Bordo', 'Amarillo', 'Crema', 'Azul', 'Dulce de Leche', 'Uva',
  'Salmon', 'Olivo', 'Celeste', 'Aero', 'Naranja',
];

// canónico → [hex provisorio, ...alias]
const CANON = {
  // ── Los veinte oficiales
  'Negro':            ['#111111', 'negra', 'nero', 'nego'],
  'Blanco':           ['#FFFFFF', 'blanca'],
  'Crema':            ['#F3EADA'],
  'Beish':            ['#E4D5BE', 'beis', 'beige'],
  'Topo':             ['#8C8075'],
  'Melang':           ['#B5B5B5', 'melange'],
  'Chocolate':        ['#4E342A', 'choco'],
  'Dulce de Leche':   ['#C08A55'],
  'Azul':             ['#2F5597'],
  'Celeste':          ['#8FC1E3'],
  'Aero':             ['#7B8FA8', 'aereo'],
  'Verde':            ['#3F6B45'],
  'Olivo':            ['#6E6B3C'],
  'Violeta':          ['#6B4E9B'],
  'Uva':              ['#4A2B4E'],
  'Bordo':            ['#6E1F2C', 'bordó'],
  'Rojo':             ['#B3261E'],
  'Salmon':           ['#E9A08B', 'salmón'],
  'Naranja':          ['#D9772F'],
  'Amarillo':         ['#E8C547', 'amarilla'],

  /*
   * ── Los que existen en el catálogo pero NO están en la lista de veinte.
   *
   * No se unen solos a ninguno de los oficiales: "Azul Marino" no es "Azul" y
   * "Gris Topo" no es "Topo". Unirlos por parecido sería decidir por el negocio
   * qué color le está mandando al cliente. Quedan marcados en el panel como
   * fuera de la lista, para que se decidan ahí a la vista.
   */
  'Perla':            ['#EDE7DC'],
  'Gris':             ['#9A9A9A', 'gri'],
  'Gris Claro':       ['#C4C4C4'],
  'Gris Perla':       ['#D6D3CD'],
  'Gris Topo':        ['#7D766D'],
  'Moliné':           ['#A8A29B', 'moline'],
  'Camel Claro':      ['#C9A277'],
  'Tostado':          ['#A9743F'],
  'Habano':           ['#8B6A4F'],
  'Azul Marino':      ['#1B2A4A'],
  'Azul Granito':     ['#42556B'],
  'Cielo':            ['#A9CFE8'],
  'Francia':          ['#3A5FA8'],
  'Verde Militar':    ['#4A5240'],
  'Verde Granito':    ['#6B7A63'],
  'Sage':             ['#A8B5A3'],
  'Rosa':             ['#E6A8BE'],
  'Único':            ['#D8D8D8', 'unico'],
};

/*
 * Se compara sin acentos, sin mayúsculas y sin espacios de más.
 *
 * "Salmón" y "Salmon" son el mismo color escrito por dos personas, y el que
 * carga desde el teléfono no siempre pone el acento. Comparar el texto tal
 * cual haría que dependa de eso.
 */
const plano = (v) => String(v || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/\s+/g, ' ');

const PORALIAS = new Map();
for (const [nombre, [hex, ...alias]] of Object.entries(CANON)) {
  PORALIAS.set(plano(nombre), nombre);
  for (const a of alias) PORALIAS.set(plano(a), nombre);
}

/** El nombre canónico de un color, o el original si no lo conocemos. */
function canonico(nombre) {
  const limpio = String(nombre || '').trim();
  if (!limpio) return '';
  return PORALIAS.get(plano(limpio)) || limpio;
}

/** El hex sugerido para un nombre. Null si no hay ninguno pensado. */
function hexSugerido(nombre) {
  const c = CANON[canonico(nombre)];
  return c ? c[0] : null;
}

/*
 * Un color que no está en la lista igual necesita un cuadrito.
 *
 * Se deriva del propio nombre para que dos colores distintos no salgan del
 * mismo gris: el mismo nombre da siempre el mismo tono, y se mantiene apagado
 * a propósito para que se note que es un color por confirmar y no uno cargado.
 */
function hexDerivado(nombre) {
  let h = 0;
  for (const c of String(nombre || 'x')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 14%, 62%)`;
}

/** ¿Está en la lista de veinte que usa el negocio? */
function esOficial(nombre) {
  const p = plano(canonico(nombre));
  return OFICIALES.some((o) => plano(o) === p);
}

module.exports = { CANON, OFICIALES, canonico, esOficial, hexSugerido, hexDerivado, plano };
