/*
 * ISUWAYA MAYORISTA — catálogo y armado del pedido.
 *
 * Sin framework y sin compilación: el proyecto se despliega tal cual está en el
 * repositorio. Para un catálogo con un panel y un formulario, un bundler suma
 * un paso que puede fallar en el deploy y no resuelve nada que acá haga falta.
 */

import { pesos, esc, el } from './util.js';
import { abrirPanel, cerrarPanel } from './panel.js';
import { abrirDialogo, cerrarDialogo } from './pedido.js';

export const estado = {
  categorias: [],
  productos: [],
  categoriaActiva: null,
  /*
   * El carrito, por SKU de producto padre.
   *
   *   { [skuAgrupador]: { curvas: n, cantidades: { [skuVariante]: n } } }
   *
   * Se guarda por SKU y no por posición porque el catálogo se recarga entre
   * visitas: con índices, reimportar la planilla y que un producto cambie de
   * lugar movería lo que el cliente había cargado a otro producto.
   */
  carrito: {},
};

const CLAVE_CARRITO = 'isuwaya.carrito.v1';

export function guardarCarrito() {
  try { localStorage.setItem(CLAVE_CARRITO, JSON.stringify(estado.carrito)); } catch { /* modo privado */ }
}

function recuperarCarrito() {
  try {
    const crudo = localStorage.getItem(CLAVE_CARRITO);
    if (crudo) estado.carrito = JSON.parse(crudo) || {};
  } catch { estado.carrito = {}; }
}

// ── Cuentas del carrito ───────────────────────────────────────────
export function productoPorSku(sku) {
  return estado.productos.find((p) => p.sku === sku) || null;
}

/** Unidades y plata de una entrada del carrito, con los precios del catálogo. */
export function cuentaDeEntrada(sku, entrada) {
  const producto = productoPorSku(sku);
  if (!producto || !entrada) return { unidades: 0, subtotal: 0 };

  let unidades = 0;
  let subtotal = 0;
  const porSku = new Map(producto.combinaciones.map((c) => [c.sku, c]));

  const curvas = Number(entrada.curvas) || 0;
  if (curvas > 0) {
    unidades += curvas * producto.unidadesPorCurva;
    subtotal += curvas * producto.precioPorCurva;
  }
  for (const [skuVar, n] of Object.entries(entrada.cantidades || {})) {
    const cant = Number(n) || 0;
    if (!cant || !porSku.has(skuVar)) continue;
    unidades += cant;
    subtotal += cant * porSku.get(skuVar).precio;
  }
  return { unidades, subtotal };
}

export function totalesDelCarrito() {
  let unidades = 0;
  let total = 0;
  let productos = 0;
  for (const [sku, entrada] of Object.entries(estado.carrito)) {
    const c = cuentaDeEntrada(sku, entrada);
    if (!c.unidades) continue;
    productos += 1;
    unidades += c.unidades;
    total += c.subtotal;
  }
  return { productos, unidades, total };
}

// ── Botón flotante ────────────────────────────────────────────────
const flotante = el('#flotante');

export function refrescarFlotante() {
  const { productos, unidades, total } = totalesDelCarrito();
  const hay = unidades > 0;
  flotante.hidden = !hay;
  // El `hidden` saca el botón del flujo; la clase hace la transición. Con sólo
  // la clase, el botón sigue siendo enfocable con Tab estando invisible.
  requestAnimationFrame(() => flotante.classList.toggle('visible', hay));
  // En dos trozos para que el CSS pueda esconder el de productos en pantalla
  // angosta sin que el JavaScript tenga que escuchar el cambio de tamaño.
  el('#flotante-detalle').innerHTML = hay
    ? `<span class="prod">· ${productos} producto${productos === 1 ? '' : 's'}</span>`
      + `<span class="unid"> · ${unidades} u.</span>`
    : '';
  el('#flotante-total').textContent = pesos(total);
}

