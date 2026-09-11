/*
 * Entrar, crear cuenta y ver la propia cuenta.
 *
 * Una sola puerta: el mismo formulario para el dueño y para los clientes. El
 * servidor devuelve el rol y la pantalla se acomoda. Dos accesos separados
 * obligan a elegir bien antes de saber si te equivocaste.
 */

import { el, esc, pesos } from './util.js';

export const sesion = { rol: null, cliente: null, datosDePedido: null };

const dialogo = el('#dialogo-cuenta');
const cuerpo = el('#cuenta-cuerpo');
const titulo = el('#cuenta-titulo');

let vista = 'entrar';   // entrar | registro | cuenta | pedidos | seguimiento | password
let errores = {};
let mensaje = null;
let ocupado = false;

const PROVINCIAS = ['Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes',
  'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja', 'Mendoza', 'Misiones', 'Neuquén',
  'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán'];
const ENVIOS = ['Andreani a sucursal', 'Andreani a domicilio', 'Correo Argentino a sucursal',
  'Correo Argentino a domicilio', 'Vía Cargo', 'Transporte propio del cliente', 'Retiro en el depósito'];

const api = async (ruta, opciones = {}) => {
  const r = await fetch(ruta, {
    headers: { 'Content-Type': 'application/json' }, ...opciones,
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(datos.message || 'Falló'), { status: r.status, datos });
  return datos;
};

// ── Estado en la barra de arriba ──────────────────────────────────
export function pintarBarra() {
  const cont = el('#estado-sesion');
  if (sesion.rol === 'admin') {
    cont.innerHTML = `
      <a class="btn-barra" href="/admin.html">Panel</a>
      <button class="btn-barra" data-accion="salir">Salir</button>`;
  } else if (sesion.rol === 'cliente') {
    const nombre = String(sesion.cliente?.nombre || '').split(' ')[0];
    cont.innerHTML = `
      <button class="btn-barra" data-accion="cuenta">Mi cuenta<small>${esc(nombre)}</small></button>
      <button class="btn-barra" data-accion="salir">Salir</button>`;
  } else {
    cont.innerHTML = '<button class="btn-barra" data-accion="entrar">Entrar</button>';
  }
}

export async function cargarSesion() {
  try {
    const datos = await api('/api/sesion');
    sesion.rol = datos.rol;
    sesion.cliente = datos.cliente || null;
    sesion.datosDePedido = datos.datosDePedido || null;
  } catch {
    sesion.rol = null;
  }
  pintarBarra();
}

// ── Diálogo ───────────────────────────────────────────────────────
export function abrirCuenta(cual = null) {
  vista = cual || (sesion.rol === 'cliente' ? 'cuenta' : 'entrar');
  errores = {}; mensaje = null;
  dialogo.classList.add('abierto');
  document.body.style.overflow = 'hidden';
  pintar();
}

export function cerrarCuenta() {
  dialogo.classList.remove('abierto');
  document.body.style.overflow = '';
}

function campo(nombre, etiqueta, { obligatorio = false, tipo = 'text', ancho = false, opciones = null, valor = '', ayuda = '' } = {}) {
  const err = errores[nombre];
  const control = opciones
    ? `<select name="${nombre}" aria-invalid="${Boolean(err)}">
         <option value="">Elegí…</option>
         ${opciones.map((o) => `<option${o === valor ? ' selected' : ''}>${esc(o)}</option>`).join('')}
       </select>`
    : `<input name="${nombre}" type="${tipo}" value="${esc(valor)}" aria-invalid="${Boolean(err)}"
              ${ayuda ? `placeholder="${esc(ayuda)}"` : ''}>`;
  return `<div class="campo${ancho ? ' ancho' : ''}">
      <label>${esc(etiqueta)}${obligatorio ? ' <span class="req">*</span>' : ''}</label>
      ${control}${err ? `<div class="error">${esc(err)}</div>` : ''}
    </div>`;
}

function vistaEntrar() {
  return `
    <p class="mensaje info">Si tenés cuenta, tus datos de envío se completan solos al hacer el pedido.</p>
    <form id="form-sesion" class="campos" novalidate>
      ${campo('email', 'Email', { obligatorio: true, tipo: 'email', ancho: true })}
      ${campo('password', 'Contraseña', { obligatorio: true, tipo: 'password', ancho: true })}
    </form>
    <p class="nota">
      ¿Todavía no tenés cuenta?
      <button class="btn texto enlace-texto" data-vista="registro" >Creala acá</button>
    </p>`;
}

function vistaRegistro() {
  const d = sesion.datosDePedido || {};
  return `
    <p class="mensaje info">Cargá una vez tus datos y no los volvés a tipear en cada pedido.</p>
    <form id="form-registro" class="campos" novalidate>
      ${campo('email', 'Email', { obligatorio: true, tipo: 'email', valor: d.email })}
      ${campo('password', 'Contraseña', { obligatorio: true, tipo: 'password', ayuda: 'Mínimo 8 caracteres' })}
      ${campo('nombre', 'Nombre y apellido', { obligatorio: true, ancho: true, valor: d.nombre })}
      ${campo('cuit', 'CUIT', { obligatorio: true, valor: d.cuit, ayuda: '30-12345678-9' })}
      ${campo('telefono', 'Teléfono', { obligatorio: true, tipo: 'tel', valor: d.telefono })}
      ${campo('provincia', 'Provincia', { obligatorio: true, opciones: PROVINCIAS, valor: d.provincia })}
      ${campo('ciudad', 'Ciudad', { obligatorio: true, valor: d.ciudad })}
      ${campo('codigoPostal', 'Código postal', { obligatorio: true, valor: d.codigoPostal })}
      ${campo('direccion', 'Dirección', { obligatorio: true, valor: d.direccion })}
      ${campo('entreCalles', 'Entre calles', { ancho: true, valor: d.entreCalles, ayuda: 'Opcional' })}
      ${campo('formaEnvio', 'Forma de envío habitual', { obligatorio: true, ancho: true, opciones: ENVIOS, valor: d.formaEnvio })}
    </form>
    <p class="nota">
      ¿Ya tenés cuenta? <button class="btn texto enlace-texto" data-vista="entrar" >Entrá acá</button>
    </p>`;
}

function vistaCuenta() {
  const d = sesion.datosDePedido || {};
  return `
    <p class="mensaje info">
      Estos son los datos con los que se completa tu pedido. Podés cambiarlos acá,
      o dejarlos y editar sólo ese pedido cuando lo hagas.
    </p>
    <form id="form-cuenta" class="campos" novalidate>
      ${campo('nombre', 'Nombre y apellido', { obligatorio: true, ancho: true, valor: d.nombre })}
      ${campo('cuit', 'CUIT', { obligatorio: true, valor: d.cuit })}
      ${campo('telefono', 'Teléfono', { obligatorio: true, tipo: 'tel', valor: d.telefono })}
      ${campo('provincia', 'Provincia', { obligatorio: true, opciones: PROVINCIAS, valor: d.provincia })}
      ${campo('ciudad', 'Ciudad', { obligatorio: true, valor: d.ciudad })}
      ${campo('codigoPostal', 'Código postal', { obligatorio: true, valor: d.codigoPostal })}
      ${campo('direccion', 'Dirección', { obligatorio: true, valor: d.direccion })}
      ${campo('entreCalles', 'Entre calles', { ancho: true, valor: d.entreCalles })}
      ${campo('formaEnvio', 'Forma de envío habitual', { obligatorio: true, ancho: true, opciones: ENVIOS, valor: d.formaEnvio })}
    </form>
    <p class="nota separada">
      <button class="btn texto enlace-texto" data-vista="pedidos" >Ver mis pedidos</button>
      ·
      <button class="btn texto enlace-texto" data-vista="password" >Cambiar la contraseña</button>
    </p>
    <p class="nota pegada">Entrás con <b>${esc(sesion.cliente?.email || '')}</b></p>`;
}

function vistaPassword() {
  return `
    <form id="form-password" class="campos" novalidate>
      ${campo('actual', 'Contraseña actual', { obligatorio: true, tipo: 'password', ancho: true })}
      ${campo('nueva', 'Contraseña nueva', { obligatorio: true, tipo: 'password', ancho: true, ayuda: 'Mínimo 8 caracteres' })}
    </form>`;
}

/*
 * ── Mis pedidos, con el seguimiento adentro ──────────────────────
 *
 * Lo que el dueño pidió: que el cliente entre y vea en qué anda su pedido sin
 * escribir preguntando. Un estado suelto contesta la mitad —"modificado" no
 * dice qué cambió, y "enviado" no dice cuándo—, así que cada pedido muestra el
 * camino recorrido y, adentro, la línea de tiempo con lo que pasó en cada paso.
 */
let misPedidos = null;
let pedidoAbierto = null;

const ETIQUETAS = {
  confirmado: 'Confirmado', modificado: 'Modificado',
  enviado: 'Enviado', entregado: 'Entregado', cancelado: 'Cancelado',
};

const cuando = (iso, conHora = false) => (iso
  ? new Date(iso).toLocaleString('es-AR', conHora
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' })
  : 'sin fecha registrada');

/*
 * El camino, con el paso "Modificado" sólo si de verdad lo hubo.
 *
 * Dibujarlo siempre le anuncia a todo el mundo que su pedido puede cambiar
 * antes de que pase, que es preocupar sin motivo por una simetría de dibujo.
 */
function camino(p) {
  if (p.estado === 'cancelado') {
    return `<p class="seg-cortado">Este pedido está cancelado. Escribinos si lo querés rehacer.</p>`;
  }
  const pasos = ['confirmado'];
  if (p.fueModificado || p.estado === 'modificado') pasos.push('modificado');
  pasos.push('enviado', 'entregado');
  const donde = Math.max(0, pasos.indexOf(p.estado));

  return `<ol class="seg-camino" data-estado="${esc(p.estado)}">${pasos.map((paso, i) => {
    const clases = [i <= donde ? 'hecho' : '', i === donde ? 'actual' : '', paso === 'modificado' ? 'aviso' : '']
      .filter(Boolean).join(' ');
    return `<li class="${clases}"><span class="punto"></span><span class="etq">${esc(ETIQUETAS[paso])}</span></li>`;
  }).join('')}</ol>`;
}

const cabeceraDePedido = (p) => `
  <div class="seg-cabeza">
    <div>
      <div class="numero">${esc(p.numero)}</div>
      <div class="cuando">${cuando(p.creado_en)} · ${p.unidades} u.</div>
    </div>
    <div class="plata">
      <b>${pesos(p.total)}</b>
      <span class="seg-estado es-${esc(p.estado)}">${esc(ETIQUETAS[p.estado] || p.estado)}</span>
    </div>
  </div>`;

function vistaPedidos() {
  if (!misPedidos) return '<p class="cargando">Buscando tus pedidos…</p>';
  if (!misPedidos.length) {
    return `<div class="vacio"><h3>Todavía no hiciste pedidos</h3>
      <p>Cuando hagas el primero con la sesión abierta, va a aparecer acá.</p></div>`;
  }

  return misPedidos.map((p) => `
    <article class="seg-pedido${p.estado === 'cancelado' ? ' es-cancelado' : ''}">
      ${cabeceraDePedido(p)}
      ${camino(p)}
      ${p.fueModificado ? `<p class="seg-alerta">
        <b>Este pedido se modificó.</b> Cambiaron artículos o el precio acordado.
        Entrá al seguimiento para ver qué quedó.</p>` : ''}
      <div class="seg-acciones">
        <button class="btn borde btn-mini" data-seguir="${esc(p.numero)}">Ver seguimiento</button>
        <a class="btn borde btn-mini mas-chico"
           href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Descargar PDF</a>
      </div>
    </article>`).join('');
}

/*
 * Qué cambió, cruce por cruce.
 *
 * "Se modificó tu pedido" no sirve para nada si el cliente tiene que abrir dos
 * PDF y compararlos a ojo. Acá está la diferencia escrita: qué había, qué va.
 */
function cambios(c) {
  if (!c) return '';
  const lineas = (c.lineas || []).map((l) => {
    const clase = l.despues === 0 ? 'quitado' : (l.antes === 0 ? 'sumado' : '');
    return `<li class="${clase}">${esc(l.titulo)} · ${esc(l.color || 'Único')} ${esc(l.talle)}:
      <span class="antes">${l.antes}</span> → <span class="despues">${l.despues} u.</span></li>`;
  }).join('');

  const baja = c.totalDespues < c.totalAntes;
  return `<div class="seg-cambios">
    <h5>Qué cambió</h5>
    ${lineas ? `<ul>${lineas}</ul>` : '<p class="resto">Cambió el precio acordado, no los artículos.</p>'}
    ${c.masLineas ? `<p class="resto">y ${c.masLineas} cambio${c.masLineas === 1 ? '' : 's'} más</p>` : ''}
    <div class="seg-plata">
      <span class="${baja ? 'baja' : 'sube'}">Total: ${pesos(c.totalAntes)} → <b>${pesos(c.totalDespues)}</b></span>
      <span>${c.unidadesAntes} → <b>${c.unidadesDespues} u.</b></span>
      ${c.ajuste ? `<span>${c.ajuste.tipo === 'porcentaje'
        ? `${c.ajuste.valor > 0 ? '+' : ''}${c.ajuste.valor} % acordado`
        : `${pesos(c.ajuste.valor)} acordado`}${c.ajuste.motivo ? ` — ${esc(c.ajuste.motivo)}` : ''}</span>` : ''}
    </div>
  </div>`;
}

const detalleDeItems = (items) => items.map((it) => `
  <div class="resumen-item">
    <div class="encabezado">
      <div><h4>${esc(it.titulo)}</h4><div class="categoria">${esc(it.categoria)} · ${it.unidades} u.</div></div>
      <div class="importe">${pesos(it.subtotal)}</div>
    </div>
    <div class="lineas">${it.detalle.map((d) => `
      <div><b>${esc(d.color || 'Único')}</b> · ${d.talles.map((t) => `${esc(t.talle)}×${t.cantidad}`).join('  ')}</div>`).join('')}</div>
  </div>`).join('');

function vistaSeguimiento() {
  if (!pedidoAbierto) return '<p class="cargando">Buscando tu pedido…</p>';
  const p = pedidoAbierto;

  return `
    <article class="seg-pedido${p.estado === 'cancelado' ? ' es-cancelado' : ''}">
      ${cabeceraDePedido(p)}
      ${camino({ ...p, fueModificado: Boolean(p.original) })}
    </article>

    <div class="seg-bloque">
      <h4>Qué pasó con tu pedido</h4>
      <ol class="seg-linea">${p.historial.map((h) => `
        <li class="paso-${esc(h.estado)}">
          <span class="hito"></span>
          <div class="titulo">${esc(ETIQUETAS[h.estado] || h.estado)}</div>
          <div class="cuando">${cuando(h.fecha, true)}</div>
          ${h.nota ? `<p class="nota-paso">${esc(h.nota)}</p>` : ''}
          ${cambios(h.cambios)}
        </li>`).join('')}</ol>
    </div>

    <div class="seg-bloque">
      <h4>${p.original ? 'Lo que va a salir' : 'Lo que pediste'}</h4>
      ${detalleDeItems(p.items)}
      <div class="seg-total">
        <div>
          <div class="u">${p.unidades} unidades</div>
          ${p.ajuste ? `<div class="ajuste">${p.ajuste.tipo === 'porcentaje'
            ? `${p.ajuste.valor > 0 ? '+' : ''}${p.ajuste.valor} % acordado`
            : `${pesos(p.ajuste.valor)} acordado`}</div>` : ''}
        </div>
        <div class="n">${pesos(p.total)}</div>
      </div>
    </div>

    ${p.original ? `
      <div class="seg-original">
        <h5>Lo que habías pedido el ${cuando(p.original.fecha || p.creado_en)}</h5>
        <div class="lineas">${p.original.items.map((it) => `
          <div>${esc(it.titulo)} · ${it.unidades} u. · ${pesos(it.subtotal)}</div>`).join('')}
          <div><b>Total original: ${pesos(p.original.total)}</b> · ${p.original.unidades} u.</div>
        </div>
      </div>` : ''}`;
}

const TITULOS = {
  entrar: 'Entrar', registro: 'Crear cuenta', cuenta: 'Mi cuenta',
  password: 'Cambiar la contraseña', pedidos: 'Mis pedidos', seguimiento: 'Seguimiento del pedido',
};

const BOTONES = {
  entrar: '<button class="btn" data-hacer="entrar">Entrar</button>',
  registro: '<button class="btn texto" data-vista="entrar">Volver</button><button class="btn" data-hacer="registrar">Crear cuenta</button>',
  cuenta: '<button class="btn" data-hacer="guardar">Guardar cambios</button>',
  password: '<button class="btn texto" data-vista="cuenta">Volver</button><button class="btn" data-hacer="password">Cambiar</button>',
  pedidos: '<button class="btn azul" data-vista="cuenta">Volver</button>',
  seguimiento: '<button class="btn azul" data-vista="pedidos">Volver a mis pedidos</button>',
};

function pintar() {
  titulo.textContent = TITULOS[vista];
  const vistas = {
    entrar: vistaEntrar, registro: vistaRegistro, cuenta: vistaCuenta,
    password: vistaPassword, pedidos: vistaPedidos, seguimiento: vistaSeguimiento,
  };
  cuerpo.innerHTML = (mensaje ? `<p class="mensaje ${mensaje.tipo}">${esc(mensaje.texto)}</p>` : '')
    + vistas[vista]();
  el('#cuenta-pie').innerHTML = ocupado
    ? '<button class="btn" disabled>Un momento…</button>'
    : BOTONES[vista];
}

const leerForm = (sel) => {
  const f = el(sel);
  const datos = {};
  if (f) for (const c of f.elements) if (c.name) datos[c.name] = c.value.trim();
  return datos;
};

async function hacer(accion) {
  /*
   * El formulario se lee ANTES de repintar.
   *
   * `pintar()` reconstruye el HTML del diálogo, así que los campos vuelven a
   * nacer vacíos: leyéndolos después, se manda un pedido sin datos y el
   * servidor contesta "escribí tu email y tu contraseña" con el email escrito
   * en la pantalla. Es de esos errores que parecen del servidor.
   */
  const FORMULARIOS = {
    entrar: '#form-sesion', registrar: '#form-registro',
    guardar: '#form-cuenta', password: '#form-password',
  };
  const campos = leerForm(FORMULARIOS[accion]);

  ocupado = true; errores = {}; mensaje = null; pintar();
  try {
    if (accion === 'entrar') {
      const datos = await api('/api/sesion', { method: 'POST', body: JSON.stringify(campos) });
      Object.assign(sesion, datos);
      pintarBarra();
      if (datos.rol === 'admin') { window.location.href = '/admin.html'; return; }
      cerrarCuenta();
      document.dispatchEvent(new CustomEvent('sesion-cambio'));
      return;
    }
    if (accion === 'registrar') {
      const datos = await api('/api/cuenta', { method: 'POST', body: JSON.stringify(campos) });
      Object.assign(sesion, datos);
      pintarBarra();
      cerrarCuenta();
      document.dispatchEvent(new CustomEvent('sesion-cambio'));
      return;
    }
    if (accion === 'guardar') {
      const datos = await api('/api/cuenta', { method: 'PUT', body: JSON.stringify(campos) });
      sesion.cliente = datos.cliente;
      sesion.datosDePedido = datos.datosDePedido;
      mensaje = { tipo: 'ok', texto: 'Listo, guardamos tus datos.' };
      pintarBarra();
      document.dispatchEvent(new CustomEvent('sesion-cambio'));
    }
    if (accion === 'password') {
      await api('/api/cuenta/password', { method: 'PUT', body: JSON.stringify(campos) });
      vista = 'cuenta';
      mensaje = { tipo: 'ok', texto: 'Contraseña cambiada.' };
    }
  } catch (e) {
    errores = e.datos?.errores || {};
    mensaje = { tipo: 'error', texto: e.message };
  } finally {
    ocupado = false;
    pintar();
  }
}

/*
 * Al volver de una página congelada se vuelve a preguntar quién sos.
 *
 * El navegador guarda la página entera al salir de ella y el botón Atrás la
 * devuelve pintada, sin ejecutar nada. Acá no se recarga —eso perdería el
 * pedido a medio cargar— pero sí se cierra el panel de la cuenta, que es lo
 * que tiene datos personales, y se le pregunta al servidor si la sesión sigue
 * abierta. Si no, la barra vuelve sola a decir «Entrar».
 */
window.addEventListener('pagehide', () => { cerrarCuenta(); });
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  const antes = sesion.rol;
  cargarSesion().then(() => {
    if (sesion.rol !== antes) document.dispatchEvent(new CustomEvent('sesion-cambio'));
  });
});

