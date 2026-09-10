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
import { cargarSesion } from './sesion.js';

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
/*
 * Una fila por producto, en una sola columna.
 *
 * La grilla de tarjetas obliga a recorrer con los ojos en zigzag y deja la
 * información de cada producto en un cuadrito chico. En una compra mayorista lo
 * que se mira antes de entrar es qué colores y qué talles hay: puestos en una
 * fila ancha entran de un vistazo, y la página se recorre bajando, que es lo
 * que la mano hace sola en el teléfono.
 */
function filaProducto(producto) {
  const enPedido = cuentaDeEntrada(producto.sku, estado.carrito[producto.sku]);
  const fotos = fotosDe(producto);

  const carrusel = fotos.length
    ? `<div class="carrusel" data-sku="${esc(producto.sku)}" data-foto="0">
         <img src="${esc(fotos[0].ruta)}" alt="${esc(producto.titulo)}" loading="lazy">
         ${fotos.length > 1 ? `
           <button class="carrusel-ir antes" data-paso="-1" aria-label="Foto anterior">‹</button>
           <button class="carrusel-ir despues" data-paso="1" aria-label="Foto siguiente">›</button>
           <span class="carrusel-cuenta">1/${fotos.length}</span>` : ''}
       </div>`
    : '<div class="carrusel vacio"><span class="sin-foto">SIN FOTO</span></div>';

  const colores = producto.colores.filter((c) => c.nombre).map((c) => `
    <span class="muestra" title="${esc(c.nombre)}">
      <i data-hex="${esc(c.hex)}"></i>${esc(c.nombre)}
    </span>`).join('');

  const talles = producto.talles.filter(Boolean)
    .map((t) => `<span class="talle-chip">${esc(t)}</span>`).join('');

  return `
    <article class="fila-producto" data-sku="${esc(producto.sku)}">
      ${carrusel}
      <div class="fila-datos">
        <div class="fila-encabezado">
          <div>
            <h3>${esc(producto.titulo)}</h3>
            <p class="sku">${esc(producto.sku)}${producto.modelo ? ` · ${esc(producto.modelo)}` : ''}</p>
          </div>
          <div class="fila-precio">${pesos(producto.precio)}<small>por unidad</small></div>
        </div>

        <div class="fila-bloque">
          <span class="rotulo-linea">COLORES</span>
          <div class="muestras">${colores || '<span class="apagado">Sin variantes de color</span>'}</div>
        </div>

        <div class="fila-bloque">
          <span class="rotulo-linea">TALLES${producto.grupoTalle === 'nino' ? ' · NIÑOS' : producto.grupoTalle === 'mixto' ? ' · NIÑOS Y ADULTOS' : ''}</span>
          <div class="talles-linea">${talles}</div>
        </div>

        <div class="fila-pie">
          <button class="btn abrir-producto">Cargar cantidades</button>
          ${enPedido.unidades
            ? `<span class="en-pedido">✓ ${enPedido.unidades} u. · ${pesos(enPedido.subtotal)} en tu pedido</span>`
            : `<span class="apagado chico-2">${producto.unidadesPorCurva} u. por curva</span>`}
        </div>
      </div>
    </article>`;
}

/*
 * Las fotos de un producto, ordenadas.
 *
 * Primero la principal y después una por color. Mientras no haya fotos
 * cargadas, la lista viene vacía y la fila muestra el hueco gris en vez de
 * romperse: el catálogo se usa antes de tener todas las fotos.
 */
export function fotosDe(producto) {
  const lista = [];
  if (producto.foto) lista.push({ ruta: producto.foto, color: null });
  for (const [color, ruta] of Object.entries(producto.fotosPorColor || {})) {
    if (ruta && ruta !== producto.foto) lista.push({ ruta, color });
  }
  return lista;
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
      <h2 class="titulo-categoria">${esc(nombre(id))} <small>${items.length}</small></h2>
      <div class="lista">${items.map(filaProducto).join('')}</div>`)
    .join('');

  pintarMuestras(cont);
}

/*
 * El color de cada cuadrito se pone desde JavaScript, no con `style=`.
 *
 * La política de seguridad del sitio bloquea los atributos `style` —y con
 * razón: el mismo permiso habilita los que llegan inyectados en un texto—.
 * Asignar `el.style.background` desde el código no pasa por esa puerta, así
 * que el color entra sin aflojar nada.
 */
export function pintarMuestras(raiz = document) {
  for (const i of raiz.querySelectorAll('[data-hex]')) {
    i.style.background = i.dataset.hex;
  }
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
  /*
   * La sesión se pide en paralelo con el catálogo, no antes.
   *
   * El catálogo se ve con y sin cuenta, así que encadenarlos haría esperar a
   * todos —incluido quien nunca va a entrar— por una consulta que sólo cambia
   * lo que dice el botón de arriba a la derecha.
   */
  const laSesion = cargarSesion();
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
  await laSesion;
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
  /*
   * Las flechas del carrusel NO abren el producto.
   *
   * Están adentro de la fila, que es clicable entera: sin cortar el evento,
   * mirar la segunda foto abriría el panel de carga, que es lo contrario de lo
   * que la persona pidió.
   */
  const flecha = e.target.closest('.carrusel-ir');
  if (flecha) {
    e.stopPropagation();
    moverCarrusel(flecha.closest('.carrusel'), Number(flecha.dataset.paso));
    return;
  }
  const fila = e.target.closest('.fila-producto[data-sku]');
  if (fila) abrirPanel(fila.dataset.sku);
});

function moverCarrusel(carrusel, paso) {
  const producto = productoPorSku(carrusel.dataset.sku);
  const fotos = fotosDe(producto);
  if (fotos.length < 2) return;
  const actual = Number(carrusel.dataset.foto) || 0;
  const proxima = (actual + paso + fotos.length) % fotos.length;
  carrusel.dataset.foto = proxima;
  carrusel.querySelector('img').src = fotos[proxima].ruta;
  carrusel.querySelector('.carrusel-cuenta').textContent = `${proxima + 1}/${fotos.length}`;
}

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
