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
  'Chocolate', 'Bordo', 'Amarillo', 'Azul', 'Dulce de Leche', 'Uva',
  'Salmon', 'Olivo', 'Celeste', 'Aero', 'Naranja',
  // Los tres que el negocio decidió conservar aparte al depurar la paleta.
  'Francia', 'Rosa', 'Único',
];

/*
 * canónico → [hex, ...alias]
 *
 * Los alias son la parte que sostiene todo: la planilla de STOCKER vuelve a
 * traer "Azul Marino", "Gris Topo" y "Crema" en cada exportación, porque en
 * STOCKER siguen siendo valores distintos. Sin tenerlos acá, cada importación
 * recrearía los dieciséis colores que se depuraron a mano y habría que volver
 * a unirlos uno por uno.
 */
const CANON = {
  'Negro':            ['#111111', 'negra', 'nero', 'nego'],
  'Blanco':           ['#FFFFFF', 'blanca'],
  // Beish se queda con los cremas y los beiges: es el mismo tono cargado con
  // tres nombres distintos según quién completó la planilla.
  'Beish':            ['#E4D5BE', 'beis', 'beige', 'crema'],
  'Topo':             ['#8C8075', 'gris topo'],
  // Melang absorbe los grises: en el catálogo se venían usando como sinónimos.
  'Melang':           ['#B5B5B5', 'melange', 'moline', 'moliné', 'gris', 'gri', 'gris claro', 'gris perla', 'perla'],
  'Chocolate':        ['#4E342A', 'choco'],
  'Dulce de Leche':   ['#C08A55', 'camel claro', 'tostado'],
  'Azul':             ['#2F5597', 'azul marino', 'azul granito'],
  'Celeste':          ['#8FC1E3', 'cielo'],
  'Aero':             ['#7B8FA8', 'aereo'],
  'Verde':            ['#3F6B45', 'verde granito'],
  'Olivo':            ['#6E6B3C', 'verde militar'],
  'Violeta':          ['#6B4E9B'],
  'Uva':              ['#4A2B4E'],
  'Bordo':            ['#6E1F2C', 'bordó'],
  'Rojo':             ['#B3261E'],
  'Salmon':           ['#E9A08B', 'salmón'],
  'Naranja':          ['#D9772F'],
  'Amarillo':         ['#E8C547', 'amarilla'],
  // Se conservan aparte por decisión del negocio.
  'Francia':          ['#3A5FA8'],
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
