/*
 * Qué se mira en la tienda.
 *
 * Sin esto, lo único que sabía el portal era lo que alguien terminó pidiendo:
 * no había forma de saber qué se miró y no se pidió, ni qué entró al carrito y
 * quedó ahí. Con eso no se puede ordenar un catálogo por lo más visto sin
 * inventar los números.
 *
 * QUÉ SE MANDA
 *
 * El tipo de gesto y el producto o la categoría. Nada más. Lo acompaña un
 * identificador al azar que dura lo que dura la pestaña —vive en
 * `sessionStorage`, se borra al cerrar el navegador— y sirve para contar
 * visitas en vez de gestos sueltos. Si quien mira ya entró con su cuenta, el
 * servidor le suma la ficha del cliente; si no, queda anónimo. La IP no se
 * guarda.
 *
 * CÓMO SE MANDA
 *
 * En lotes, cada cuatro segundos o cuando se junten unos cuantos. Al cerrar la
 * pestaña se usa `sendBeacon`, que el navegador entrega aunque la página ya no
 * esté: es la única forma de enterarse de un carrito abandonado.
 *
 * Nada de esto puede romper la tienda. Si el navegador está en modo privado y
 * no deja guardar el identificador, o si el pedido falla, no se mide y la
 * tienda sigue igual.
 */
const CLAVE = 'isuwaya-visita';
const TOPE_COLA = 40;
const ESPERA = 4000;

function idDeVisita() {
  try {
    let v = sessionStorage.getItem(CLAVE);
    if (!v || !/^[a-f0-9]{8,64}$/.test(v)) {
      v = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem(CLAVE, v);
    }
    return v;
  } catch {
    return null;   // modo privado: no se mide, y la tienda anda igual
  }
}

const visita = idDeVisita();
let cola = [];
let reloj = null;
const yaContados = new Set();

function mandar(alIrse = false) {
  clearTimeout(reloj);
  reloj = null;
  if (!visita || !cola.length) return;
  const cuerpo = JSON.stringify({ visita, eventos: cola.slice(0, 50) });
  cola = [];
  try {
    if (alIrse && navigator.sendBeacon) {
      navigator.sendBeacon('/api/eventos', new Blob([cuerpo], { type: 'application/json' }));
      return;
    }
    fetch('/api/eventos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpo,
      keepalive: true,
    }).catch(() => { /* medir no es tan importante como comprar */ });
  } catch { /* idem */ }
}

/**
 * Anota un gesto. Con `unaVezPor` se cuenta una sola vez por visita, que es lo
 * que hace falta para las impresiones: una fila que entra y sale de la pantalla
 * diez veces mientras se baja es una sola vista, no diez.
 */
export function medir(tipo, datos = {}, { unaVezPor = null } = {}) {
  if (!visita) return;
  if (unaVezPor) {
    if (yaContados.has(unaVezPor)) return;
    yaContados.add(unaVezPor);
  }
  cola.push({ tipo, ...datos });
  if (cola.length >= TOPE_COLA) { mandar(); return; }
  if (!reloj) reloj = setTimeout(() => mandar(), ESPERA);
}

/*
 * Lo que queda sin pedir cuando la pestaña se va.
 *
 * `armar` devuelve un evento por producto que quedó en el carrito. Se manda al
 * ocultarse la pestaña, no sólo al cerrarla: en el teléfono, cambiar de app no
 * dispara `pagehide` y ese carrito no se contaría nunca. Como ocultarse pasa
 * muchas veces, se manda sólo si el carrito cambió desde la última vez, y así
 * un mismo carrito no cuenta como diez abandonos.
 */
let firma = '';
export function alIrse(armar) {
  const irse = () => {
    let eventos = [];
    try { eventos = armar() || []; } catch { eventos = []; }
    const ahora = JSON.stringify(eventos);
    if (eventos.length && ahora !== firma) {
      firma = ahora;
      for (const e of eventos) cola.push(e);
    }
    mandar(true);
  };
  addEventListener('pagehide', irse);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') irse();
  });
}

/** Deja de contar el carrito como abandonado: se confirmó el pedido. */
export function olvidarCarrito() { firma = ''; }
