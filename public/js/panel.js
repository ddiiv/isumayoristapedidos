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
  refrescarFlotante, pintarCatalogo,
} from './app.js';

let actual = null;      // producto abierto
let borrador = null;    // { curvas, cantidades }
let modo = 'talles';    // 'talles' | 'curva'
let colorActivo = null;
let devolverFocoA = null;

const panel = el('#panel');
const telon = el('#telon');

const clonar = (o) => JSON.parse(JSON.stringify(o));

export function abrirPanel(sku) {
  const producto = productoPorSku(sku);
  if (!producto) return;

  devolverFocoA = document.activeElement;
  actual = producto;
  borrador = clonar(estado.carrito[sku] || { curvas: 0, cantidades: {} });
  borrador.cantidades = borrador.cantidades || {};
  modo = borrador.curvas > 0 ? 'curva' : 'talles';
  colorActivo = producto.colores[0] ?? '';

  el('#panel-titulo').textContent = producto.titulo;
  el('#panel-sku').textContent = `${producto.sku}${producto.modelo ? ` · ${producto.modelo}` : ''}`;

  panel.hidden = false;
  requestAnimationFrame(() => {
    panel.classList.add('abierto');
    telon.classList.add('abierto');
    panel.focus();
  });
  document.body.style.overflow = 'hidden';
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
function combinacionesDe(color) {
  return actual.combinaciones.filter((c) => c.color === color);
}

function unidadesDeColor(color) {
  return combinacionesDe(color)
    .reduce((t, c) => t + enteroPositivo(borrador.cantidades[c.sku]), 0);
}

function vistaTalles() {
  const conColores = actual.colores.filter(Boolean).length > 0;
  const selector = conColores ? `
    <p class="rotulo">COLOR</p>
    <div class="colores-selector" id="selector-color">
      ${actual.colores.map((c) => {
        const n = unidadesDeColor(c);
        return `<button data-color="${esc(c)}" aria-pressed="${c === colorActivo}">
          ${esc(c || 'Único')}${n ? `<span class="cuenta">${n}</span>` : ''}
        </button>`;
      }).join('')}
    </div>` : '';

  const combos = combinacionesDe(colorActivo);
  const filas = combos.map((c) => `
    <div class="fila-talle">
      <span class="talle">${esc(c.talle || 'Único')}
        <span class="precio-unit">${pesos(c.precio)}</span></span>
      <span class="contador">
        <button data-menos="${esc(c.sku)}" aria-label="Quitar uno de ${esc(c.talle)}">−</button>
        <input type="number" min="0" inputmode="numeric" data-sku="${esc(c.sku)}"
               value="${enteroPositivo(borrador.cantidades[c.sku]) || ''}" placeholder="0"
               aria-label="Cantidad de ${esc(c.talle || 'talle único')} en ${esc(colorActivo || 'color único')}">
        <button data-mas="${esc(c.sku)}" aria-label="Agregar uno de ${esc(c.talle)}">+</button>
      </span>
    </div>`).join('');

  return `${selector}
    <p class="rotulo">TALLES ${conColores ? `· ${esc(colorActivo || 'ÚNICO')}` : ''}</p>
    <div class="matriz" id="matriz">${filas}</div>`;
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
    <p class="rotulo">CUÁNTAS CURVAS</p>
    <div class="fila-talle">
      <span class="talle">Curvas completas</span>
      <span class="contador">
        <button data-curva="-1" aria-label="Una curva menos">−</button>
        <input type="number" min="0" inputmode="numeric" id="curvas"
               value="${borrador.curvas || ''}" placeholder="0" aria-label="Cantidad de curvas">
        <button data-curva="1" aria-label="Una curva más">+</button>
      </span>
    </div>`;
}

function pintar() {
  const foto = (colorActivo && actual.fotosPorColor[colorActivo]) || actual.foto;
  const cabecera = modo === 'curva' ? '' : `
    <div class="foto-grande">
      ${foto ? `<img src="${esc(foto)}" alt="${esc(actual.titulo)}${colorActivo ? ` en ${esc(colorActivo)}` : ''}">`
             : '<span class="sin-foto">SIN FOTO</span>'}
    </div>`;

  el('#panel-contenido').innerHTML = `
    ${cabecera}
    <div class="modos" role="group" aria-label="Cómo cargar las cantidades">
      <button data-modo="talles" aria-pressed="${modo === 'talles'}">Por talle</button>
      <button data-modo="curva" aria-pressed="${modo === 'curva'}">Por curva</button>
    </div>
    ${modo === 'curva' ? vistaCurva() : vistaTalles()}`;

  refrescarPie();
}

function refrescarPie() {
  const c = cuentaDeEntrada(actual.sku, borrador);
  el('#panel-unidades').textContent = `${c.unidades} unidad${c.unidades === 1 ? '' : 'es'}`;
  el('#panel-subtotal').textContent = pesos(c.subtotal);
  el('#panel-agregar').disabled = c.unidades === 0 && !estado.carrito[actual.sku];
  el('#panel-agregar').textContent = c.unidades === 0 && estado.carrito[actual.sku]
    ? 'Quitar del pedido' : 'Agregar al pedido';
}

// ── Interacción ───────────────────────────────────────────────────
el('#panel-contenido').addEventListener('click', (e) => {
  if (!actual) return;
  const b = e.target.closest('button');
  if (!b) return;

  if (b.dataset.modo) {
    modo = b.dataset.modo;
    /*
     * Cambiar de modo no borra lo cargado en el otro.
     *
     * Alguien que carga tres curvas y después mira la matriz de talles para
     * sumar dos remeras sueltas espera que las curvas sigan ahí. Los dos modos
     * conviven: el pedido es la suma.
     */
    pintar();
    return;
  }
  if (b.dataset.color !== undefined) { colorActivo = b.dataset.color; pintar(); return; }

  if (b.dataset.curva) {
    borrador.curvas = enteroPositivo(borrador.curvas + Number(b.dataset.curva));
    el('#curvas').value = borrador.curvas || '';
    refrescarPie();
    return;
  }

  const skuMas = b.dataset.mas;
  const skuMenos = b.dataset.menos;
  const sku = skuMas || skuMenos;
  if (!sku) return;

  const actualN = enteroPositivo(borrador.cantidades[sku]);
  const nuevo = enteroPositivo(actualN + (skuMas ? 1 : -1));
  if (nuevo) borrador.cantidades[sku] = nuevo; else delete borrador.cantidades[sku];

  const input = el(`input[data-sku="${CSS.escape(sku)}"]`);
  if (input) input.value = nuevo || '';
  // El contador del color en el selector cambia con cada suma, así que se
  // repinta: sin eso, la persona no ve cuánto lleva cargado en los otros colores.
  if (modo === 'talles' && actual.colores.filter(Boolean).length) pintar();
  else refrescarPie();
});

el('#panel-contenido').addEventListener('input', (e) => {
  if (!actual) return;
  const input = e.target;
  if (input.id === 'curvas') {
    borrador.curvas = enteroPositivo(input.value);
    refrescarPie();
    return;
  }
  const sku = input.dataset?.sku;
  if (!sku) return;
  const n = enteroPositivo(input.value);
  if (n) borrador.cantidades[sku] = n; else delete borrador.cantidades[sku];
  refrescarPie();
  actualizarInsigniaDeColor();
});

/*
 * La insignia del color se actualiza sola, sin repintar.
 *
 * Repintar en cada tecla reconstruye el input que la persona está usando y le
 * saca el foco a mitad de un número. Se toca sólo el contador del color activo,
 * que es lo único que cambió.
 */
function actualizarInsigniaDeColor() {
  const boton = el(`#selector-color button[data-color="${CSS.escape(colorActivo)}"]`);
  if (!boton) return;
  const n = unidadesDeColor(colorActivo);
  let insignia = boton.querySelector('.cuenta');
  if (!n) { insignia?.remove(); return; }
  if (!insignia) {
    insignia = document.createElement('span');
    insignia.className = 'cuenta';
    boton.append(insignia);
  }
  insignia.textContent = n;
}

el('#panel-agregar').addEventListener('click', () => {
  if (!actual) return;
  const c = cuentaDeEntrada(actual.sku, borrador);
  if (c.unidades > 0) {
    estado.carrito[actual.sku] = { curvas: borrador.curvas || 0, cantidades: borrador.cantidades };
  } else {
    delete estado.carrito[actual.sku];
  }
  guardarCarrito();
  refrescarFlotante();
  pintarCatalogo();
  cerrarPanel();
});