// ── Catálogo ──────────────────────────────────────────────────────
function tarjeta(producto) {
  const enPedido = cuentaDeEntrada(producto.sku, estado.carrito[producto.sku]);
  const foto = producto.foto
    ? `<img src="${esc(producto.foto)}" alt="${esc(producto.titulo)}" loading="lazy">`
    : '<span class="sin-foto">SIN FOTO</span>';
  const colores = producto.colores.filter(Boolean).slice(0, 4)
    .map((c) => `<span>${esc(c)}</span>`).join('');
  const mas = producto.colores.filter(Boolean).length > 4
    ? `<span>+${producto.colores.filter(Boolean).length - 4}</span>` : '';

  return `
    <button class="producto" data-sku="${esc(producto.sku)}">
      <span class="foto">${foto}</span>
      <span class="cuerpo">
        <h3>${esc(producto.titulo)}</h3>
        <span class="sku">${esc(producto.sku)}</span>
        <span class="precio">${pesos(producto.precio)}</span>
        <span class="colores">${colores}${mas}</span>
        ${enPedido.unidades ? `<span class="en-pedido">✓ ${enPedido.unidades} u. en tu pedido</span>` : ''}
      </span>
    </button>`;
}

export function pintarCatalogo() {
  const cont = el('#catalogo');
  const visibles = estado.categoriaActiva
    ? estado.productos.filter((p) => p.categoriaId === estado.categoriaActiva)
    : estado.productos;

  if (!visibles.length) {
    cont.innerHTML = `<div class="vacio"><h3>No hay productos acá</h3>
      <p>Probá con otra categoría.</p></div>`;
    return;
  }

  // Agrupados por categoría también en la vista "Todo": un listado corrido de
  // cientos de productos sin cortes obliga a recordar dónde terminaba cada cosa.
  const porCategoria = new Map();
  for (const p of visibles) {
    if (!porCategoria.has(p.categoriaId)) porCategoria.set(p.categoriaId, []);
    porCategoria.get(p.categoriaId).push(p);
  }

  const nombre = (id) => estado.categorias.find((c) => c.id === id)?.nombre || 'Sin categoría';
  cont.innerHTML = [...porCategoria.entries()]
    .map(([id, items]) => `
      <h2 class="titulo-categoria">${esc(nombre(id))}</h2>
      <div class="grilla">${items.map(tarjeta).join('')}</div>`)
    .join('');
}

function pintarCategorias() {
  const cont = el('#categorias');
  const conProductos = estado.categorias.filter(
    (c) => estado.productos.some((p) => p.categoriaId === c.id),
  );
  cont.innerHTML = [
    `<button data-cat="" aria-current="${estado.categoriaActiva === null}">Todo el catálogo</button>`,
    ...conProductos.map((c) =>
      `<button data-cat="${c.id}" aria-current="${estado.categoriaActiva === c.id}">${esc(c.nombre)}</button>`),
  ].join('');
}

// ── Arranque ──────────────────────────────────────────────────────
async function iniciar() {
  recuperarCarrito();
  try {
    const r = await fetch('/api/catalogo');
    if (!r.ok) throw new Error('no se pudo');
    const datos = await r.json();
    estado.categorias = datos.categorias;
    estado.productos = datos.productos;
  } catch {
    el('#catalogo').innerHTML = `<div class="vacio"><h3>No pudimos cargar el catálogo</h3>
      <p>Actualizá la página en un momento.</p></div>`;
    return;
  }

  if (!estado.productos.length) {
    el('#catalogo').innerHTML = `<div class="vacio"><h3>El catálogo todavía está vacío</h3>
      <p>En breve vas a poder ver los productos acá.</p></div>`;
    return;
  }

  /*
   * Lo que quedó en el carrito de un producto que ya no está se descarta al
   * arrancar. Si no, el pedido mostraría un total que incluye algo que el
   * servidor va a rechazar, y la diferencia recién aparecería al confirmar.
   */
  for (const sku of Object.keys(estado.carrito)) {
    if (!productoPorSku(sku)) delete estado.carrito[sku];
  }
  guardarCarrito();

  pintarCategorias();
  pintarCatalogo();
  refrescarFlotante();
}

// ── Eventos ───────────────────────────────────────────────────────
el('#categorias').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cat]');
  if (!b) return;
  estado.categoriaActiva = b.dataset.cat ? Number(b.dataset.cat) : null;
  pintarCategorias();
  pintarCatalogo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

el('#catalogo').addEventListener('click', (e) => {
  const b = e.target.closest('.producto[data-sku]');
  if (b) abrirPanel(b.dataset.sku);
});

el('#panel-cerrar').addEventListener('click', cerrarPanel);
el('#telon').addEventListener('click', cerrarPanel);
flotante.addEventListener('click', () => abrirDialogo());
el('#dialogo-cerrar').addEventListener('click', cerrarDialogo);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (el('#dialogo').classList.contains('abierto')) cerrarDialogo();
  else if (el('#panel').classList.contains('abierto')) cerrarPanel();
});

iniciar();
