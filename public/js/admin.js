/*
 * Panel de administración.
 *
 * Tres cosas: subir la planilla de STOCKER, ajustar precios y visibilidad, y
 * mirar los pedidos que entraron. Nada más: todo lo que el panel deja tocar es
 * algo que hay que poder arreglar sin abrir la base.
 */

import { el, esc, pesos } from './util.js';

const raiz = el('#panel-admin');
let pestania = 'catalogo';
let datos = { productos: [], pedidos: [], categorias: [] };

const api = async (ruta, opciones = {}) => {
  const r = await fetch(`/api/admin${ruta}`, {
    headers: opciones.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opciones,
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(cuerpo.message || 'Falló'), { status: r.status });
  return cuerpo;
};

const aviso = (texto, tipo = 'ok') =>
  `<p class="mensaje ${tipo}">${esc(texto)}</p>`;

/*
 * El panel ya no tiene su propia entrada.
 *
 * Se entra por la misma puerta que los clientes, en la página principal, y el
 * servidor decide el rol. Con dos formularios de login había dos formas de
 * estar autenticado y dos lugares donde arreglar lo mismo — y quien se
 * confundía de puerta recibía "contraseña incorrecta" cuando lo que erró fue
 * la pantalla.
 */
function pintarSinPermiso(mensaje) {
  raiz.innerHTML = `
    <div class="tarjeta entrar">
      <h3>Esto es el panel de ISUWAYA</h3>
      <p class="sub">${esc(mensaje || 'Entrá con la cuenta de administrador para verlo.')}</p>
      <a class="btn enlinea" href="/" >Ir a la página y entrar</a>
    </div>`;
}

// ── Catálogo ──────────────────────────────────────────────────────
function vistaCatalogo() {
  const filas = datos.productos.map((p) => `
    <tr data-sku="${esc(p.sku_agrupador)}">
      <td>
        <div class="semi">${esc(p.titulo)}</div>
        <div class="chico">${esc(p.sku_agrupador)}</div>
      </td>
      <td>${esc(p.categoria || '—')}</td>
      <td class="centrado">${p.variantes}</td>
      <td><input type="number" min="0" step="1" value="${p.precio}" data-campo="precio"></td>
      <td class="centrado">
        <button class="pastilla ${p.visible ? 'si' : 'no'} pastilla-boton" data-campo="visible" >
          ${p.visible ? 'En el catálogo' : 'Oculto'}
        </button>
      </td>
      <td>
        <label class="btn borde btn-archivo">
          Foto<input type="file" accept="image/jpeg,image/png,image/webp" data-foto hidden>
        </label>
      </td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Importar desde STOCKER</h3>
      <p class="sub">
        Subí el <b>.xlsx</b> que exporta STOCKER desde Stock → Productos → Exportar.
        Se actualiza lo que ya está y se agrega lo nuevo, tomando el SKU Agrupador
        como identidad: subir la misma planilla dos veces no duplica nada.
        <br>Las fotos y los precios que hayas editado acá no se tocan… salvo el
        precio, que viene de la planilla y se pisa con el de STOCKER.
      </p>
      <form class="subida" id="form-importar">
        <input type="file" name="planilla" accept=".xlsx" required>
        <button class="btn">Importar</button>
      </form>
      <div id="resultado-importar"></div>
    </div>

    <div class="tarjeta">
      <h3>Productos <span class="apagado">(${datos.productos.length})</span></h3>
      <p class="sub">El precio y la visibilidad se guardan solos al cambiarlos.</p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr>
            <th>Producto</th><th>Categoría</th><th>Variantes</th>
            <th>Precio mayorista</th><th>Estado</th><th>Foto principal</th>
          </tr></thead>
          <tbody>${filas || '<tr><td colspan="6" class="vacio-tabla">Todavía no importaste nada.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Pedidos ───────────────────────────────────────────────────────
const ESTADOS = ['nuevo', 'preparando', 'enviado', 'cancelado'];

function vistaPedidos() {
  if (!datos.pedidos.length) {
    return '<div class="tarjeta"><p class="sub sin-margen">Todavía no entró ningún pedido.</p></div>';
  }
  const filas = datos.pedidos.map((p) => {
    const avisoFallado = [p.aviso_mail, p.aviso_whatsapp].some((a) => a && a !== 'ok');
    return `
    <tr data-numero="${esc(p.numero)}">
      <td>
        <div class="destacado">${esc(p.numero)}</div>
        <div class="chico">
          ${new Date(p.creado_en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </div>
      </td>
      <td>
        <div class="semi">${esc(p.cliente.nombre)}</div>
        <div class="chico">${esc(p.cliente.ciudad)}, ${esc(p.cliente.provincia)}</div>
      </td>
      <td class="centrado">${p.unidades}</td>
      <td class="fuerte">${pesos(p.total)}</td>
      <td>
        <select data-estado class="select-mini">
          ${ESTADOS.map((e) => `<option${e === p.estado ? ' selected' : ''}>${e}</option>`).join('')}
        </select>
      </td>
      <td>
        ${avisoFallado
          ? `<span class="pastilla aviso" title="${esc(`mail: ${p.aviso_mail} · whatsapp: ${p.aviso_whatsapp}`)}">Revisar aviso</span>`
          : '<span class="pastilla si">Avisado</span>'}
      </td>
      <td class="sin-corte">
        <a class="btn borde btn-mini"
           href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Remito</a>
        <a class="btn borde btn-mini"
           href="/api/pedidos/${encodeURIComponent(p.numero)}/rotulo.pdf">Rótulo</a>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="tarjeta">
      <h3>Pedidos <span class="apagado">(${datos.pedidos.length})</span></h3>
      <p class="sub">
        Los últimos doscientos. «Revisar aviso» significa que el mail o el WhatsApp
        no salieron — el pedido está igual, y los PDF se bajan de acá.
      </p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr>
            <th>Pedido</th><th>Cliente</th><th>U.</th><th>Total</th>
            <th>Estado</th><th>Aviso</th><th>Documentos</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Armado ────────────────────────────────────────────────────────
function pintar() {
  raiz.innerHTML = `
    <div class="tabs">
      <button data-tab="catalogo" aria-current="${pestania === 'catalogo'}">Catálogo</button>
      <button data-tab="pedidos" aria-current="${pestania === 'pedidos'}">Pedidos</button>
    </div>
    <div id="contenido">${pestania === 'catalogo' ? vistaCatalogo() : vistaPedidos()}</div>`;
  el('#salir').hidden = false;
}

async function cargar() {
  const [p, ped] = await Promise.all([api('/productos'), api('/pedidos')]);
  datos.productos = p.productos;
  datos.pedidos = ped.pedidos;
}

async function arrancar() {
  try {
    await cargar();
    pintar();
  } catch (e) {
    if (e.status === 401) return pintarSinPermiso();
    if (e.status === 503) {
      return pintarSinPermiso('El panel no está configurado en el servidor: falta ADMIN_PASSWORD.');
    }
    raiz.innerHTML = aviso('No pudimos cargar el panel.', 'error');
  }
}

// ── Eventos ───────────────────────────────────────────────────────
raiz.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { pestania = tab.dataset.tab; pintar(); return; }

  const visible = e.target.closest('[data-campo="visible"]');
  if (visible) {
    const sku = visible.closest('tr').dataset.sku;
    const producto = datos.productos.find((p) => p.sku_agrupador === sku);
    const nuevo = producto.visible ? 0 : 1;
    await api(`/productos/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify({ visible: nuevo }) });
    producto.visible = nuevo;
    pintar();
  }
});

raiz.addEventListener('change', async (e) => {
  // Precio
  if (e.target.dataset?.campo === 'precio') {
    const sku = e.target.closest('tr').dataset.sku;
    const precio = Number(e.target.value);
    try {
      await api(`/productos/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify({ precio }) });
      e.target.style.borderColor = 'var(--verde)';
      setTimeout(() => { e.target.style.borderColor = ''; }, 900);
    } catch (err) {
      e.target.style.borderColor = 'var(--rojo)';
      alert(err.message);
    }
    return;
  }

  // Estado del pedido
  if (e.target.dataset?.estado !== undefined) {
    const numero = e.target.closest('tr').dataset.numero;
    await api(`/pedidos/${encodeURIComponent(numero)}`, {
      method: 'PUT', body: JSON.stringify({ estado: e.target.value }),
    });
    return;
  }

  // Foto principal
  if (e.target.dataset?.foto !== undefined && e.target.files?.[0]) {
    const sku = e.target.closest('tr').dataset.sku;
    const fd = new FormData();
    fd.append('foto', e.target.files[0]);
    fd.append('sku', sku);
    try {
      await api('/fotos', { method: 'POST', body: fd });
      await cargar();
      pintar();
    } catch (err) { alert(err.message); }
  }
});

raiz.addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-importar') return;
  e.preventDefault();
  const salida = el('#resultado-importar');
  salida.innerHTML = '<p class="mensaje info">Importando…</p>';
  try {
    const r = await api('/importar', { method: 'POST', body: new FormData(e.target) });
    const s = r.resumen;
    salida.innerHTML = aviso(
      `Listo: ${s.productos} productos y ${s.variantes} variantes en ${s.categorias} categorías.`
      + (s.ignoradas ? ` Se saltearon ${s.ignoradas} filas sin título o sin SKU.` : '')
      + (s.atributosPorPosicion ? ` Ojo: en ${s.atributosPorPosicion} filas los atributos no decían "color"/"talle" y se tomó la 1 como color.` : ''));
    await cargar();
    pintar();
    el('#resultado-importar').innerHTML = salida.innerHTML;
  } catch (err) {
    salida.innerHTML = aviso(err.message, 'error');
  }
});

el('#salir').addEventListener('click', async () => {
  await fetch('/api/sesion', { method: 'DELETE' });
  window.location.href = '/';
});

arrancar();
