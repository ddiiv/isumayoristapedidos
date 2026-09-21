/*
 * El diálogo del pedido: revisar, cargar los datos, previsualizar y confirmar.
 *
 * Cuatro pasos en un mismo diálogo en vez de cuatro pantallas: el cliente no
 * pierde de vista lo que está pidiendo mientras carga la dirección, y volver
 * atrás no recarga el catálogo.
 */

import { el, esc, pesos } from './util.js';
import {
  estado, productoPorSku, cuentaDeEntrada, totalesDelCarrito,
  guardarCarrito, refrescarFlotante, pintarCatalogo,
} from './app.js';
import { sesion, abrirCuenta } from './sesion.js';
import { medir, olvidarCarrito } from './medir.js';

const dialogo = el('#dialogo');
const cuerpo = el('#dialogo-cuerpo');
const pie = el('#dialogo-pie');

let paso = 'carrito';
let datosCliente = {};
let erroresCliente = {};
let confirmado = null;
let enviando = false;

const CLAVE_DATOS = 'isuwaya.datos.v1';

const PROVINCIAS = ['Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes',
  'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén',
  'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán'];

/*
 * La forma de envío la escribe el cliente.
 *
 * Era una lista cerrada de siete transportes, y cada mayorista del interior
 * trabaja con el suyo —un expreso de su zona, un flete conocido—: con la lista
 * elegía el más parecido y el rótulo salía con un transporte que no era.
 */

export function abrirDialogo() {
  paso = 'carrito';
  confirmado = null;
  erroresCliente = {};

  /*
   * Con la sesión abierta, los datos salen de la cuenta.
   *
   * Y se releen en cada pedido, no se arrastra lo que se editó en el anterior:
   * si alguien mandó un pedido a otra sucursal, el siguiente tiene que volver
   * a su dirección de siempre. Editar acá cambia SÓLO este envío; para cambiar
   * la cuenta está «Mi cuenta».
   *
   * Sin sesión se usa lo último que se tipeó en este navegador, que para quien
   * pide sin cuenta es la única memoria que hay.
   */
  if (sesion.rol === 'cliente' && sesion.datosDePedido) {
    datosCliente = { ...sesion.datosDePedido };
  } else {
    try { datosCliente = JSON.parse(localStorage.getItem(CLAVE_DATOS) || '{}'); } catch { datosCliente = {}; }
  }
  dialogo.classList.add('abierto');
  document.body.style.overflow = 'hidden';
  pintar();
}

export function cerrarDialogo() {
  // Con el pedido ya confirmado, cerrar limpia el carrito: dejarlo cargado
  // invita a mandar el mismo pedido dos veces.
  if (confirmado) {
    estado.carrito = {};
    guardarCarrito();
    refrescarFlotante();
    pintarCatalogo();
  }
  dialogo.classList.remove('abierto');
  document.body.style.overflow = '';
}

// ── Paso 1: el carrito ────────────────────────────────────────────
/*
 * El desglose por color, con las curvas ya abiertas.
 *
 * Una curva son unidades reales de cada color y talle, pero en el carrito viven
 * como un número de curvas. Mostrando sólo "2 curvas", el cliente ve una cosa
 * acá y otra en el resumen del servidor, que sí las expande — y la diferencia
 * aparece justo cuando está por confirmar. Se abre igual que en el servidor.
 */
function lineasDeEntrada(producto, entrada) {
  const curvas = Number(entrada.curvas) || 0;
  const porColorCurvas = entrada.curvasPorColor || {};
  const porColor = new Map();

  for (const c of producto.combinaciones) {
    const n = (Number(entrada.cantidades?.[c.sku]) || 0)
      + curvas
      + (Number(porColorCurvas[c.color]) || 0);
    if (!n) continue;
    if (!porColor.has(c.color)) porColor.set(c.color, []);
    porColor.get(c.color).push(`${esc(c.talle || 'Único')}×${n}`);
  }
  return [...porColor.entries()]
    .map(([color, talles]) => `<div><b>${esc(color || 'Único')}</b> · ${talles.join('  ')}</div>`)
    .join('');
}

