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

let vista = 'entrar';   // entrar | registro | cuenta | pedidos | password
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

let misPedidos = null;

function vistaPedidos() {
  if (!misPedidos) return '<p class="cargando">Buscando tus pedidos…</p>';
  if (!misPedidos.length) {
    return `<div class="vacio"><h3>Todavía no hiciste pedidos</h3>
      <p>Cuando hagas el primero con la sesión abierta, va a aparecer acá.</p></div>`;
  }
  return `<div class="envoltorio-tabla"><table class="datos">
    <thead><tr><th>Pedido</th><th>U.</th><th>Total</th><th>Estado</th><th></th></tr></thead>
    <tbody>${misPedidos.map((p) => `
      <tr>
        <td><b class="destacado">${esc(p.numero)}</b><br>
          <span class="chico">
            ${new Date(p.creado_en).toLocaleDateString('es-AR')}</span></td>
        <td>${p.unidades}</td>
        <td><b>${pesos(p.total)}</b></td>
        <td><span class="pastilla ${p.estado === 'cancelado' ? 'no' : 'si'}">${esc(p.estado)}</span></td>
        <td><a class="btn borde btn-mini mas-chico"
               href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">PDF</a></td>
      </tr>`).join('')}</tbody></table></div>`;
}

const TITULOS = {
  entrar: 'Entrar', registro: 'Crear cuenta', cuenta: 'Mi cuenta',
  password: 'Cambiar la contraseña', pedidos: 'Mis pedidos',
};

const BOTONES = {
  entrar: '<button class="btn" data-hacer="entrar">Entrar</button>',
  registro: '<button class="btn texto" data-vista="entrar">Volver</button><button class="btn" data-hacer="registrar">Crear cuenta</button>',
  cuenta: '<button class="btn" data-hacer="guardar">Guardar cambios</button>',
  password: '<button class="btn texto" data-vista="cuenta">Volver</button><button class="btn" data-hacer="password">Cambiar</button>',
  pedidos: '<button class="btn azul" data-vista="cuenta">Volver</button>',
};

function pintar() {
  titulo.textContent = TITULOS[vista];
  const vistas = {
    entrar: vistaEntrar, registro: vistaRegistro, cuenta: vistaCuenta,
    password: vistaPassword, pedidos: vistaPedidos,
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
      misPedidos = null;
      pintar();
      try { misPedidos = (await api('/api/cuenta/pedidos')).pedidos; } catch { misPedidos = []; }
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
