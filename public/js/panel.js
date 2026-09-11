/*
 * El panel del producto: color, talles y curvas.
 *
 * Se trabaja sobre un borrador y no sobre el carrito.
 *
 * Quien abre un producto, carga cantidades y cierra sin apretar "Agregar" no
 * quiso agregar nada. Escribiendo directo en el carrito, cerrar el panel dejaría
 * el pedido cambiado sin que nadie lo haya confirmado — y con el total ya
 * modificado en el botón flotante.
 */

import { el, esc, pesos, enteroPositivo } from './util.js';
import {
  estado, productoPorSku, cuentaDeEntrada, guardarCarrito,
  refrescarFlotante, pintarCatalogo, fotosDe, pintarMuestras,
} from './app.js';

let actual = null;      // producto abierto
let borrador = null;    // { curvas, cantidades }
let modo = 'talles';    // 'talles' | 'curva'
let devolverFocoA = null;

const panel = el('#panel');
const telon = el('#telon');

const clonar = (o) => JSON.parse(JSON.stringify(o));

/*
 * El cuadro de talles se ve entero o no se ve.
 *
 * Antes el cajón medía 480px fijos y el cuadro se deslizaba adentro: en una
 * pantalla de 1440 sobraban 960px al costado y aun así había que arrastrar
 * para llegar al 5XL, sin ninguna señal de que hubiera algo más a la derecha.
 * Lo que no se ve, no se pide.
 *
 * Así que el cajón se estira hasta donde el cuadro entra —midiendo, no
 * adivinando— y cuando ni estirándose entra, que es lo que pasa con nueve
 * talles en un teléfono, el cuadro se apila: un bloque por color con sus
 * talles envueltos. Se baja, que es el gesto que ya se está haciendo, y no se
 * arrastra para el costado, que es el que se pierde.
 */
const ANCHO_COLOR = 136;    // la columna del nombre del color
const ANCHO_CELDA = 68;     // cada columna de talle
const ANCHO_BORDES = 38;    // el padding del contenido del cajón

/*
 * La cuenta de acá es sólo para decidir la forma ANTES de pintar; el ancho
 * exacto se mide después sobre la tabla ya armada. Estimar y creerse la
 * estimación fue el primer intento y quedó 33px corto —el padding del
 * envoltorio no estaba contado y las celdas miden más que su mínimo—, así que
 * conviene que peque de generosa: si sobra, la medición lo corrige.
 */
const anchoQueNecesita = (talles) => ANCHO_COLOR + talles * ANCHO_CELDA + ANCHO_BORDES;
const entraElCuadro = (talles) => window.innerWidth >= anchoQueNecesita(talles);

let formaForzada = null;   // 'apilada' cuando la medición dice que la tabla no entra

export function abrirPanel(sku) {
  const producto = productoPorSku(sku);
  if (!producto) return;

  devolverFocoA = document.activeElement;
  actual = producto;
  borrador = clonar(estado.carrito[sku] || { curvas: 0, cantidades: {} });
  borrador.cantidades = borrador.cantidades || {};
  borrador.curvasPorColor = borrador.curvasPorColor || {};
  const hayCurvasDeColor = Object.values(borrador.curvasPorColor).some((n) => Number(n) > 0);
  modo = (borrador.curvas > 0 || hayCurvasDeColor) ? 'curva' : 'talles';

  el('#panel-titulo').textContent = producto.titulo;
  el('#panel-sku').textContent = `${producto.sku}${producto.modelo ? ` · ${producto.modelo}` : ''}`;

  panel.hidden = false;
  requestAnimationFrame(() => {
    panel.classList.add('abierto');
    telon.classList.add('abierto');
    panel.focus();
  });
  document.body.style.overflow = 'hidden';
  formaForzada = null;
  entrabaElCuadro = entraElCuadro(producto.talles.filter(Boolean).length);
  pintar();
}

export function cerrarPanel() {
  panel.classList.remove('abierto');
  telon.classList.remove('abierto');
  document.body.style.overflow = '';
  // Se saca del flujo recién cuando terminó la transición: sacarlo antes hace
  // que el panel desaparezca de golpe en vez de deslizarse.
  setTimeout(() => { panel.hidden = true; }, 220);
  actual = null;
  borrador = null;
  devolverFocoA?.focus?.();
}