// ── Eventos ───────────────────────────────────────────────────────
el('#estado-sesion').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-accion]');
  if (!b) return;
  if (b.dataset.accion === 'salir') {
    await fetch('/api/sesion', { method: 'DELETE' });
    sesion.rol = null; sesion.cliente = null; sesion.datosDePedido = null;
    pintarBarra();
    document.dispatchEvent(new CustomEvent('sesion-cambio'));
    return;
  }
  abrirCuenta(b.dataset.accion === 'cuenta' ? 'cuenta' : 'entrar');
});

dialogo.addEventListener('click', async (e) => {
  if (e.target.closest('#cuenta-cerrar')) return cerrarCuenta();

  const cambio = e.target.closest('[data-vista]');
  if (cambio) {
    vista = cambio.dataset.vista;
    errores = {}; mensaje = null;
    if (vista === 'pedidos') {
      /*
       * Al volver de un seguimiento se vuelven a pedir los pedidos.
       *
       * Es la pantalla donde alguien se queda mirando si le cambió el estado, y
       * una lista servida de memoria le muestra lo mismo aunque el pedido ya
       * haya salido del depósito.
       */
      misPedidos = null;
      pintar();
      try { misPedidos = (await api('/api/cuenta/pedidos')).pedidos; } catch { misPedidos = []; }
    }
    pintar();
    return;
  }

  const seguir = e.target.closest('[data-seguir]');
  if (seguir) {
    vista = 'seguimiento';
    pedidoAbierto = null;
    errores = {}; mensaje = null;
    pintar();
    try {
      pedidoAbierto = (await api(`/api/cuenta/pedidos/${encodeURIComponent(seguir.dataset.seguir)}`)).pedido;
    } catch (err) {
      vista = 'pedidos';
      mensaje = { tipo: 'error', texto: err.message };
    }
    pintar();
    return;
  }

  const b = e.target.closest('[data-hacer]');
  if (b) hacer(b.dataset.hacer);
});

dialogo.addEventListener('keydown', (e) => {
  // Enter en un formulario de una o dos casillas tiene que enviar: obligar a
  // bajar hasta el botón en la pantalla de entrar es fricción sin motivo.
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  const b = el('#cuenta-pie [data-hacer]');
  if (b) { e.preventDefault(); hacer(b.dataset.hacer); }
});
