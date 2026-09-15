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
  busqueda: '',
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

  /*
   * Las curvas de un color solo se cuentan combinación por combinación.
   *
   * No alcanza con multiplicar por un precio de curva: cada color tiene los
   * talles que tiene, y los talles grandes pueden costar distinto. La cuenta
   * que vale es la del servidor; ésta tiene que dar lo mismo o el total salta
   * entre el carrito y la confirmación.
   */
  for (const [color, valor] of Object.entries(entrada.curvasPorColor || {})) {
    const n = Number(valor) || 0;
    if (n <= 0) continue;
    for (const c of producto.combinaciones) {
      if (c.color !== color) continue;
      unidades += n;
      subtotal += n * c.precio;
    }
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
    ? `<div class="carrusel" data-sku="${esc(producto.sku)}" data-foto="0" data-color="">${
      carruselPorDentro(producto, '', 0)}</div>`
    : '<div class="carrusel vacio"><span class="sin-foto">SIN FOTO</span></div>';

  /*
   * Los colores que tienen fotos son botones: tocarlos deja en el carrusel las
   * fotos de ese color. Los que no tienen quedan como etiqueta —un botón que
   * no cambia nada invita a tocarlo y a pensar que la página no anda—.
   */
  const conFotos = new Set(coloresConFotos(producto));
  const colores = producto.colores.filter((c) => c.nombre).map((c) => (conFotos.has(c.nombre)
    ? `<button type="button" class="muestra con-fotos" data-color-foto="${esc(c.nombre)}"
         aria-pressed="false" title="Ver las fotos en ${esc(c.nombre)}">
         <i data-hex="${esc(c.hex)}"></i>${esc(c.nombre)}</button>`
    : `<span class="muestra" title="${esc(c.nombre)}"><i data-hex="${esc(c.hex)}"></i>${esc(c.nombre)}</span>`
  )).join('');

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
/*
 * Las fotos de un producto: todas, o las de un color.
 *
 * Con un color, las de ese color y nada más: si el cliente tocó "Negro" y
 * aparece una foto azul, deja de confiar en lo que está mirando. Las fotos sin
 * color son las generales —el producto entero, un detalle— y van sólo en
 * "todas".
 */
export function fotosDe(producto, color = null) {
  const todas = producto?.fotos?.length
    ? producto.fotos
    : (producto?.foto ? [{ ruta: producto.foto, color: null }] : []);
  if (!color) return todas;
  const delColor = todas.filter((f) => f.color === color);
  return delColor.length ? delColor : todas;
}

/** Los colores de este producto que tienen al menos una foto, en el orden del producto. */
export function coloresConFotos(producto) {
  const con = new Set(fotosDe(producto).map((f) => f.color).filter(Boolean));
  return (producto?.colores || []).map((c) => c.nombre).filter((n) => con.has(n));
}

/*
 * Lo de adentro del carrusel de la fila, para un color y una posición.
 *
 * Se rearma entero al cambiar de color en vez de tocar pieza por pieza: con
 * un color de una sola foto las flechas sobran, y con "todas" vuelven.
 */
function carruselPorDentro(producto, color, i) {
  const fotos = fotosDe(producto, color || null);
  const k = Math.min(Math.max(0, i), fotos.length - 1);
  const f = fotos[k];
  /*
   * En la fila la foto se ve de 120 a 190 píxeles de ancho: en una pantalla
   * común alcanza la miniatura y en una densa la mediana. El original de
   * 1280×1920 no baja nunca acá; antes bajaba en cada fila.
   */
  const chica = f.miniatura || f.media || f.ruta;
  const densa = f.media || f.ruta;
  return `<img src="${esc(chica)}" srcset="${esc(chica)} 1x, ${esc(densa)} 2x" alt="${esc(producto.titulo)}${f.color ? ` en ${esc(f.color)}` : ''}" loading="lazy" decoding="async">
    ${fotos.length > 1 ? `
      <button class="carrusel-ir antes" data-paso="-1" aria-label="Foto anterior">‹</button>
      <button class="carrusel-ir despues" data-paso="1" aria-label="Foto siguiente">›</button>` : ''}
    ${fotos.length > 1 || color
      ? `<span class="carrusel-cuenta">${color ? `${esc(color)} · ` : ''}${k + 1}/${fotos.length}</span>` : ''}`;
}

/*
 * Comparar sin tildes y sin mayúsculas.
 *
 * Nadie escribe "pantalón" con tilde en un buscador, y media planilla viene
 * escrita en mayúsculas. Sin esto, buscar "pantalon" no encuentra "Pantalón" y
 * la conclusión de quien busca es que el producto no está.
 */
const plano = (v) => String(v ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/*
 * Buscar por título, por categoría o por código.
 *
 * Se parte en palabras y tienen que estar TODAS, en cualquier orden y en
 * cualquiera de los tres campos: "remera negro" y "negro remera" encuentran lo
 * mismo. Buscar la frase entera obligaría a acertar el orden en que está
 * escrito el título, que nadie recuerda.
 *
 * El código entra porque está a la vista en cada fila y quien repone lo tiene
 * anotado del pedido anterior.
 */
function coincide(producto, palabras) {
  const categoria = estado.categorias.find((c) => c.id === producto.categoriaId)?.nombre || '';
  const donde = plano(`${producto.titulo} ${categoria} ${producto.sku} ${producto.modelo || ''}`);
  return palabras.every((w) => donde.includes(w));
}

export function pintarCatalogo() {
  const cont = el('#catalogo');
  const palabras = plano(estado.busqueda).split(/\s+/).filter(Boolean);

  /*
   * Buscando se mira todo el catálogo, no la categoría abierta.
   *
   * Si la búsqueda quedara encerrada en la categoría activa, escribir algo que
   * está en otra da cero resultados y parece que el producto no existe.
   */
  const enCategoria = estado.categoriaActiva && !palabras.length
    ? estado.productos.filter((p) => p.categoriaId === estado.categoriaActiva)
    : estado.productos;
  const visibles = palabras.length
    ? enCategoria.filter((p) => coincide(p, palabras))
    : enCategoria;

  if (!visibles.length) {
    cont.innerHTML = palabras.length
      ? `<div class="vacio"><h3>Nada con “${esc(estado.busqueda)}”</h3>
          <p>Probá con menos palabras, o con el nombre de la categoría.</p></div>`
      : `<div class="vacio"><h3>No hay productos acá</h3>
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
  const encabezado = palabras.length
    ? `<p class="resultado-busqueda">${visibles.length} ${visibles.length === 1 ? 'producto' : 'productos'}`
      + ` con “${esc(estado.busqueda.trim())}”</p>`
    : '';
  cont.innerHTML = encabezado + [...porCategoria.entries()]
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
  /*
   * Elegir una categoría borra la búsqueda.
   *
   * Buscando se mira todo el catálogo, así que si el texto quedara puesto, la
   * categoría recién tocada no cambiaría nada en pantalla y parecería que el
   * botón no anda.
   */
  if (estado.busqueda) { estado.busqueda = ''; el('#buscar').value = ''; el('#buscar-limpiar').hidden = true; }
  pintarCategorias();
  pintarCatalogo();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/*
 * La búsqueda se repinta mientras se escribe, sin esperar a Enter.
 *
 * El catálogo son ochenta productos que ya están en memoria: filtrar es
 * instantáneo y no hay ningún pedido al servidor que convenga demorar. Poner
 * un retraso acá sólo agregaría una espera que nadie pidió.
 */
const campoBuscar = el('#buscar');
campoBuscar.addEventListener('input', () => {
  estado.busqueda = campoBuscar.value;
  el('#buscar-limpiar').hidden = !campoBuscar.value;
  pintarCatalogo();
});

// Escape borra lo escrito sin sacar la mano del teclado.
campoBuscar.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && campoBuscar.value) { e.stopPropagation(); limpiarBusqueda(); }
});

el('#buscar-limpiar').addEventListener('click', () => { limpiarBusqueda(); campoBuscar.focus(); });

function limpiarBusqueda() {
  estado.busqueda = '';
  campoBuscar.value = '';
  el('#buscar-limpiar').hidden = true;
  pintarCatalogo();
}

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
  const chip = e.target.closest('[data-color-foto]');
  if (chip) { e.stopPropagation(); elegirColorEnFila(chip); return; }

  // Un dedo que acaba de deslizar la foto no quiso abrir el producto.
  if (Date.now() - deslizoHace < 500 && e.target.closest('.carrusel')) return;

  const fila = e.target.closest('.fila-producto[data-sku]');
  if (fila) abrirPanel(fila.dataset.sku);
});

/*
 * Deslizar la foto con el dedo, en el teléfono.
 *
 * Las flechas del carrusel miden treinta píxeles: alcanzan para un mouse y no
 * para un pulgar, y en el teléfono lo que la mano hace sola con una foto es
 * arrastrarla. Tiene que ser más horizontal que vertical, o se comería el
 * gesto de bajar por la página.
 */
let toque = null;
let deslizoHace = 0;
el('#catalogo').addEventListener('touchstart', (e) => {
  const carrusel = e.target.closest('.carrusel[data-sku]');
  toque = carrusel ? { carrusel, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
el('#catalogo').addEventListener('touchend', (e) => {
  if (!toque) return;
  const dx = e.changedTouches[0].clientX - toque.x;
  const dy = e.changedTouches[0].clientY - toque.y;
  const { carrusel } = toque;
  toque = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    moverCarrusel(carrusel, dx < 0 ? 1 : -1);
    deslizoHace = Date.now();
  }
}, { passive: true });

function moverCarrusel(carrusel, paso) {
  const producto = productoPorSku(carrusel.dataset.sku);
  const color = carrusel.dataset.color || '';
  const fotos = fotosDe(producto, color || null);
  if (fotos.length < 2) return;
  const proxima = ((Number(carrusel.dataset.foto) || 0) + paso + fotos.length) % fotos.length;
  carrusel.dataset.foto = proxima;
  carrusel.innerHTML = carruselPorDentro(producto, color, proxima);
}

/*
 * Tocar un color deja en el carrusel sólo sus fotos; tocarlo de nuevo vuelve
 * a todas. Así se ve cómo es cada color antes de abrir el producto.
 */
function elegirColorEnFila(boton) {
  const fila = boton.closest('.fila-producto');
  const carrusel = fila?.querySelector('.carrusel[data-sku]');
  if (!carrusel) return;
  const yaEstaba = boton.getAttribute('aria-pressed') === 'true';
  const color = yaEstaba ? '' : boton.dataset.colorFoto;
  for (const b of fila.querySelectorAll('[data-color-foto]')) {
    b.setAttribute('aria-pressed', String(b === boton && !yaEstaba));
  }
  carrusel.dataset.color = color;
  carrusel.dataset.foto = 0;
  carrusel.innerHTML = carruselPorDentro(productoPorSku(carrusel.dataset.sku), color, 0);
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