// ── Pintado ───────────────────────────────────────────────────────
/*
 * La matriz completa: los colores en filas y los talles en columnas.
 *
 * Antes había un selector de color y una lista de talles del color elegido, lo
 * que obliga a entrar y salir de cada color para cargar un pedido de siete
 * colores. Puesto todo junto se carga de corrido, se ve cuánto lleva cada
 * color sin cambiar de vista, y es la forma en que ya se piden estas cosas
 * por planilla.
 *
 * El cruce que no existe no queda vacío: dice "Agotado". Un casillero en
 * blanco se lee como "podés pedir cero", y quien lo intenta descubre que no se
 * puede recién cuando el número no entra.
 */
function vistaMatriz() {
  const talles = actual.talles.filter(Boolean);
  const enTabla = formaForzada !== 'apilada' && entraElCuadro(talles.length);
  return enTabla ? matrizEnTabla(talles) : matrizApilada(talles);
}

/*
 * Un bloque por color, con los talles envueltos.
 *
 * Los casilleros van en una grilla que se acomoda sola al ancho, así que todos
 * los bloques quedan con la misma cantidad de columnas y los talles siguen
 * alineados de un color al otro: se lee como el cuadro, pero entra.
 */
function matrizApilada(talles) {
  const colores = actual.colores.filter((c) => c.nombre);
  const porCruce = new Map(actual.combinaciones.map((c) => [`${c.color}|${c.talle}`, c]));

  const bloques = colores.map((color) => {
    const celdas = talles.map((talle) => {
      const combo = porCruce.get(`${color.nombre}|${talle}`);
      if (!combo) {
        return `<div class="celda agotada">
          <span class="talle">${esc(talle)}</span><span class="sin">Agotado</span>
        </div>`;
      }
      const valor = enteroPositivo(borrador.cantidades[combo.sku]) || '';
      return `<label class="celda">
        <span class="talle">${esc(talle)}</span>
        <input type="number" min="0" inputmode="numeric" data-sku="${esc(combo.sku)}"
               value="${valor}" placeholder="0"
               aria-label="${esc(talle)} en ${esc(color.nombre)}">
      </label>`;
    }).join('');

    const enColor = actual.combinaciones
      .filter((c) => c.color === color.nombre)
      .reduce((t, c) => t + enteroPositivo(borrador.cantidades[c.sku]), 0);

    return `<section class="bloque-color" data-color="${esc(color.nombre)}">
      <header>
        <span class="cuadro" data-hex="${esc(color.hex)}"></span>
        <span class="nombre">${esc(color.nombre)}</span>
        ${enColor ? `<span class="cuenta-color">${enColor}</span>` : ''}
      </header>
      <div class="celdas">${celdas}</div>
    </section>`;
  }).join('');

  return `<div class="matriz-apilada">${bloques}</div>`;
}

