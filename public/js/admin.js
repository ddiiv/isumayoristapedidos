/*
 * Panel de ISUWAYA.
 *
 * Todo lo que hay que poder cambiar sin abrir la base: el catálogo, los
 * colores, los talles, las fotos, la guía de medidas de cada producto, los
 * precios en masa, y el historial de pedidos.
 *
 * Ya no se edita nada por planilla. La planilla sirve para TRAER el catálogo
 * de STOCKER; a partir de ahí, lo que se toca se toca acá, donde se ve el
 * efecto en el momento y no hay que exportar, editar y volver a subir.
 */

import { el, esc, pesos } from './util.js';

const raiz = el('#panel-admin');

const vista = { tab: 'catalogo', sku: null, pedido: null };

/*
 * Los talles que suelen tener un precio distinto.
 *
 * Del 3XL para arriba lleva más tela, y el ÚNICO va acá porque es el talle de
 * los productos que no tienen curva y se cotizan aparte.
 */
const TALLES_GRANDES = ['3XL', '4XL', '5XL', 'ÚNICO', 'UNICO', 'Único'];
let datos = { productos: [], categorias: [], colores: [], talles: [], pedidos: [], totales: null, clientes: [] };
let detalle = null;      // producto abierto
let filtroPedidos = { desde: '', hasta: '', estado: '', buscar: '' };
let aviso = null;

const api = async (ruta, opciones = {}) => {
  const r = await fetch(`/api/admin${ruta}`, {
    headers: opciones.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opciones,
  });
  const cuerpo = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(cuerpo.message || 'Falló'), { status: r.status });
  return cuerpo;
};

const mensaje = (texto, tipo = 'ok') => { aviso = { texto, tipo }; };
const pintarAviso = () => (aviso ? `<p class="mensaje ${aviso.tipo}">${esc(aviso.texto)}</p>` : '');

function pintarSinPermiso(texto) {
  raiz.innerHTML = `
    <div class="tarjeta entrar">
      <h3>Esto es el panel de ISUWAYA</h3>
      <p class="sub">${esc(texto || 'Entrá con la cuenta de administrador para verlo.')}</p>
      <a class="btn enlinea" href="/">Ir a la página y entrar</a>
    </div>`;
}