/*
 * Las curvas de un color se muestran aparte de la curva entera.
 *
 * Las dos terminan sumando unidades a los mismos casilleros, así que sin este
 * renglón el carrito diría "36 unidades" sin explicar de dónde salieron, y
 * quien revisa antes de confirmar no puede saber si pidió lo que quería.
 */
function curvasDeColor(producto, entrada) {
  const filas = Object.entries(entrada.curvasPorColor || {})
    .filter(([, n]) => Number(n) > 0)
    .map(([color, n]) => {
      const combos = producto.combinaciones.filter((c) => c.color === color);
      const unidades = Number(n) * combos.length;
      return `${Number(n)} × curva de <b>${esc(color)}</b> · ${unidades} u.`;
    });
  return filas.length ? `<div class="curva">${filas.join('<br>')}</div>` : '';
}

function vistaCarrito() {
  const entradas = Object.entries(estado.carrito)
    .map(([sku, entrada]) => ({ sku, entrada, producto: productoPorSku(sku) }))
    .filter((x) => x.producto && cuentaDeEntrada(x.sku, x.entrada).unidades > 0);

  if (!entradas.length) {
    return `<div class="vacio"><h3>Tu pedido está vacío</h3>
      <p>Volvé al catálogo y agregá productos.</p></div>`;
  }

  const items = entradas.map(({ sku, entrada, producto }) => {
    const c = cuentaDeEntrada(sku, entrada);
    return `
      <div class="resumen-item">
        <div class="encabezado">
          <div>
            <h4>${esc(producto.titulo)}</h4>
            <div class="categoria">${esc(producto.sku)} · ${c.unidades} u.</div>
          </div>
          <div class="importe">${pesos(c.subtotal)}</div>
        </div>
        ${entrada.curvas ? `<div class="curva">${entrada.curvas} curva${entrada.curvas === 1 ? '' : 's'} completa${entrada.curvas === 1 ? '' : 's'} · ${entrada.curvas * producto.unidadesPorCurva} u.</div>` : ''}
        ${curvasDeColor(producto, entrada)}
        <div class="lineas">${lineasDeEntrada(producto, entrada)}</div>
        <button class="quitar" data-quitar="${esc(sku)}">Quitar del pedido</button>
      </div>`;
  }).join('');

  const { unidades, total } = totalesDelCarrito();
  return `${items}
    <div class="total-caja">
      <div><div class="u">${unidades} unidades</div><div>Total del pedido</div></div>
      <div class="n">${pesos(total)}</div>
    </div>`;
}