function matrizEnTabla(talles) {
  const colores = actual.colores.filter((c) => c.nombre);
  const porCruce = new Map(actual.combinaciones.map((c) => [`${c.color}|${c.talle}`, c]));

  const encabezado = `<tr><th class="col-color"></th>${
    talles.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>`;

  const filas = colores.map((color) => {
    const celdas = talles.map((talle) => {
      const combo = porCruce.get(`${color.nombre}|${talle}`);
      if (!combo) return '<td class="agotado"><span>Agotado</span></td>';
      const valor = enteroPositivo(borrador.cantidades[combo.sku]) || '';
      return `<td>
        <input type="number" min="0" inputmode="numeric" data-sku="${esc(combo.sku)}"
               value="${valor}" placeholder="0"
               aria-label="${esc(talle)} en ${esc(color.nombre)}">
      </td>`;
    }).join('');

    const enColor = actual.combinaciones
      .filter((c) => c.color === color.nombre)
      .reduce((t, c) => t + enteroPositivo(borrador.cantidades[c.sku]), 0);

    return `<tr data-color="${esc(color.nombre)}">
      <th class="col-color">
        <span class="cuadro" data-hex="${esc(color.hex)}"></span>
        <span class="nombre">${esc(color.nombre)}</span>
        ${enColor ? `<span class="cuenta-color">${enColor}</span>` : ''}
      </th>${celdas}</tr>`;
  }).join('');

  return `
    <div class="matriz-envoltorio">
      <table class="matriz-talles">
        <thead>${encabezado}</thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;
}

function vistaCurva() {
  /*
   * La curva se pide en vista limpia, sin fotos ni selector de color.
   *
   * Una curva son todos los colores y todos los talles a la vez: elegir un
   * color acá no significa nada, y dejar el selector puesto invita a creer que
   * la curva es de ese color.
   */
  return `
    <div class="aviso-curva">
      Una curva es <b>una unidad de cada talle en cada color</b> de este producto:
      <b>${actual.unidadesPorCurva} unidades</b> por curva
      (${actual.colores.filter(Boolean).length || 1} ${actual.colores.filter(Boolean).length === 1 ? 'color' : 'colores'}
      × ${actual.talles.length} ${actual.talles.length === 1 ? 'talle' : 'talles'}),
      <b>${pesos(actual.precioPorCurva)}</b> cada una.
    </div>
    <p class="rotulo">CURVA COMPLETA</p>
    <div class="fila-talle">
      <span class="talle">Todos los colores</span>
      <span class="contador">
        <button data-curva="-1" aria-label="Una curva menos">−</button>
        <input type="number" min="0" inputmode="numeric" id="curvas"
               value="${borrador.curvas || ''}" placeholder="0" aria-label="Cantidad de curvas">
        <button data-curva="1" aria-label="Una curva más">+</button>
      </span>
    </div>
    ${curvasPorColor()}`;
}

/*
 * Curvas de un color solo.
 *
 * La curva entera obliga a llevarse los doce colores. Al que se le terminó el
 * negro y quiere reponer nada más que eso, la curva completa no le sirve: le
 * entra mercadería que no pidió. Acá pide una unidad de cada talle, pero del
 * color que elija.
 *
 * Cada color muestra cuántos talles tiene de verdad y cuánto sale su curva:
 * no todos los colores llegan en todos los talles, así que "una curva de
 * negro" y "una curva de salmón" pueden ser cantidades y precios distintos, y
 * eso tiene que verse antes de cargar y no en el total.
 */
function curvasPorColor() {
  const colores = actual.colores.filter((c) => c.nombre);
  if (colores.length < 2) return '';

  const filas = colores.map((color) => {
    const combos = actual.combinaciones.filter((c) => c.color === color.nombre);
    if (!combos.length) return '';
    const precio = combos.reduce((t, c) => t + c.precio, 0);
    const puestas = enteroPositivo(borrador.curvasPorColor?.[color.nombre]);

    return `
      <div class="fila-talle fila-curva-color" data-color="${esc(color.nombre)}">
        <span class="talle">
          <span class="cuadro" data-hex="${esc(color.hex)}"></span>
          ${esc(color.nombre)}
          <span class="precio-unit">${combos.length} ${combos.length === 1 ? 'talle' : 'talles'} · ${pesos(precio)}</span>
        </span>
        <span class="contador">
          <button data-curva-color="${esc(color.nombre)}" data-paso-curva="-1"
                  aria-label="Una curva menos de ${esc(color.nombre)}">−</button>
          <input type="number" min="0" inputmode="numeric" data-curva-color-input="${esc(color.nombre)}"
                 value="${puestas || ''}" placeholder="0"
                 aria-label="Curvas de ${esc(color.nombre)}">
          <button data-curva-color="${esc(color.nombre)}" data-paso-curva="1"
                  aria-label="Una curva más de ${esc(color.nombre)}">+</button>
        </span>
      </div>`;
  }).join('');

  return `<p class="rotulo separado-arriba">CURVA POR COLOR</p>${filas}`;
}

function pintar() {
  const fotos = fotosDe(actual);
  const carrusel = modo === 'curva' || !fotos.length ? '' : `
    <div class="carrusel-panel" data-foto="0">
      <img src="${esc(fotos[0].ruta)}" alt="${esc(actual.titulo)}">
      ${fotos.length > 1 ? `
        <button class="carrusel-ir antes" data-paso="-1" aria-label="Foto anterior">‹</button>
        <button class="carrusel-ir despues" data-paso="1" aria-label="Foto siguiente">›</button>
        <span class="carrusel-cuenta">${fotos[0].color ? esc(fotos[0].color) : '1'}/${fotos.length}</span>` : ''}
    </div>`;

  const guia = actual.guiaTalles
    ? `<button class="btn borde ver-guia" type="button">Ver guía de talles</button>`
    : '';

  /*
   * El ancho se fija por producto y no por modo: cambiar entre talles y curva
   * no tiene que hacer saltar el cajón de ancho debajo del dedo.
   */
  panel.style.setProperty('--ancho-cuadro', `${anchoQueNecesita(actual.talles.filter(Boolean).length)}px`);

  el('#panel-contenido').innerHTML = `
    ${carrusel}
    ${actual.descripcion ? `<p class="descripcion">${esc(actual.descripcion)}</p>` : ''}
    <div class="modos" role="group" aria-label="Cómo cargar las cantidades">
      <button data-modo="talles" aria-pressed="${modo === 'talles'}">Por color y talle</button>
      <button data-modo="curva" aria-pressed="${modo === 'curva'}">Por curva</button>
    </div>
    ${modo === 'curva' ? vistaCurva() : vistaMatriz()}
    ${guia}`;

  /*
   * Con la tabla ya armada se mide lo que de verdad ocupa y se ajusta el
   * cajón. La tabla se dibuja a `max-content`, así que su ancho no depende del
   * cajón y una sola medición alcanza: no hay ida y vuelta entre los dos.
   *
   * Y si ni así entra en la pantalla, se repinta apilada en vez de dejar el
   * cuadro cortado. Es la única forma de estar seguros, porque cuánto mide una
   * celda lo decide el texto que le tocó adentro.
   */
  const tabla = panel.querySelector('table.matriz-talles');
  if (tabla) {
    const necesita = Math.ceil(tabla.getBoundingClientRect().width) + ANCHO_BORDES;
    if (necesita > window.innerWidth) { formaForzada = 'apilada'; pintar(); return; }
    panel.style.setProperty('--ancho-cuadro', `${necesita}px`);
  }

  pintarMuestras(el('#panel-contenido'));
  refrescarPie();
}

function refrescarPie() {
  const c = cuentaDeEntrada(actual.sku, borrador);
  el('#panel-unidades').textContent = `Items: ${c.unidades}`;
  el('#panel-subtotal').textContent = `Total: ${pesos(c.subtotal)}`;
  el('#panel-agregar').disabled = c.unidades === 0 && !estado.carrito[actual.sku];
  el('#panel-agregar').textContent = c.unidades === 0 && estado.carrito[actual.sku]
    ? 'Quitar del pedido' : 'Añadir al carrito';
}

// ── Interacción ───────────────────────────────────────────────────
el('#panel-contenido').addEventListener('click', (e) => {
  if (!actual) return;
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.modo) {
    /*
     * Cambiar de modo no borra lo cargado en el otro.
     *
     * Quien pide tres curvas y después suma dos remeras sueltas de un talle
     * espera que las curvas sigan ahí. El pedido es la suma de los dos.
     */
    modo = b.dataset.modo;
    pintar();
    return;
  }

  if (b.dataset.paso) { moverCarruselPanel(Number(b.dataset.paso)); return; }

  if (b.dataset.curva) {
    borrador.curvas = enteroPositivo(borrador.curvas + Number(b.dataset.curva));
    el('#curvas').value = borrador.curvas || '';
    refrescarPie();
    return;
  }

  if (b.dataset.curvaColor) {
    const color = b.dataset.curvaColor;
    const n = enteroPositivo(enteroPositivo(borrador.curvasPorColor[color]) + Number(b.dataset.pasoCurva));
    if (n) borrador.curvasPorColor[color] = n; else delete borrador.curvasPorColor[color];
    // Se toca sólo el casillero de esa fila: repintar le sacaría el foco a
    // quien está cargando.
    const campo = el(`[data-curva-color-input="${CSS.escape(color)}"]`, el('#panel-contenido'));
    if (campo) campo.value = n || '';
    refrescarPie();
    return;
  }

  if (b.classList.contains('ver-guia')) { abrirGuia(); }
});

function moverCarruselPanel(paso) {
  const carrusel = el('.carrusel-panel');
  const fotos = fotosDe(actual);
  if (!carrusel || fotos.length < 2) return;
  const actualIdx = Number(carrusel.dataset.foto) || 0;
  const proxima = (actualIdx + paso + fotos.length) % fotos.length;
  carrusel.dataset.foto = proxima;
  carrusel.querySelector('img').src = fotos[proxima].ruta;
  carrusel.querySelector('.carrusel-cuenta').textContent =
    fotos[proxima].color ? fotos[proxima].color : `${proxima + 1}/${fotos.length}`;
}

/*
 * La guía de talles, con las medidas de ESTE producto.
 *
 * Un talle M no mide lo mismo en una remera que en una campera. Una tabla
 * general serviría para adivinar y no para decidir, que es justamente lo que
 * el cliente necesita hacer antes de pedir cincuenta unidades.
 */
function abrirGuia() {
  const g = actual.guiaTalles;
  if (!g?.filas?.length) return;
  const cols = g.columnas || [];
  el('#guia-titulo').textContent = `Guía de talles · ${actual.titulo}`;
  el('#guia-cuerpo').innerHTML = `
    ${g.nota ? `<p class="mensaje info">${esc(g.nota)}</p>` : ''}
    <div class="envoltorio-tabla">
      <table class="datos">
        <thead><tr><th>Talle</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${g.filas.map((f) => `
          <tr><th>${esc(f.talle)}</th>${cols.map((c) => `<td>${esc(f[c] ?? '—')}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="chico-2 separado">Medidas en centímetros, tomadas sobre la prenda apoyada.</p>`;
  el('#dialogo-guia').classList.add('abierto');
}

el('#guia-cerrar')?.addEventListener('click', () => el('#dialogo-guia').classList.remove('abierto'));

el('#panel-contenido').addEventListener('input', (e) => {
  if (!actual) return;
  const input = e.target;
  if (input.id === 'curvas') {
    borrador.curvas = enteroPositivo(input.value);
    refrescarPie();
    return;
  }
  const colorCurva = input.dataset?.curvaColorInput;
  if (colorCurva) {
    const n = enteroPositivo(input.value);
    if (n) borrador.curvasPorColor[colorCurva] = n; else delete borrador.curvasPorColor[colorCurva];
    refrescarPie();
    return;
  }

  const sku = input.dataset?.sku;
  if (!sku) return;
  const n = enteroPositivo(input.value);
  if (n) borrador.cantidades[sku] = n; else delete borrador.cantidades[sku];
  refrescarPie();
  actualizarCuentaDeFila(input);
});

/*
 * El total de la fila se actualiza sin repintar la tabla.
 *
 * Repintar en cada tecla reconstruye el casillero que la persona está usando y
 * le saca el foco a mitad de un número. Se toca sólo el contador de esa fila,
 * que es lo único que cambió.
 */
function actualizarCuentaDeFila(input) {
  // Sirve para las dos formas: la fila de la tabla y el bloque apilado.
  const fila = input.closest('[data-color]');
  if (!fila) return;
  const color = fila.dataset.color;
  const n = actual.combinaciones
    .filter((c) => c.color === color)
    .reduce((t, c) => t + enteroPositivo(borrador.cantidades[c.sku]), 0);

  let cuenta = fila.querySelector('.cuenta-color');
  if (!n) { cuenta?.remove(); return; }
  if (!cuenta) {
    cuenta = document.createElement('span');
    cuenta.className = 'cuenta-color';
    fila.querySelector('.col-color, header').append(cuenta);
  }
  cuenta.textContent = n;
}

/*
 * Al cambiar el tamaño de la ventana se repinta sólo si cambia la forma.
 *
 * Girar el teléfono puede hacer que el cuadro pase a entrar, o al revés.
 * Repintar en cada píxel del arrastre le sacaría el foco a quien está
 * escribiendo una cantidad, así que se mira si la decisión cambió y recién
 * ahí se rehace.
 */
let entrabaElCuadro = null;
window.addEventListener('resize', () => {
  if (!actual) return;
  const ahora = entraElCuadro(actual.talles.filter(Boolean).length);
  if (ahora === entrabaElCuadro) return;
  entrabaElCuadro = ahora;
  formaForzada = null;
  pintar();
});

el('#panel-agregar').addEventListener('click', () => {
  if (!actual) return;
  const c = cuentaDeEntrada(actual.sku, borrador);
  if (c.unidades > 0) {
    estado.carrito[actual.sku] = {
      curvas: borrador.curvas || 0,
      curvasPorColor: borrador.curvasPorColor || {},
      cantidades: borrador.cantidades,
    };
  } else {
    delete estado.carrito[actual.sku];
  }
  guardarCarrito();
  refrescarFlotante();
  pintarCatalogo();
  cerrarPanel();
});