// ══ CATÁLOGO ══════════════════════════════════════════════════════
function vistaCatalogo() {
  if (vista.sku) return vistaProducto();

  const filas = datos.productos.map((p) => `
    <tr data-sku="${esc(p.sku_agrupador)}">
      <td>
        <div class="semi">${esc(p.titulo)}</div>
        <div class="chico">${esc(p.sku_agrupador)}</div>
      </td>
      <td>${esc(p.categoria || '—')}</td>
      <td class="centrado">${p.variantes}</td>
      <td class="centrado">${p.fotos || 0}</td>
      <td><b>${pesos(p.precio)}</b></td>
      <td class="centrado">
        <span class="pastilla ${p.visible ? 'si' : 'no'}">${p.visible ? 'Visible' : 'Oculto'}</span>
      </td>
      <td><button class="btn borde btn-mini" data-abrir="${esc(p.sku_agrupador)}">Editar</button></td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Traer catálogo de STOCKER</h3>
      <p class="sub">
        Subí el <b>.xlsx</b> que exporta STOCKER. Trae productos y variantes nuevas y
        actualiza las que ya están — la misma planilla dos veces no duplica nada.
        Al terminar se ordenan solos los colores repetidos, los talles y las categorías
        con tipeos, y se sacan los productos de OFERTA.
        <br><b>Lo que edites acá —fotos, guía de talles, descripción— no se toca.</b>
        El precio sí, porque viene de la planilla.
      </p>
      <form class="subida" id="form-importar">
        <input type="file" name="planilla" accept=".xlsx" required>
        <button class="btn">Importar</button>
      </form>
      <div id="resultado-importar"></div>
    </div>

    <div class="tarjeta">
      <h3>Productos <span class="apagado">(${datos.productos.length})</span></h3>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr>
            <th>Producto</th><th>Categoría</th><th>Var.</th><th>Fotos</th>
            <th>Precio</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody>${filas || '<tr><td colspan="7" class="vacio-tabla">Todavía no importaste nada.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Un producto ───────────────────────────────────────────────────
function vistaProducto() {
  if (!detalle) return '<p class="cargando">Abriendo el producto…</p>';
  const p = detalle.producto;

  const fotos = detalle.fotos.map((f) => `
    <li class="foto-item ${p.foto === f.ruta ? 'principal' : ''}" data-foto="${f.id}">
      <img src="${esc(f.ruta)}" alt="">
      <select class="select-mini" data-color-foto="${f.id}" aria-label="Color de la foto">
        <option value="">Foto general</option>
        ${detalle.colores.map((c) => `<option value="${c.id}"${c.id === f.color_id ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('')}
      </select>
      <div class="foto-acciones">
        ${p.foto === f.ruta
          ? '<span class="pastilla si">Principal</span>'
          : `<button class="btn texto" data-principal="${f.id}">Hacer principal</button>`}
        <button class="btn texto quitar" data-borrar-foto="${f.id}">Borrar</button>
      </div>
    </li>`).join('');

  const g = p.guia_talles;
  const columnas = g?.columnas || ['Ancho', 'Largo'];
  const tallesDelProducto = [...new Set(detalle.variantes.map((v) => v.talle))];
  const filasGuia = tallesDelProducto.map((t) => {
    const existente = g?.filas?.find((f) => f.talle === t) || {};
    return `<tr>
      <th>${esc(t)}</th>
      ${columnas.map((c) => `
        <td><input class="medida" data-talle="${esc(t)}" data-medida="${esc(c)}"
                   value="${esc(existente[c] ?? '')}" placeholder="—"></td>`).join('')}
    </tr>`;
  }).join('');

  return `
    <p><button class="btn texto" data-volver>← Volver al catálogo</button></p>

    <div class="tarjeta">
      <h3>${esc(p.titulo)}</h3>
      <p class="sub">${esc(p.sku_agrupador)} · ${detalle.variantes.length} variantes</p>
      <div class="campos">
        <div class="campo ancho">
          <label for="ed-titulo">Título</label>
          <input id="ed-titulo" value="${esc(p.titulo)}">
        </div>
        <div class="campo">
          <label for="ed-precio">Precio mayorista</label>
          <input id="ed-precio" type="number" min="0" value="${p.precio}">
        </div>
        <div class="campo">
          <label for="ed-categoria">Categoría</label>
          <select id="ed-categoria">
            ${datos.categorias.map((c) => `<option value="${c.id}"${c.id === p.categoria_id ? ' selected' : ''}>${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="campo ancho">
          <label for="ed-descripcion">Descripción <span class="apagado">(la ve el cliente)</span></label>
          <textarea id="ed-descripcion" rows="2">${esc(p.descripcion || '')}</textarea>
        </div>
      </div>
      <div class="acciones">
        <button class="btn" data-guardar-producto>Guardar</button>
        <label class="enlinea">
          <input type="checkbox" id="ed-visible"${p.visible ? ' checked' : ''}> Visible en el catálogo
        </label>
      </div>
    </div>

    <div class="tarjeta">
      <h3>Fotos <span class="apagado">(${detalle.fotos.length} de ${detalle.maxFotos})</span></h3>
      <p class="sub">
        La principal es la que se ve en la fila del catálogo. Las que tengan un color
        asignado se muestran al elegir ese color — sólo aparecen los colores que
        <b>este</b> producto tiene.
        <br>Medida recomendada: <b>vertical 3:4</b>, tipo 1440×1920. Es la proporción con
        la que se recortan las fotos; una apaisada se recorta arriba y abajo.
      </p>
      ${detalle.fotos.length < detalle.maxFotos
        ? `<form class="subida" id="form-foto">
             <input type="file" name="foto" accept="image/jpeg,image/png,image/webp" required>
             <button class="btn">Subir foto</button>
           </form>`
        : `<p class="mensaje info">Llegaste al máximo de ${detalle.maxFotos}. Borrá alguna para subir otra.</p>`}
      <ul class="fotos-grilla">${fotos || '<li class="apagado">Todavía no hay fotos.</li>'}</ul>
    </div>

    <div class="tarjeta">
      <h3>Guía de talles</h3>
      <p class="sub">
        Las medidas de <b>este</b> producto. Un talle M no mide lo mismo en una remera
        que en una campera, así que el cliente necesita las de acá y no una tabla general.
        Lo que dejes vacío no se muestra.
      </p>
      <div class="campos">
        <div class="campo ancho">
          <label for="guia-columnas">Qué se mide <span class="apagado">(separado por comas)</span></label>
          <input id="guia-columnas" value="${esc(columnas.join(', '))}">
        </div>
        <div class="campo ancho">
          <label for="guia-nota">Aclaración <span class="apagado">(opcional)</span></label>
          <input id="guia-nota" value="${esc(g?.nota || '')}" placeholder="Ej: medidas tomadas sobre la prenda apoyada">
        </div>
      </div>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Talle</th>${columnas.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${filasGuia}</tbody>
        </table>
      </div>
      <div class="acciones">
        <button class="btn" data-guardar-guia>Guardar la guía</button>
        <button class="btn texto" data-recargar-columnas>Aplicar columnas</button>
        ${g ? '<button class="btn texto quitar" data-borrar-guia>Quitar la guía</button>' : ''}
      </div>
    </div>

    <div class="tarjeta">
      <h3>Precio de los talles grandes</h3>
      <p class="sub">
        Del 3XL para arriba suele salir más caro porque lleva más tela, y cuánto más
        cambia por producto. Poné el precio y se aplica a los talles que marques de
        <b>este</b> producto. Vacío los devuelve al precio del producto.
      </p>
      <div class="talles-grandes">
        ${TALLES_GRANDES.filter((t) => detalle.talles.some((x) => x.nombre === t)).map((t) => `
          <label class="chip-check"><input type="checkbox" class="talle-grande" value="${esc(t)}" checked> ${esc(t)}</label>`).join('')
          || '<span class="apagado">Este producto no tiene talles grandes ni ÚNICO.</span>'}
      </div>
      ${detalle.talles.some((x) => TALLES_GRANDES.includes(x.nombre)) ? `
        <div class="acciones">
          <input id="precio-grandes" type="number" min="0" placeholder="Precio para esos talles" class="nombre-color">
          <button class="btn" data-precio-talles>Aplicar</button>
          <button class="btn texto" data-precio-talles-limpiar>Volver al precio del producto</button>
        </div>` : ''}
    </div>

    <div class="tarjeta">
      <h3>Variantes <span class="apagado">(${detalle.variantes.length})</span></h3>
      <p class="sub">
        El precio vacío significa que sigue el del producto (${pesos(p.precio)}).
        Se guarda solo al salir del casillero.
      </p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Color</th><th>Talle</th><th>SKU</th><th>Precio propio</th></tr></thead>
          <tbody>${detalle.variantes.map((v) => `
            <tr>
              <td><span class="muestra"><i data-hex="${esc(v.hex)}"></i>${esc(v.color)}</span></td>
              <td class="semi">${esc(v.talle)}</td>
              <td class="chico">${esc(v.sku)}</td>
              <td>
                <input class="medida" type="number" min="0" data-precio-variante="${v.id}"
                       value="${v.precio ?? ''}" placeholder="${p.precio}"
                       aria-label="Precio de ${esc(v.color)} ${esc(v.talle)}">
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

// ══ COLORES ═══════════════════════════════════════════════════════
function vistaColores() {
  const filas = datos.colores.map((c) => `
    <tr data-color="${c.id}">
      <td><input type="color" class="pastilla-color" value="${esc(/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#cccccc')}" data-hex="${c.id}" aria-label="Color de ${esc(c.nombre)}"></td>
      <td><input class="nombre-color" value="${esc(c.nombre)}" data-nombre="${c.id}"></td>
      <td class="chico">${esc(c.hex)}</td>
      <td class="centrado">${c.variantes}</td>
      <td class="centrado">${c.provisorio ? '<span class="pastilla aviso">Por confirmar</span>' : '<span class="pastilla si">Listo</span>'}</td>
      <td>
        <button class="btn borde btn-mini" data-guardar-color="${c.id}">Guardar</button>
        ${c.variantes ? '' : `<button class="btn texto quitar" data-borrar-color="${c.id}">Borrar</button>`}
      </td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Colores <span class="apagado">(${datos.colores.length})</span></h3>
      <p class="sub">
        El cuadrito es el que ve el cliente. Tocalo y elegí el color: se ve al instante.
        <br>
        <b>Para unir dos colores</b> —el catálogo trae "Negra" y "Negro" como si fueran
        distintos— renombrá uno con el nombre del otro y se fusionan, arrastrando sus
        variantes y fotos. Los <span class="pastilla aviso">Por confirmar</span> son los
        que puso el sistema al importar: nadie los miró todavía.
      </p>
      <form class="subida" id="form-color">
        <input type="color" name="hex" value="#3f6b45" aria-label="Color nuevo">
        <input name="nombre" placeholder="Nombre del color" required>
        <button class="btn">Agregar</button>
      </form>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th></th><th>Nombre</th><th>Hex</th><th>Variantes</th><th>Estado</th><th></th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    </div>`;
}

// ══ TALLES ════════════════════════════════════════════════════════
function vistaTalles() {
  const porGrupo = (grupo) => datos.talles.filter((t) => t.grupo === grupo).map((t) => `
    <tr data-talle="${t.id}">
      <td class="semi">${esc(t.nombre)}</td>
      <td>
        <select class="select-mini" data-grupo="${t.id}">
          <option value="adulto"${t.grupo === 'adulto' ? ' selected' : ''}>Adulto</option>
          <option value="nino"${t.grupo === 'nino' ? ' selected' : ''}>Niño</option>
        </select>
      </td>
      <td class="centrado">${t.variantes}</td>
      <td>${t.variantes ? '' : `<button class="btn texto quitar" data-borrar-talle="${t.id}">Borrar</button>`}</td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Talles</h3>
      <p class="sub">
        Separados en adulto y niño porque no son lo mismo: un talle 8 de niño y uno de
        adulto comparten el número y nada más. La guía de medidas de cada producto es la
        que dice cuánto mide cada uno en ESE producto.
      </p>
      <form class="subida" id="form-talle">
        <input name="nombre" placeholder="Talle (M, 2XL, 12…)" required>
        <select name="grupo" class="select-mini">
          <option value="adulto">Adulto</option>
          <option value="nino">Niño</option>
        </select>
        <button class="btn">Agregar</button>
      </form>

      <h4 class="separado">Adulto</h4>
      <div class="envoltorio-tabla"><table class="datos">
        <thead><tr><th>Talle</th><th>Grupo</th><th>Variantes</th><th></th></tr></thead>
        <tbody>${porGrupo('adulto')}</tbody></table></div>

      <h4 class="separado">Niño</h4>
      <div class="envoltorio-tabla"><table class="datos">
        <thead><tr><th>Talle</th><th>Grupo</th><th>Variantes</th><th></th></tr></thead>
        <tbody>${porGrupo('nino') || '<tr><td colspan="4" class="vacio-tabla">Ninguno.</td></tr>'}</tbody></table></div>
    </div>`;
}

// ══ CAMBIOS EN MASA ═══════════════════════════════════════════════
function vistaMasivo() {
  return `
    <div class="tarjeta">
      <h3>Precios en masa</h3>
      <p class="sub">
        Para no tocar doscientas variantes de a una. Elegí sobre qué, qué hacer, y
        <b>mirá cuántas toca antes de aplicar</b>: un cambio masivo que no dice cuánto
        cambió es un cambio que hay que ir a verificar a mano.
      </p>
      <div class="campos">
        <div class="campo">
          <label for="m-categoria">Categoría</label>
          <select id="m-categoria">
            <option value="">Todas</option>
            ${datos.categorias.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label for="m-producto">Producto</label>
          <select id="m-producto">
            <option value="">Todos</option>
            ${datos.productos.map((p) => `<option value="${esc(p.sku_agrupador)}">${esc(p.titulo)}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label for="m-color">Color</label>
          <select id="m-color">
            <option value="">Todos</option>
            ${datos.colores.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label for="m-talle">Talle</label>
          <select id="m-talle">
            <option value="">Todos</option>
            ${datos.talles.map((t) => `<option value="${t.id}">${esc(t.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="campo">
          <label for="m-accion">Qué hacer</label>
          <select id="m-accion">
            <option value="porcentaje">Subir o bajar un porcentaje</option>
            <option value="fijar">Fijar un precio</option>
            <option value="heredar">Volver al precio del producto</option>
          </select>
        </div>
        <div class="campo">
          <label for="m-valor">Valor <span class="apagado">(% o $)</span></label>
          <input id="m-valor" type="number" value="15">
        </div>
      </div>
      <div class="acciones">
        <button class="btn borde" data-contar>Ver a cuántas toca</button>
        <button class="btn" data-aplicar disabled>Aplicar</button>
      </div>
      <div id="resultado-masivo"></div>
    </div>`;
}

// ══ PEDIDOS ═══════════════════════════════════════════════════════
const ESTADOS = ['nuevo', 'preparando', 'enviado', 'cancelado'];

function vistaPedidos() {
  if (vista.pedido) return vistaPedidoDetalle();
  const t = datos.totales || { pedidos: 0, facturado: 0, unidades: 0 };

  const filas = datos.pedidos.map((p) => {
    const falla = [p.aviso_mail, p.aviso_whatsapp].some((a) => a && a !== 'ok');
    return `
      <tr data-numero="${esc(p.numero)}">
        <td>
          <button class="btn texto destacado" data-ver-pedido="${esc(p.numero)}">${esc(p.numero)}</button>
          <div class="chico">${new Date(p.creado_en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
        </td>
        <td>
          <div class="semi">${esc(p.cliente.nombre)}</div>
          <div class="chico">${esc(p.cliente.ciudad)}, ${esc(p.cliente.provincia)}${p.cliente_id ? '' : ' · sin cuenta'}</div>
        </td>
        <td class="centrado">${p.unidades}</td>
        <td class="fuerte">${pesos(p.total)}</td>
        <td>
          <select class="select-mini" data-estado>
            ${ESTADOS.map((e) => `<option${e === p.estado ? ' selected' : ''}>${e}</option>`).join('')}
          </select>
        </td>
        <td class="centrado">${falla ? '<span class="pastilla aviso">Revisar</span>' : '<span class="pastilla si">Avisado</span>'}</td>
        <td class="sin-corte">
          <a class="btn borde btn-mini" href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Remito</a>
          <a class="btn borde btn-mini mas-chico" href="/api/pedidos/${encodeURIComponent(p.numero)}/rotulo.pdf">Rótulo</a>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="tarjeta">
      <h3>Historial de pedidos</h3>
      <p class="sub">Todo lo que entró, con su detalle. Los totales son de lo filtrado.</p>
      <div class="campos">
        <div class="campo"><label for="f-desde">Desde</label><input id="f-desde" type="date" value="${esc(filtroPedidos.desde)}"></div>
        <div class="campo"><label for="f-hasta">Hasta</label><input id="f-hasta" type="date" value="${esc(filtroPedidos.hasta)}"></div>
        <div class="campo">
          <label for="f-estado">Estado</label>
          <select id="f-estado">
            <option value="">Todos</option>
            ${ESTADOS.map((e) => `<option${e === filtroPedidos.estado ? ' selected' : ''}>${e}</option>`).join('')}
          </select>
        </div>
        <div class="campo"><label for="f-buscar">Buscar</label><input id="f-buscar" value="${esc(filtroPedidos.buscar)}" placeholder="Número o cliente"></div>
      </div>
      <div class="acciones">
        <button class="btn" data-filtrar>Filtrar</button>
        <button class="btn texto" data-limpiar-filtro>Limpiar</button>
      </div>

      <div class="totales-fila">
        <div><span class="chico">PEDIDOS</span><b>${t.pedidos}</b></div>
        <div><span class="chico">UNIDADES</span><b>${t.unidades}</b></div>
        <div><span class="chico">FACTURADO</span><b>${pesos(t.facturado)}</b></div>
      </div>

      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Pedido</th><th>Cliente</th><th>U.</th><th>Total</th><th>Estado</th><th>Aviso</th><th></th></tr></thead>
          <tbody>${filas || '<tr><td colspan="7" class="vacio-tabla">No hay pedidos con ese filtro.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function vistaPedidoDetalle() {
  const p = datos.pedidos.find((x) => x.numero === vista.pedido);
  if (!p) return '<p class="cargando">Buscando el pedido…</p>';
  const c = p.cliente;

  return `
    <p><button class="btn texto" data-volver-pedidos>← Volver al historial</button></p>
    <div class="tarjeta">
      <h3>${esc(p.numero)}</h3>
      <p class="sub">${new Date(p.creado_en).toLocaleString('es-AR')} · ${p.unidades} u. · <b>${pesos(p.total)}</b></p>

      <h4>Cliente</h4>
      <p class="sub">
        ${esc(c.nombre)} · CUIT ${esc(c.cuit)} · Tel. ${esc(c.telefono)}${c.email ? ` · ${esc(c.email)}` : ''}<br>
        ${esc(c.direccion)}${c.entreCalles ? ` (entre ${esc(c.entreCalles)})` : ''}<br>
        ${esc(c.ciudad)} (${esc(c.codigoPostal)}), ${esc(c.provincia)} — <b>${esc(c.formaEnvio)}</b>
      </p>

      <h4 class="separado">Qué pidió</h4>
      ${p.items.map((it) => `
        <div class="resumen-item">
          <div class="encabezado">
            <div><h4>${esc(it.titulo)}</h4><div class="categoria">${esc(it.categoria)} · ${it.unidades} u.</div></div>
            <div class="importe">${pesos(it.subtotal)}</div>
          </div>
          ${it.curvas ? `<div class="curva">${it.curvas} curva${it.curvas === 1 ? '' : 's'}</div>` : ''}
          <div class="lineas">${it.detalle.map((d) => `
            <div><b>${esc(d.color || 'Único')}</b> · ${d.talles.map((t) => `${esc(t.talle)}×${t.cantidad}`).join('  ')}</div>`).join('')}</div>
        </div>`).join('')}

      <h4 class="separado">Avisos</h4>
      <p class="sub">Mail: ${esc(p.aviso_mail || '—')}<br>WhatsApp: ${esc(p.aviso_whatsapp || '—')}</p>

      <div class="acciones">
        <a class="btn azul enlinea" href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Remito A4</a>
        <a class="btn borde enlinea" href="/api/pedidos/${encodeURIComponent(p.numero)}/rotulo.pdf">Rótulo 10×15</a>
      </div>
    </div>`;
}

// ══ CLIENTES ══════════════════════════════════════════════════════
function vistaClientes() {
  const filas = datos.clientes.map((c) => `
    <tr data-cliente="${c.id}">
      <td><div class="semi">${esc(c.nombre)}</div><div class="chico">${esc(c.email)}</div></td>
      <td class="chico">${esc(c.cuit)}<br>${esc(c.telefono)}</td>
      <td class="chico">${esc(c.ciudad || '—')}, ${esc(c.provincia || '—')}</td>
      <td class="centrado">${c.pedidos}</td>
      <td class="chico">${c.ultimo_acceso ? new Date(c.ultimo_acceso).toLocaleDateString('es-AR') : 'nunca'}</td>
      <td class="centrado">
        <button class="pastilla pastilla-boton ${c.activo ? 'si' : 'no'}" data-activo="${c.id}">
          ${c.activo ? 'Activo' : 'Desactivado'}
        </button>
      </td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Clientes <span class="apagado">(${datos.clientes.length})</span></h3>
      <p class="sub">
        Se registran solos desde la página. Desactivar a alguien le corta el acceso en
        el pedido siguiente — no hace falta esperar a que se le venza la sesión.
      </p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Cliente</th><th>Contacto</th><th>Dónde</th><th>Pedidos</th><th>Último acceso</th><th>Estado</th></tr></thead>
          <tbody>${filas || '<tr><td colspan="6" class="vacio-tabla">Todavía no se registró nadie.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ══ Armado ════════════════════════════════════════════════════════
const TABS = [
  ['catalogo', 'Catálogo'], ['colores', 'Colores'], ['talles', 'Talles'],
  ['masivo', 'Precios en masa'], ['pedidos', 'Pedidos'], ['clientes', 'Clientes'],
];

function pintar() {
  const vistas = {
    catalogo: vistaCatalogo, colores: vistaColores, talles: vistaTalles,
    masivo: vistaMasivo, pedidos: vistaPedidos, clientes: vistaClientes,
  };
  raiz.innerHTML = `
    <div class="tabs">
      ${TABS.map(([id, nombre]) => `<button data-tab="${id}" aria-current="${vista.tab === id}">${nombre}</button>`).join('')}
    </div>
    ${pintarAviso()}
    <div id="contenido">${vistas[vista.tab]()}</div>`;
  aviso = null;
  for (const i of raiz.querySelectorAll('[data-hex]')) {
    if (i.tagName === 'I') i.style.background = i.dataset.hex;
  }
  el('#salir').hidden = false;
}

async function cargar() {
  const q = new URLSearchParams(
    Object.entries(filtroPedidos).filter(([, v]) => v),
  ).toString();
  const [p, cat, col, tal, ped, cli] = await Promise.all([
    api('/productos'), api('/categorias'), api('/colores'),
    api('/talles'), api(`/pedidos${q ? `?${q}` : ''}`), api('/clientes'),
  ]);
  datos = {
    productos: p.productos, categorias: cat.categorias, colores: col.colores,
    talles: tal.talles, pedidos: ped.pedidos, totales: ped.totales, clientes: cli.clientes,
  };
}

async function arrancar() {
  try {
    await cargar();
    pintar();
  } catch (e) {
    if (e.status === 401) return pintarSinPermiso();
    if (e.status === 503) return pintarSinPermiso('El panel no está configurado en el servidor: falta ADMIN_PASSWORD.');
    raiz.innerHTML = `<p class="mensaje error">No pudimos cargar el panel.</p>`;
  }
}

const conError = async (fn) => {
  try { await fn(); } catch (e) { mensaje(e.message, 'error'); pintar(); }
};

// ══ Eventos ═══════════════════════════════════════════════════════
raiz.addEventListener('click', (e) => conError(async () => {
  const t = e.target;

  const tab = t.closest('[data-tab]');
  if (tab) { vista.tab = tab.dataset.tab; vista.sku = null; vista.pedido = null; pintar(); return; }

  if (t.closest('[data-volver]')) { vista.sku = null; detalle = null; pintar(); return; }
  if (t.closest('[data-volver-pedidos]')) { vista.pedido = null; pintar(); return; }

  const abrir = t.closest('[data-abrir]');
  if (abrir) {
    vista.sku = abrir.dataset.abrir;
    detalle = null;
    pintar();
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    pintar();
    return;
  }

  const verPedido = t.closest('[data-ver-pedido]');
  if (verPedido) { vista.pedido = verPedido.dataset.verPedido; pintar(); return; }

  // ── Producto
  if (t.closest('[data-guardar-producto]')) {
    await api(`/productos/${encodeURIComponent(vista.sku)}`, {
      method: 'PUT',
      body: JSON.stringify({
        titulo: el('#ed-titulo').value,
        precio: Number(el('#ed-precio').value),
        categoriaId: Number(el('#ed-categoria').value),
        descripcion: el('#ed-descripcion').value,
        visible: el('#ed-visible').checked,
      }),
    });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    mensaje('Producto guardado.');
    pintar();
    return;
  }

  if (t.closest('[data-recargar-columnas]')) {
    const columnas = el('#guia-columnas').value.split(',').map((s) => s.trim()).filter(Boolean);
    detalle.producto.guia_talles = { ...(detalle.producto.guia_talles || {}), columnas, filas: leerGuia(columnas) };
    pintar();
    return;
  }

  if (t.closest('[data-guardar-guia]')) {
    const columnas = el('#guia-columnas').value.split(',').map((s) => s.trim()).filter(Boolean);
    const r = await api(`/productos/${encodeURIComponent(vista.sku)}/guia`, {
      method: 'PUT',
      body: JSON.stringify({ guia: { columnas, filas: leerGuia(columnas), nota: el('#guia-nota').value } }),
    });
    detalle.producto.guia_talles = r.guia;
    mensaje('Guía de talles guardada.');
    pintar();
    return;
  }

  if (t.closest('[data-borrar-guia]')) {
    await api(`/productos/${encodeURIComponent(vista.sku)}/guia`, { method: 'PUT', body: JSON.stringify({ guia: null }) });
    detalle.producto.guia_talles = null;
    mensaje('Guía quitada.');
    pintar();
    return;
  }

  // ── Precio de los talles grandes
  if (t.closest('[data-precio-talles]') || t.closest('[data-precio-talles-limpiar]')) {
    const limpiar = Boolean(t.closest('[data-precio-talles-limpiar]'));
    const talles = [...raiz.querySelectorAll('.talle-grande:checked')].map((i) => i.value);
    if (!talles.length) { mensaje('Marcá al menos un talle.', 'error'); pintar(); return; }
    const r = await api(`/productos/${encodeURIComponent(vista.sku)}/precio-talles`, {
      method: 'PUT',
      body: JSON.stringify({ talles, precio: limpiar ? null : el('#precio-grandes').value }),
    });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    mensaje(`Listo: ${r.cambiadas} variantes ${limpiar ? 'vuelven al precio del producto' : 'con precio propio'}.`);
    pintar();
    return;
  }

  // ── Fotos
  const principal = t.closest('[data-principal]');
  if (principal) {
    await api(`/fotos/${principal.dataset.principal}`, { method: 'PUT', body: JSON.stringify({ principal: true }) });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    pintar();
    return;
  }
  const borrarFoto = t.closest('[data-borrar-foto]');
  if (borrarFoto) {
    await api(`/fotos/${borrarFoto.dataset.borrarFoto}`, { method: 'DELETE' });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    pintar();
    return;
  }

  // ── Colores
  const guardarColor = t.closest('[data-guardar-color]');
  if (guardarColor) {
    const id = guardarColor.dataset.guardarColor;
    const r = await api(`/colores/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        nombre: el(`[data-nombre="${id}"]`).value,
        hex: el(`[data-hex="${id}"]`).value,
      }),
    });
    await cargar();
    mensaje(r.accion === 'unido' ? `Se unió con ${r.con}.` : 'Color guardado.');
    pintar();
    return;
  }
  const borrarColor = t.closest('[data-borrar-color]');
  if (borrarColor) {
    await api(`/colores/${borrarColor.dataset.borrarColor}`, { method: 'DELETE' });
    await cargar();
    mensaje('Color borrado.');
    pintar();
    return;
  }

  // ── Talles
  const borrarTalle = t.closest('[data-borrar-talle]');
  if (borrarTalle) {
    await api(`/talles/${borrarTalle.dataset.borrarTalle}`, { method: 'DELETE' });
    await cargar();
    mensaje('Talle borrado.');
    pintar();
    return;
  }

  // ── Masivo
  if (t.closest('[data-contar]')) {
    const r = await api('/variantes/contar', { method: 'POST', body: JSON.stringify(filtroMasivo()) });
    el('#resultado-masivo').innerHTML = r.sinFiltro
      ? '<p class="mensaje error">Elegí al menos un filtro: si no, tocaría todo el catálogo.</p>'
      : `<p class="mensaje info">Toca <b>${r.variantes}</b> variantes.</p>`;
    el('[data-aplicar]').disabled = r.sinFiltro || !r.variantes;
    return;
  }
  if (t.closest('[data-aplicar]')) {
    const r = await api('/variantes', {
      method: 'PUT',
      body: JSON.stringify({ ...filtroMasivo(), accion: el('#m-accion').value, valor: Number(el('#m-valor').value) }),
    });
    await cargar();
    mensaje(`Listo: ${r.cambiadas} variantes cambiadas.`);
    pintar();
    return;
  }

  // ── Pedidos
  if (t.closest('[data-filtrar]')) {
    filtroPedidos = {
      desde: el('#f-desde').value, hasta: el('#f-hasta').value,
      estado: el('#f-estado').value, buscar: el('#f-buscar').value.trim(),
    };
    await cargar();
    pintar();
    return;
  }
  if (t.closest('[data-limpiar-filtro]')) {
    filtroPedidos = { desde: '', hasta: '', estado: '', buscar: '' };
    await cargar();
    pintar();
    return;
  }

  // ── Clientes
  const activo = t.closest('[data-activo]');
  if (activo) {
    const cliente = datos.clientes.find((c) => c.id === Number(activo.dataset.activo));
    await api(`/clientes/${cliente.id}`, { method: 'PUT', body: JSON.stringify({ activo: cliente.activo ? 0 : 1 }) });
    await cargar();
    pintar();
  }
}));

const leerGuia = (columnas) => [...raiz.querySelectorAll('.medida')].reduce((filas, input) => {
  const t = input.dataset.talle;
  let fila = filas.find((f) => f.talle === t);
  if (!fila) { fila = { talle: t }; filas.push(fila); }
  if (columnas.includes(input.dataset.medida)) fila[input.dataset.medida] = input.value;
  return filas;
}, []);

const filtroMasivo = () => ({
  categoriaId: el('#m-categoria').value || null,
  skuAgrupador: el('#m-producto').value || null,
  colorId: el('#m-color').value || null,
  talleId: el('#m-talle').value || null,
});

raiz.addEventListener('change', (e) => conError(async () => {
  const t = e.target;

  if (t.dataset?.estado !== undefined) {
    await api(`/pedidos/${encodeURIComponent(t.closest('tr').dataset.numero)}`, {
      method: 'PUT', body: JSON.stringify({ estado: t.value }),
    });
    return;
  }
  if (t.dataset?.grupo) {
    await api(`/talles/${t.dataset.grupo}`, { method: 'PUT', body: JSON.stringify({ grupo: t.value }) });
    await cargar();
    return;
  }
  if (t.dataset?.precioVariante) {
    await api(`/variantes/${t.dataset.precioVariante}`, {
      method: 'PUT', body: JSON.stringify({ precio: t.value }),
    });
    // Sin repintar: repintar la tabla entera saca el foco del casillero
    // siguiente, que es donde la persona ya está escribiendo.
    t.style.borderColor = 'var(--verde)';
    setTimeout(() => { t.style.borderColor = ''; }, 900);
    return;
  }
  if (t.dataset?.colorFoto) {
    await api(`/fotos/${t.dataset.colorFoto}`, { method: 'PUT', body: JSON.stringify({ colorId: t.value || null }) });
    return;
  }
  if (t.name === 'foto' && t.files?.[0]) {
    const fd = new FormData();
    fd.append('foto', t.files[0]);
    await api(`/productos/${encodeURIComponent(vista.sku)}/fotos`, { method: 'POST', body: fd });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    pintar();
  }
}));

raiz.addEventListener('submit', (e) => conError(async () => {
  e.preventDefault();
  const f = e.target;

  if (f.id === 'form-importar') {
    const salida = el('#resultado-importar');
    salida.innerHTML = '<p class="mensaje info">Importando…</p>';
    const r = await api('/importar', { method: 'POST', body: new FormData(f) });
    const s = r.resumen;
    await cargar();
    mensaje(`Listo: ${s.productos} productos y ${s.variantes} variantes.`
      + (s.categoriasUnidas ? ` Se unieron ${s.categoriasUnidas} categorías repetidas.` : '')
      + (s.ofertaQuitada ? ` Se sacaron ${s.ofertaQuitada} productos de OFERTA.` : ''));
    pintar();
    return;
  }

  if (f.id === 'form-color') {
    await api('/colores', {
      method: 'POST',
      body: JSON.stringify({ nombre: f.elements.nombre.value, hex: f.elements.hex.value }),
    });
    await cargar();
    mensaje('Color agregado.');
    pintar();
    return;
  }

  if (f.id === 'form-talle') {
    await api('/talles', {
      method: 'POST',
      body: JSON.stringify({ nombre: f.elements.nombre.value, grupo: f.elements.grupo.value }),
    });
    await cargar();
    mensaje('Talle agregado.');
    pintar();
    return;
  }

  if (f.id === 'form-foto') {
    const fd = new FormData(f);
    await api(`/productos/${encodeURIComponent(vista.sku)}/fotos`, { method: 'POST', body: fd });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    mensaje('Foto subida.');
    pintar();
  }
}));

el('#salir').addEventListener('click', async () => {
  await fetch('/api/sesion', { method: 'DELETE' });
  window.location.href = '/';
});

arrancar();