// ── Paso 2: los datos ─────────────────────────────────────────────
function campo(nombre, etiqueta, { obligatorio = false, tipo = 'text', ancho = false, opciones = null, ayuda = '' } = {}) {
  const valor = esc(datosCliente[nombre] || '');
  const error = erroresCliente[nombre];
  const control = opciones
    ? `<select name="${nombre}" aria-invalid="${Boolean(error)}">
         <option value="">Elegí…</option>
         ${opciones.map((o) => `<option value="${esc(o)}"${datosCliente[nombre] === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
       </select>`
    : `<input name="${nombre}" type="${tipo}" value="${valor}" aria-invalid="${Boolean(error)}"
              ${ayuda ? `placeholder="${esc(ayuda)}"` : ''} autocomplete="${autocompletado(nombre)}">`;

  return `<div class="campo${ancho ? ' ancho' : ''}">
      <label>${esc(etiqueta)}${obligatorio ? ' <span class="req">*</span>' : ''}</label>
      ${control}
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
    </div>`;
}

// Los nombres de autocompletado del navegador: sin esto, el teléfono no ofrece
// la dirección que ya tiene guardada y hay que tipearla entera.
const autocompletado = (n) => ({
  nombre: 'name', telefono: 'tel', email: 'email', provincia: 'address-level1',
  ciudad: 'address-level2', codigoPostal: 'postal-code', direccion: 'street-address',
}[n] || 'off');

function vistaDatos() {
  return `
    ${sesion.rol === 'cliente'
      ? `<p class="mensaje ok">Completamos con los datos de tu cuenta. Si este envío va a otra dirección, cambialos acá: se usan sólo para este pedido.</p>`
      : `<p class="mensaje info">Con estos datos armamos el rótulo del paquete. Si ya compraste, empezá por el CUIT: completamos tus datos.
           <button class="btn texto enlace-texto" id="ir-a-entrar" >Entrá a tu cuenta</button> y se completan solos.</p>`}
    <form id="form-datos" class="campos" novalidate>
      ${campo('cuit', 'CUIT', { obligatorio: true, ayuda: '30-12345678-9' })}
      <div class="campo ancho aviso-cuit" id="aviso-cuit" hidden></div>
      ${campo('nombre', 'Nombre y apellido', { obligatorio: true, ancho: true })}
      ${campo('telefono', 'Teléfono', { obligatorio: true, tipo: 'tel', ayuda: '11 5555-5555' })}
      ${campo('email', 'Email', { tipo: 'email', ancho: true, ayuda: 'Opcional: ahí te mandamos el pedido y la confirmación del stock' })}
      ${campo('provincia', 'Provincia', { obligatorio: true, opciones: PROVINCIAS })}
      ${campo('ciudad', 'Ciudad', { obligatorio: true })}
      ${campo('codigoPostal', 'Código postal', { obligatorio: true, ayuda: '1425' })}
      ${campo('direccion', 'Dirección', { obligatorio: true, ayuda: 'Calle, número, piso' })}
      ${campo('entreCalles', 'Entre calles', { ancho: true, ayuda: 'Opcional' })}
      ${campo('formaEnvio', 'Forma de envío o transporte', { obligatorio: true, ancho: true, ayuda: 'Ej.: Andreani a sucursal, Vía Cargo, transporte propio' })}
    </form>`;
}

function leerFormulario() {
  const form = el('#form-datos');
  if (!form) return;
  for (const control of form.elements) {
    if (control.name) datosCliente[control.name] = control.value.trim();
  }
  // Sólo se recuerda en el navegador lo de quien NO tiene cuenta: para el que
  // sí la tiene, la memoria es la cuenta, y dejar una copia en el equipo sería
  // guardar su dirección en una computadora que puede ser compartida.
  if (sesion.rol !== 'cliente') {
    try { localStorage.setItem(CLAVE_DATOS, JSON.stringify(datosCliente)); } catch { /* modo privado */ }
  }
}

// ── Paso 3: el resumen ────────────────────────────────────────────
let previsualizacion = null;

function vistaResumen() {
  if (!previsualizacion) return '<p class="cargando">Armando el resumen…</p>';
  const c = previsualizacion.cliente;
  const items = previsualizacion.items.map((it) => `
    <div class="resumen-item">
      <div class="encabezado">
        <div><h4>${esc(it.titulo)}</h4>
          <div class="categoria">${esc(it.categoria)} · ${it.unidades} u.</div></div>
        <div class="importe">${pesos(it.subtotal)}</div>
      </div>
      ${it.curvas ? `<div class="curva">${it.curvas} curva${it.curvas === 1 ? '' : 's'}</div>` : ''}
      <div class="lineas">${it.detalle.map((d) =>
        `<div><b>${esc(d.color || 'Único')}</b> · ${d.talles.map((t) => `${esc(t.talle)}×${t.cantidad}`).join('  ')}</div>`).join('')}</div>
    </div>`).join('');

  return `
    <p class="rotulo">ENVIAR A</p>
    <div class="resumen-item">
      <h4>${esc(c.nombre)}</h4>
      <div class="lineas">
        CUIT ${esc(c.cuit)} · Tel. ${esc(c.telefono)}${c.email ? ` · ${esc(c.email)}` : ''}<br>
        ${esc(c.direccion)}${c.entreCalles ? ` (entre ${esc(c.entreCalles)})` : ''}<br>
        ${esc(c.ciudad)} (${esc(c.codigoPostal)}), ${esc(c.provincia)}<br>
        <b>${esc(c.formaEnvio)}</b>
      </div>
    </div>
    <p class="rotulo separado">PRODUCTOS</p>
    ${items}
    <div class="total-caja">
      <div><div class="u">${previsualizacion.unidades} unidades</div><div>Total del pedido</div></div>
      <div class="n">${pesos(previsualizacion.total)}</div>
    </div>`;
}

// ── Paso 4: confirmado ────────────────────────────────────────────
function vistaConfirmado() {
  /*
   * El mensaje dice lo que de verdad pasó.
   *
   * Decir "ya le avisamos" cuando el mail no salió es afirmar algo que el
   * cliente no puede comprobar y que, si es falso, descubre recién cuando
   * nadie lo contacta. El pedido SÍ quedó guardado en los dos casos —eso es lo
   * que no se pierde—, así que se afirma eso, y si ningún aviso salió se le da
   * algo que hacer en vez de una espera silenciosa.
   */
  const avisado = ['mail', 'whatsapp'].some((c) => confirmado.avisos?.[c] === 'ok');
  /*
   * Y dice que todavía falta un paso: el pedido no está confirmado hasta que
   * ISUWAYA revise el stock. Sin eso, "recibimos tu pedido" se lee como "ya
   * está", y el cliente cuenta con mercadería que puede no haber.
   */
  const seEntera = confirmado.avisos?.cliente === 'ok'
    ? 'Te mandamos una copia por mail y te escribimos apenas lo confirmemos.'
    : sesion.rol === 'cliente'
      ? 'Vas a ver la confirmación en «Mis pedidos».'
      : 'Si nadie te contacta en las próximas 24 horas, escribinos con este número de pedido.';
  const cabecera = `<p class="mensaje ok">Recibimos tu pedido${avisado ? ' y ya le avisamos a ISUWAYA' : ' y quedó guardado'}.</p>`
    + '<p class="mensaje info">Antes de prepararlo revisamos que tengamos todo el stock. '
    + `${esc(seEntera)}</p>`;

  return `
    <div class="confirmado">
      ${cabecera}
      <div class="numero">${esc(confirmado.numero)}</div>
      <p class="apagado sin-margen">
        ${confirmado.unidades} unidades · ${pesos(confirmado.total)}
      </p>
      <div class="descargas">
        <a class="btn azul" href="/api/pedidos/${encodeURIComponent(confirmado.numero)}/pedido.pdf${
          confirmado.token ? `?t=${encodeURIComponent(confirmado.token)}` : ''}">Descargar el pedido</a>
      </div>
      <p class="chico-2 separado">
        Guardá el número por si necesitás consultarlo.
      </p>
    </div>`;
}

// ── Pintado y navegación ──────────────────────────────────────────
function pintar() {
  const hay = totalesDelCarrito().unidades > 0;

  if (paso === 'carrito') {
    el('#dialogo-titulo').textContent = 'Tu pedido';
    cuerpo.innerHTML = vistaCarrito();
    pie.innerHTML = hay
      ? `<button class="btn texto" data-ir="cerrar">Seguir agregando</button>
         <button class="btn" data-ir="datos">Continuar</button>`
      : '<button class="btn azul" data-ir="cerrar">Ver el catálogo</button>';
  } else if (paso === 'datos') {
    el('#dialogo-titulo').textContent = 'Datos para el envío';
    cuerpo.innerHTML = vistaDatos();
    pie.innerHTML = `<button class="btn texto" data-ir="carrito">Volver</button>
                     <button class="btn" data-ir="resumen">Ver el resumen</button>`;
  } else if (paso === 'resumen') {
    el('#dialogo-titulo').textContent = 'Revisá antes de confirmar';
    cuerpo.innerHTML = vistaResumen();
    pie.innerHTML = `<button class="btn texto" data-ir="datos">Corregir datos</button>
                     <button class="btn borde" id="bajar-pdf">Descargar PDF</button>
                     <button class="btn" id="confirmar"${enviando ? ' disabled' : ''}>
                       ${enviando ? 'Enviando…' : 'Confirmar pedido'}</button>`;
  } else {
    el('#dialogo-titulo').textContent = 'Pedido confirmado';
    cuerpo.innerHTML = vistaConfirmado();
    pie.innerHTML = '<button class="btn azul" data-ir="cerrar">Listo</button>';
  }
  dialogo.querySelector('.caja').scrollIntoView({ block: 'start' });
}

function cuerpoDelPedido() {
  return {
    cliente: datosCliente,
    carrito: Object.entries(estado.carrito).map(([sku, e]) => ({
      skuAgrupador: sku,
      curvas: e.curvas || 0,
      curvasPorColor: e.curvasPorColor || {},
      cantidades: e.cantidades || {},
    })),
  };
}

async function irAResumen() {
  leerFormulario();
  previsualizacion = null;
  paso = 'resumen';
  pintar();

  const r = await fetch('/api/pedidos/previsualizar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpoDelPedido()),
  });
  const datos = await r.json().catch(() => ({}));

  /*
   * Los errores del formulario los decide el servidor, no el navegador.
   *
   * La validación de acá es comodidad; la que cuenta es la del servidor, que es
   * la que nadie puede saltear. Con dos juegos de reglas, tarde o temprano una
   * acepta lo que la otra rechaza y el cliente ve un error recién al confirmar.
   */
  erroresCliente = datos.erroresCliente || {};
  if (Object.keys(erroresCliente).length) {
    paso = 'datos';
    pintar();
    el('#form-datos')?.querySelector('[aria-invalid="true"]')?.focus();
    return;
  }
  if (!r.ok) {
    paso = 'carrito';
    pintar();
    cuerpo.insertAdjacentHTML('afterbegin',
      `<p class="mensaje error">${esc(datos.message || 'No pudimos armar el pedido.')}</p>`);
    return;
  }
  previsualizacion = datos;
  pintar();
}

async function bajarPdf(boton) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Generando…';
  try {
    const r = await fetch('/api/pedidos/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoDelPedido()),
    });
    if (!r.ok) throw new Error('falló');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pedido-isuwaya.pdf';
    a.click();
    // Se libera enseguida: cada blob que queda vivo retiene el PDF entero en
    // memoria, y alguien que descarga cinco veces se lleva cinco copias.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    cuerpo.insertAdjacentHTML('afterbegin',
      '<p class="mensaje error">No pudimos generar el PDF. Probá de nuevo.</p>');
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}

async function confirmar(boton) {
  if (enviando) return;
  enviando = true;
  boton.disabled = true;
  boton.textContent = 'Enviando…';
  /*
   * Lo que va en el pedido se anota ANTES de mandarlo: al confirmar, el carrito
   * se vacía, y después ya no hay de dónde sacar qué se pidió.
   */
  const loPedido = Object.entries(estado.carrito).map(([sku, entrada]) => {
    const c = cuentaDeEntrada(sku, entrada);
    return { sku, unidades: c.unidades, valor: Math.round(c.subtotal) };
  }).filter((x) => x.unidades > 0);
  try {
    const r = await fetch('/api/pedidos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpoDelPedido()),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      erroresCliente = datos.erroresCliente || {};
      paso = Object.keys(erroresCliente).length ? 'datos' : 'carrito';
      pintar();
      cuerpo.insertAdjacentHTML('afterbegin',
        `<p class="mensaje error">${esc(datos.message || 'No pudimos confirmar el pedido.')}</p>`);
      return;
    }
    confirmado = datos;
    for (const p of loPedido) medir('pedido', p);
    // Ya no es un carrito abandonado: se confirmó.
    olvidarCarrito();
    paso = 'listo';
    pintar();
  } catch {
    pintar();
    cuerpo.insertAdjacentHTML('afterbegin',
      '<p class="mensaje error">Se cortó la conexión. Revisá si el pedido llegó antes de mandarlo de nuevo.</p>');
  } finally {
    enviando = false;
  }
}

dialogo.addEventListener('click', async (e) => {
  const quitar = e.target.closest('[data-quitar]');
  if (quitar) {
    delete estado.carrito[quitar.dataset.quitar];
    guardarCarrito();
    refrescarFlotante();
    pintarCatalogo();
    pintar();
    return;
  }

  const ir = e.target.closest('[data-ir]');
  if (ir) {
    const destino = ir.dataset.ir;
    if (destino === 'cerrar') return cerrarDialogo();
    if (destino === 'resumen') return irAResumen();
    if (destino === 'datos' && paso === 'resumen') leerFormulario();
    if (destino === 'carrito' && paso === 'datos') leerFormulario();
    paso = destino;
    pintar();
    return;
  }

  if (e.target.id === 'ir-a-entrar') { cerrarDialogo(); abrirCuenta('entrar'); return; }
  if (e.target.id === 'bajar-pdf') return bajarPdf(e.target);
  if (e.target.id === 'confirmar') return confirmar(e.target);
});

/*
 * El CUIT completa lo que ya se sabe del cliente.
 *
 * Quien ya compró no vuelve a escribir su nombre, su teléfono y su email: al
 * poner el CUIT llegan solos. La dirección no, porque cada pedido puede ir a
 * otro lado. El teléfono y el email llegan tapados —"•• ••••-1234"—: la página
 * es pública y cualquiera puede escribir un CUIT. Si se dejan así, el servidor
 * usa los guardados; si se escriben otros, se usan los nuevos.
 *
 * Con la sesión abierta no hace falta: los datos ya salen de la cuenta.
 */
let cuitBuscado = '';
let esperaCuit = null;

function avisoCuit(texto) {
  const aviso = el('#aviso-cuit');
  if (!aviso) return;
  aviso.textContent = texto;
  aviso.hidden = !texto;
}

async function buscarCuit(digitos, form) {
  let datos;
  try {
    const r = await fetch('/api/clientes/por-cuit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cuit: digitos }),
    });
    // Un CUIT que no valida, o demasiadas búsquedas: el formulario sigue como está.
    if (!r.ok) return;
    datos = await r.json();
  } catch { return; }
  // Si mientras tanto cambió el CUIT o se cerró el formulario, la respuesta ya no corresponde.
  if (!form.isConnected || form.elements.cuit.value.replace(/\D/g, '') !== digitos) return;
  cuitBuscado = digitos;
  if (!datos.encontrado) return;
  for (const campo of ['nombre', 'telefono', 'email']) {
    if (datos[campo] && form.elements[campo]) form.elements[campo].value = datos[campo];
  }
  avisoCuit('Ya compraste con este CUIT: completamos tus datos. Si cambiaron, escribilos de nuevo.');
}

dialogo.addEventListener('input', (e) => {
  if (e.target.name !== 'cuit' || sesion.rol === 'cliente') return;
  const form = e.target.form;
  const digitos = e.target.value.replace(/\D/g, '');
  if (digitos !== cuitBuscado) {
    // Otro CUIT: lo tapado era de otro cliente y ya no sirve.
    for (const campo of ['telefono', 'email']) {
      if (form.elements[campo]?.value.includes('•')) form.elements[campo].value = '';
    }
    avisoCuit('');
  }
  clearTimeout(esperaCuit);
  if (digitos.length === 11 && digitos !== cuitBuscado) esperaCuit = setTimeout(() => buscarCuit(digitos, form), 300);
});

// Tocar un dato tapado lo selecciona entero: lo que se escriba lo reemplaza, no se mezcla con los puntitos.
dialogo.addEventListener('focusin', (e) => {
  if (['telefono', 'email'].includes(e.target.name) && e.target.value.includes('•')) e.target.select();
});
