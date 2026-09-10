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

// ── Entrar ────────────────────────────────────────────────────────
function pintarEntrada(mensaje = '') {
  raiz.innerHTML = `
    <div class="tarjeta entrar">
      <h3>Panel de ISUWAYA</h3>
      <p class="sub">Entrá con la contraseña del panel.</p>
      ${mensaje ? aviso(mensaje, 'error') : ''}
      <form id="form-entrar">
        <div class="campo">
          <label for="clave">Contraseña</label>
          <input id="clave" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn" style="margin-top:12px;width:100%">Entrar</button>
      </form>
    </div>`;
  el('#form-entrar').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password: el('#clave').value }) });
      arrancar();
    } catch (err) {
      pintarEntrada(err.message);
    }
  });
}

// ── Catálogo ──────────────────────────────────────────────────────
function vistaCatalogo() {
  const filas = datos.productos.map((p) => `
    <tr data-sku="${esc(p.sku_agrupador)}">
      <td>
        <div style="font-weight:600">${esc(p.titulo)}</div>
        <div style="font-size:11px;color:var(--tinta-suave)">${esc(p.sku_agrupador)}</div>
      </td>
      <td>${esc(p.categoria || '—')}</td>
      <td style="text-align:center">${p.variantes}</td>
      <td><input type="number" min="0" step="1" value="${p.precio}" data-campo="precio"></td>
      <td style="text-align:center">
        <button class="pastilla ${p.visible ? 'si' : 'no'}" data-campo="visible" style="border:0">
          ${p.visible ? 'En el catálogo' : 'Oculto'}
        </button>
      </td>
      <td>
        <label class="btn borde" style="padding:5px 10px;font-size:12px;cursor:pointer">
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
      <h3>Productos <span style="font-weight:400;color:var(--tinta-suave)">(${datos.productos.length})</span></h3>
      <p class="sub">El precio y la visibilidad se guardan solos al cambiarlos.</p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr>
            <th>Producto</th><th>Categoría</th><th>Variantes</th>
            <th>Precio mayorista</th><th>Estado</th><th>Foto principal</th>
          </tr></thead>
          <tbody>${filas || '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--tinta-suave)">Todavía no importaste nada.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Pedidos ───────────────────────────────────────────────────────
const ESTADOS = ['nuevo', 'preparando', 'enviado', 'cancelado'];

function vistaPedidos() {
  if (!datos.pedidos.length) {
    return '<div class="tarjeta"><p class="sub" style="margin:0">Todavía no entró ningún pedido.</p></div>';
  }
  const filas = datos.pedidos.map((p) => {
    const avisoFallado = [p.aviso_mail, p.aviso_whatsapp].some((a) => a && a !== 'ok');
    return `
    <tr data-numero="${esc(p.numero)}">
      <td>
        <div style="font-weight:700;color:var(--azul)">${esc(p.numero)}</div>
        <div style="font-size:11px;color:var(--tinta-suave)">
          ${new Date(p.creado_en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </div>
      </td>
      <td>
        <div style="font-weight:600">${esc(p.cliente.nombre)}</div>
        <div style="font-size:11px;color:var(--tinta-suave)">${esc(p.cliente.ciudad)}, ${esc(p.cliente.provincia)}</div>
      </td>
      <td style="text-align:center">${p.unidades}</td>
      <td style="font-weight:700">${pesos(p.total)}</td>
      <td>
        <select data-estado style="font:inherit;font-size:12.5px;padding:4px 6px;border:1px solid var(--linea);border-radius:6px">
          ${ESTADOS.map((e) => `<option${e === p.estado ? ' selected' : ''}>${e}</option>`).join('')}
        </select>
      </td>
      <td>
        ${avisoFallado
          ? `<span class="pastilla aviso" title="${esc(`mail: ${p.aviso_mail} · whatsapp: ${p.aviso_whatsapp}`)}">Revisar aviso</span>`
          : '<span class="pastilla si">Avisado</span>'}
      </td>
      <td style="white-space:nowrap">
        <a class="btn borde" style="padding:5px 9px;font-size:12px;text-decoration:none"
           href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Remito</a>
        <a class="btn borde" style="padding:5px 9px;font-size:12px;text-decoration:none"
           href="/api/pedidos/${encodeURIComponent(p.numero)}/rotulo.pdf">Rótulo</a>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="tarjeta">
      <h3>Pedidos <span style="font-weight:400;color:var(--tinta-suave)">(${datos.pedidos.length})</span></h3>
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
    if (e.status === 401) return pintarEntrada();
    if (e.status === 503) return pintarEntrada('El panel no está configurado en el servidor (falta ADMIN_PASSWORD).');
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
  await api('/logout', { method: 'POST' });
  el('#salir').hidden = true;
  pintarEntrada();
});

arrancar();
