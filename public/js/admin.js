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

const vista = { tab: 'catalogo', sku: null, pedido: null, editor: null };

/*
 * Los talles que suelen tener un precio distinto.
 *
 * Del 3XL para arriba lleva más tela, y el ÚNICO va acá porque es el talle de
 * los productos que no tienen curva y se cotizan aparte.
 */
const TALLES_GRANDES = ['3XL', '4XL', '5XL', 'ÚNICO', 'UNICO', 'Único'];
let datos = { productos: [], categorias: [], colores: [], talles: [], pedidos: [], totales: null, clientes: [], estadisticas: null };
let detalle = null;      // producto abierto
let filtroPedidos = { desde: '', hasta: '', estado: '', buscar: '' };
let filtroEstadisticas = { desde: '', hasta: '' };
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
      <img src="${esc(f.miniatura || f.ruta)}" alt="" loading="lazy">
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

    ${vistaColoresDelProducto()}

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

/*
 * Los colores de este producto, para corregirlos enteros.
 *
 * Cambiar un color toca todos sus talles de una vez y se lleva sus fotos;
 * quitarlo pasa las fotos a generales; agregarlo lo crea en los talles que se
 * marquen, con el precio que cada talle ya tiene. Todo queda firme aunque se
 * vuelva a importar la planilla de STOCKER.
 */
function vistaColoresDelProducto() {
  const porColor = new Map();
  for (const v of detalle.variantes) {
    if (!v.color_id) continue;
    if (!porColor.has(v.color_id)) porColor.set(v.color_id, { id: v.color_id, nombre: v.color, hex: v.hex, talles: 0 });
    porColor.get(v.color_id).talles += 1;
  }
  const fotosDelColor = (id) => detalle.fotos.filter((f) => f.color_id === id).length;
  const otros = datos.colores.filter((c) => !porColor.has(c.id));
  const talles = [...new Set(detalle.variantes.map((v) => v.talle))];

  const filas = [...porColor.values()].map((c) => `
    <tr>
      <td><span class="muestra"><i data-hex="${esc(c.hex)}"></i>${esc(c.nombre)}</span></td>
      <td class="chico">${c.talles} ${c.talles === 1 ? 'talle' : 'talles'} · ${fotosDelColor(c.id)} fotos</td>
      <td class="acciones-color">
        <select class="select-mini" data-cambiar-a="${c.id}" aria-label="Cambiar ${esc(c.nombre)} por otro color">
          <option value="">Cambiar a…</option>
          ${datos.colores.filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}">${esc(x.nombre)}</option>`).join('')}
        </select>
        <button class="btn borde btn-mini" data-cambiar-color="${c.id}" data-nombre="${esc(c.nombre)}">Cambiar</button>
        ${porColor.size > 1
          ? `<button class="btn texto quitar" data-quitar-color="${c.id}" data-nombre="${esc(c.nombre)}">Quitar</button>`
          : ''}
      </td>
    </tr>`).join('');

  return `
    <div class="tarjeta">
      <h3>Colores de este producto <span class="apagado">(${porColor.size})</span></h3>
      <p class="sub">
        Cada cambio toca el color entero —todos sus talles— y queda firme aunque se
        vuelva a importar la planilla. Las fotos de un color van con él.
      </p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Color</th><th>Qué tiene</th><th></th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      ${otros.length ? `
        <h4>Agregar un color</h4>
        <div class="agregar-color">
          <select id="agregar-color" class="nombre-color" aria-label="Color para agregar">
            <option value="">Elegí un color…</option>
            ${otros.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
          </select>
          <div class="talles-a-agregar" role="group" aria-label="Talles del color nuevo">
            ${talles.map((t) => `<label><input type="checkbox" class="talle-nuevo-color" value="${esc(t)}" checked> ${esc(t)}</label>`).join('')}
          </div>
          <button class="btn" data-agregar-color>Agregar en esos talles</button>
        </div>` : ''}
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
/*
 * Los estados y los pasos posibles están también acá.
 *
 * El servidor es el que decide —y rechaza el paso que no corresponde aunque
 * este archivo diga otra cosa—; esta copia sólo existe para no ofrecer un
 * botón que va a fallar. Cuando cambie el camino en `src/db.js`, cambia acá.
 */
const ESTADOS = {
  pendiente: 'Esperando stock',
  confirmado: 'Confirmado', modificado: 'Modificado',
  enviado: 'Enviado', entregado: 'Entregado', cancelado: 'Cancelado',
};
const SIGUIENTES = {
  pendiente: ['confirmado', 'cancelado'],
  confirmado: ['enviado', 'cancelado'],
  modificado: ['enviado', 'cancelado'],
  enviado: ['entregado', 'cancelado'],
  entregado: [], cancelado: [],
};
const EDITABLES = ['pendiente', 'confirmado', 'modificado'];

const momento = (iso, conHora = true) => (iso
  ? new Date(iso).toLocaleString('es-AR', conHora
    ? { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' })
  : 'sin fecha');

function vistaPedidos() {
  if (vista.editor) return vistaEditorPedido();
  if (vista.pedido) return vistaPedidoDetalle();
  const t = datos.totales || { pedidos: 0, facturado: 0, unidades: 0 };

  const filas = datos.pedidos.map((p) => {
    const falla = [p.aviso_mail, p.aviso_whatsapp].some((a) => a && a !== 'ok');
    const siguientes = SIGUIENTES[p.estado] || [];
    return `
      <tr data-numero="${esc(p.numero)}">
        <td>
          <button class="btn texto destacado" data-ver-pedido="${esc(p.numero)}">${esc(p.numero)}</button>
          <div class="chico">${momento(p.creado_en)}</div>
        </td>
        <td>
          <div class="semi">${esc(p.cliente.nombre)}</div>
          <div class="chico">${esc(p.cliente.ciudad)}, ${esc(p.cliente.provincia)}${p.cliente_id ? '' : ' · sin cuenta'}</div>
        </td>
        <td class="centrado">${p.unidades}</td>
        <td class="fuerte">${pesos(p.total)}${p.original ? '<div class="chico">modificado</div>' : ''}</td>
        <td class="sin-corte">
          <span class="estado-pastilla es-${esc(p.estado)}">${esc(ESTADOS[p.estado] || p.estado)}</span>
          ${siguientes.length ? `
            <select class="select-mini" data-mover aria-label="Mover el pedido">
              <option value="">Mover a…</option>
              ${siguientes.map((e) => `<option value="${e}">${esc(ESTADOS[e])}</option>`).join('')}
            </select>` : ''}
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
            ${Object.entries(ESTADOS).map(([id, nombre]) =>
              `<option value="${id}"${id === filtroPedidos.estado ? ' selected' : ''}>${nombre}</option>`).join('')}
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

/*
 * Lo que cambió en una modificación, para el panel.
 *
 * Es lo mismo que ve el cliente en su seguimiento y a propósito: cuando llame
 * preguntando, quien atiende tiene que estar mirando el mismo texto que él.
 */
function cambiosDePedido(c) {
  if (!c) return '';
  const lineas = (c.lineas || []).map((l) => `
    <li class="${l.despues === 0 ? 'quitado' : (l.antes === 0 ? 'sumado' : '')}">
      ${esc(l.titulo)} · ${esc(l.color || 'Único')} ${esc(l.talle)}:
      <span class="antes">${l.antes}</span> → <span class="despues">${l.despues} u.</span>
    </li>`).join('');

  return `<div class="cambios-caja">
    ${lineas ? `<ul>${lineas}</ul>` : '<p class="chico">Cambió el precio acordado, no los artículos.</p>'}
    ${c.masLineas ? `<p class="chico">y ${c.masLineas} cambio${c.masLineas === 1 ? '' : 's'} más</p>` : ''}
    <p class="chico">
      Total ${pesos(c.totalAntes)} → <b>${pesos(c.totalDespues)}</b> ·
      ${c.unidadesAntes} → <b>${c.unidadesDespues} u.</b>
      ${c.ajuste ? ` · ${c.ajuste.tipo === 'porcentaje' ? `${c.ajuste.valor} %` : pesos(c.ajuste.valor)} acordado${c.ajuste.motivo ? ` (${esc(c.ajuste.motivo)})` : ''}` : ''}
    </p>
  </div>`;
}

const lineaDeTiempo = (historial) => `
  <ol class="linea-tiempo">${(historial || []).map((h) => `
    <li class="paso-${esc(h.estado)}">
      <span class="hito"></span>
      <div class="titulo-paso">${esc(ESTADOS[h.estado] || h.estado)}</div>
      <div class="chico">${momento(h.fecha)}</div>
      ${h.nota ? `<p class="nota-paso">${esc(h.nota)}</p>` : ''}
      ${cambiosDePedido(h.cambios)}
    </li>`).join('')}</ol>`;

function vistaPedidoDetalle() {
  const p = datos.pedidos.find((x) => x.numero === vista.pedido);
  /*
   * Se lo llevó el filtro: pasó a un estado que el filtro de arriba no incluye.
   * Decirlo es mejor que dejar un "cargando…" que no termina nunca sobre algo
   * que sí se guardó.
   */
  if (!p) {
    return `<div class="tarjeta">
      <h3>${esc(vista.pedido)}</h3>
      <p class="sub">Este pedido ya no entra en el filtro de arriba. Limpiá el filtro para verlo.</p>
      <button class="btn borde" data-volver-pedidos>← Volver al historial</button>
    </div>`;
  }
  const c = p.cliente;
  const siguientes = SIGUIENTES[p.estado] || [];

  return `
    <p><button class="btn texto" data-volver-pedidos>← Volver al historial</button></p>
    <div class="tarjeta">
      <h3>${esc(p.numero)} <span class="estado-pastilla es-${esc(p.estado)}">${esc(ESTADOS[p.estado] || p.estado)}</span></h3>
      <p class="sub">
        ${momento(p.creado_en)} · ${p.unidades} u. · <b>${pesos(p.total)}</b>
        ${p.ajuste ? ` · ajuste ${p.ajuste.tipo === 'porcentaje' ? `${p.ajuste.valor} %` : pesos(p.ajuste.valor)}` : ''}
      </p>

      <h4>Cliente</h4>
      <p class="sub">
        ${esc(c.nombre)} · CUIT ${esc(c.cuit)} · Tel. ${esc(c.telefono)}${c.email ? ` · ${esc(c.email)}` : ''}<br>
        ${esc(c.direccion)}${c.entreCalles ? ` (entre ${esc(c.entreCalles)})` : ''}<br>
        ${esc(c.ciudad)} (${esc(c.codigoPostal)}), ${esc(c.provincia)} — <b>${esc(c.formaEnvio)}</b>
      </p>

      <h4 class="separado">${p.original ? 'Qué se le va a mandar' : 'Qué pidió'}</h4>
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

      ${p.original ? `
        <div class="original-caja">
          <h4>Lo que había pedido</h4>
          <p class="chico">
            ${p.original.items.map((it) => `${esc(it.titulo)}: ${it.unidades} u.`).join(' · ')}<br>
            <b>${pesos(p.original.total)}</b> · ${p.original.unidades} u.
          </p>
        </div>` : ''}

      <h4 class="separado">Seguimiento</h4>
      ${lineaDeTiempo(p.historial)}

      <h4 class="separado">Mover el pedido</h4>
      ${siguientes.length ? `
        <p class="sub">
          La nota la ve el cliente en su seguimiento. Escribila como se la dirías por teléfono.
        </p>
        <div class="campo ancho">
          <label for="nota-estado">Nota <span class="apagado">(opcional)</span></label>
          <input id="nota-estado" placeholder="Salió por Andreani, número 40012345">
        </div>
        <div class="acciones">
          ${siguientes.map((e) => `
            <button class="btn ${e === 'cancelado' ? 'borde peligro' : ''}" data-mover-a="${e}">
              ${esc(e === 'confirmado' ? 'Confirmar: hay stock de todo' : 'Marcar ' + ESTADOS[e].toLowerCase())}
            </button>`).join('')}
          ${EDITABLES.includes(p.estado) ? '<button class="btn borde" data-editar-pedido>Modificar artículos y precio</button>' : ''}
        </div>`
      : `<p class="sub">Un pedido ${esc(ESTADOS[p.estado].toLowerCase())} ya no se mueve: es el final del camino.</p>`}

      <h4 class="separado">Avisos</h4>
      <p class="sub">Mail: ${esc(p.aviso_mail || '—')}<br>WhatsApp: ${esc(p.aviso_whatsapp || '—')}<br>Cliente: ${esc(p.aviso_cliente || '—')}</p>

      <div class="acciones">
        <a class="btn azul enlinea" href="/api/pedidos/${encodeURIComponent(p.numero)}/pedido.pdf">Remito A4</a>
        <a class="btn borde enlinea" href="/api/pedidos/${encodeURIComponent(p.numero)}/rotulo.pdf">Rótulo 10×15</a>
      </div>
    </div>`;
}

/*
 * ── Rearmar un pedido ────────────────────────────────────────────
 *
 * El caso que pidió el dueño: no hay todo para enviar y se arregla otra cosa.
 * Se edita el cuadro de color por talle igual que lo llenó el cliente, se
 * puede sumar otro producto, y el descuento o recargo se escribe como lo que
 * es —un porcentaje o un monto acordado—, no como un total a mano.
 *
 * El importe de abajo es una cuenta de esta pantalla con los precios que mandó
 * el servidor. Al guardar, el servidor la rehace desde cero con los suyos: si
 * alguien toca los precios del catálogo mientras esto está abierto, manda el
 * de él. Por eso el número dice "estimado" hasta que se guarda.
 */
function vistaEditorPedido() {
  const e = vista.editor;
  if (!e.lineas) return '<p class="cargando">Abriendo el pedido…</p>';

  const grillas = e.lineas.map((linea) => {
    if (!linea.combinaciones.length) {
      return `<div class="tarjeta">
        <h4>${esc(linea.titulo)}</h4>
        <p class="mensaje error">Este producto ya no está en el catálogo, así que no se puede volver a
        valorizar. Guardando, sale del pedido.</p>
      </div>`;
    }
    const porCruce = new Map(linea.combinaciones.map((c) => [`${c.color}|${c.talle}`, c]));
    const filas = linea.colores.map((color) => `
      <tr>
        <th>${esc(color)}</th>
        ${linea.talles.map((talle) => {
          const combo = porCruce.get(`${color}|${talle}`);
          if (!combo) return '<td class="sin-cruce" title="No existe en la grilla">—</td>';
          return `<td><input type="number" min="0" inputmode="numeric"
                    data-editor-sku="${esc(combo.sku)}" data-precio="${combo.precio}"
                    value="${combo.cantidad || ''}" placeholder="0"
                    aria-label="${esc(talle)} en ${esc(color)}"></td>`;
        }).join('')}
      </tr>`).join('');

    return `<div class="tarjeta">
      <h4>${esc(linea.titulo)} <span class="apagado">${esc(linea.categoria)}</span></h4>
      ${linea.huerfanos?.length ? `<p class="mensaje info">
        Esto se pidió y ya no está en la grilla del producto:
        ${linea.huerfanos.map((h) => `${esc(h.color || 'Único')} ${esc(h.talle)}×${h.cantidad}`).join(', ')}.
        No se puede volver a valorizar; guardando, sale del pedido.</p>` : ''}
      <div class="envoltorio-tabla">
        <table class="datos editor-grilla">
          <thead><tr><th></th>${linea.talles.map((t) => `<th>${esc(t)}</th>`).join('')}</tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <button class="btn texto quitar" data-sacar-linea="${esc(linea.skuAgrupador)}">Sacar este producto del pedido</button>
    </div>`;
  }).join('');

  const yaEstan = new Set(e.lineas.map((l) => l.skuAgrupador));
  const paraSumar = datos.productos.filter((p) => !yaEstan.has(p.sku_agrupador));

  return `
    <p><button class="btn texto" data-volver-pedidos>← Salir sin guardar</button></p>
    <div class="tarjeta">
      <h3>Modificar ${esc(e.numero)}</h3>
      <p class="sub">
        Poné las cantidades que van a salir de verdad. Al guardar, el pedido queda
        <b>modificado</b>, el cliente lo ve en su seguimiento y el detalle anterior se conserva.
      </p>
    </div>

    ${grillas}

    <div class="tarjeta">
      <h4>Sumar otro producto</h4>
      <div class="subida">
        <select id="sumar-producto" class="nombre-color">
          <option value="">Elegí un producto…</option>
          ${paraSumar.map((p) => `<option value="${esc(p.sku_agrupador)}">${esc(p.titulo)} — ${esc(p.categoria || 'sin categoría')}</option>`).join('')}
        </select>
        <button class="btn borde" data-sumar-producto>Agregar al pedido</button>
      </div>
    </div>

    <div class="tarjeta">
      <h4>Precio acordado</h4>
      <p class="sub">
        Los precios de cada artículo son los del catálogo y los pone el servidor. Si arreglaste
        otro número, se escribe acá como descuento o recargo y queda dicho por qué.
      </p>
      <div class="campos">
        <div class="campo">
          <label for="aj-tipo">Ajuste</label>
          <select id="aj-tipo">
            <option value=""${!e.ajuste ? ' selected' : ''}>Sin ajuste</option>
            <option value="porcentaje"${e.ajuste?.tipo === 'porcentaje' ? ' selected' : ''}>Porcentaje</option>
            <option value="monto"${e.ajuste?.tipo === 'monto' ? ' selected' : ''}>Monto fijo</option>
          </select>
        </div>
        <div class="campo">
          <label for="aj-valor">Cuánto <span class="apagado">(negativo = descuento)</span></label>
          <input id="aj-valor" type="number" value="${e.ajuste ? e.ajuste.valor : ''}" placeholder="-10">
        </div>
        <div class="campo ancho">
          <label for="aj-motivo">Por qué <span class="apagado">(lo ve el cliente)</span></label>
          <input id="aj-motivo" value="${esc(e.ajuste?.motivo || '')}" placeholder="No había negro en todos los talles">
        </div>
        <div class="campo ancho">
          <label for="ed-nota">Nota del cambio <span class="apagado">(lo ve el cliente)</span></label>
          <input id="ed-nota" value="${esc(e.nota || '')}" placeholder="Te mandamos 2 azules en lugar de los negros que faltaban.">
        </div>
      </div>

      <div class="totales-fila">
        <div><span class="chico">UNIDADES</span><b id="ed-unidades">0</b></div>
        <div><span class="chico">SUMA DE ARTÍCULOS</span><b id="ed-base">$ 0</b></div>
        <div><span class="chico">TOTAL ESTIMADO</span><b id="ed-total">$ 0</b></div>
      </div>
      <p class="chico">El total definitivo lo calcula el servidor al guardar, con sus precios.</p>

      <div class="acciones">
        <button class="btn" data-guardar-modificacion>Guardar y marcar modificado</button>
        <button class="btn texto" data-volver-pedidos>Cancelar</button>
      </div>
    </div>`;
}

/** Lee el cuadro y deja las cantidades en el modelo, para que repintar no las pierda. */
function leerEditor() {
  const e = vista.editor;
  if (!e?.lineas) return;
  const cantidades = new Map();
  for (const i of raiz.querySelectorAll('[data-editor-sku]')) {
    cantidades.set(i.dataset.editorSku, Math.max(0, Math.trunc(Number(i.value) || 0)));
  }
  for (const linea of e.lineas) {
    for (const c of linea.combinaciones) {
      if (cantidades.has(c.sku)) c.cantidad = cantidades.get(c.sku);
    }
  }
  const tipo = el('#aj-tipo')?.value || '';
  e.ajuste = tipo ? { tipo, valor: Number(el('#aj-valor')?.value) || 0, motivo: el('#aj-motivo')?.value || '' } : null;
  e.nota = el('#ed-nota')?.value || '';
}

/*
 * La cuenta de abajo se refresca sin repintar la pantalla.
 *
 * Volver a dibujar el cuadro entero con cada tecla saca el foco del casillero
 * donde la persona está escribiendo — que es exactamente lo que hace que se
 * cargue mal una cantidad.
 */
function refrescarTotalEditor() {
  const e = vista.editor;
  if (!e?.lineas) return;
  let unidades = 0;
  let base = 0;
  for (const i of raiz.querySelectorAll('[data-editor-sku]')) {
    const n = Math.max(0, Math.trunc(Number(i.value) || 0));
    unidades += n;
    base += n * Number(i.dataset.precio || 0);
  }
  const tipo = el('#aj-tipo')?.value || '';
  const valor = Number(el('#aj-valor')?.value) || 0;
  const total = tipo === 'porcentaje' ? Math.round(base * (1 + valor / 100))
    : tipo === 'monto' ? Math.round(base + valor) : Math.round(base);

  if (el('#ed-unidades')) el('#ed-unidades').textContent = unidades;
  if (el('#ed-base')) el('#ed-base').textContent = pesos(base);
  if (el('#ed-total')) el('#ed-total').textContent = pesos(Math.max(0, total));
}

/*
 * Si el pedido cambió de estado y el filtro de arriba ya no lo trae, se vuelve
 * al historial en vez de dejar abierta la ficha de algo que la lista no tiene.
 */
function sacarDelDetalleSiSeFue(numero) {
  if (!datos.pedidos.some((x) => x.numero === numero)) vista.pedido = null;
}

const carritoDelEditor = () => vista.editor.lineas
  .filter((l) => l.combinaciones.length)
  .map((l) => ({
    skuAgrupador: l.skuAgrupador,
    cantidades: Object.fromEntries(l.combinaciones.filter((c) => c.cantidad > 0).map((c) => [c.sku, c.cantidad])),
  }))
  .filter((l) => Object.keys(l.cantidades).length);

// ══ ESTADÍSTICAS ══════════════════════════════════════════════════
/*
 * Lo que hay que mirar para decidir qué producir y qué reponer.
 *
 * No es un tablero para contemplar: son cinco preguntas con respuesta —cuánto
 * entró, cuánto se cobró, qué se vende, quién compra, y dónde la gente está
 * buscando algo que la grilla no tiene—. Todo lo que no contesta una de esas
 * cinco no está.
 *
 * Los gráficos son <div> con ancho y alto puestos por CSSOM. La política de
 * seguridad del sitio no deja atributos `style` ni librerías de afuera, y para
 * barras no hace falta nada más que eso.
 */
const barras = (items, etiquetar, medir, mostrar) => {
  const max = Math.max(1, ...items.map(medir));
  return `<ul class="barras">${items.map((x) => `
    <li>
      <span class="etq">${esc(etiquetar(x))}</span>
      <span class="pista"><i data-ancho="${Math.round((medir(x) / max) * 100)}"></i></span>
      <span class="val">${esc(mostrar(x))}</span>
    </li>`).join('')}</ul>`;
};

function graficoEvolucion(evolucion) {
  const puntos = evolucion.puntos;
  if (!puntos.length) return '<p class="sub">No entró ningún pedido en este período.</p>';

  const max = Math.max(...puntos.map((p) => p.importe));
  // Con más de doce columnas las etiquetas se pisan: se muestra una cada tanto
  // y el resto queda en el título de la barra, al pasar el mouse.
  const paso = Math.ceil(puntos.length / 12);
  const nombre = (clave) => (evolucion.porMes
    ? new Date(`${clave}-02`).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' })
    : clave.slice(8, 10) + '/' + clave.slice(5, 7));

  return `
    <div class="grafico">
      <ul class="columnas">${puntos.map((p, i) => `
        <li title="${esc(nombre(p.clave))}: ${p.pedidos} pedido${p.pedidos === 1 ? '' : 's'}, ${pesos(p.importe)}">
          <span class="col" data-alto="${Math.max(2, Math.round((p.importe / max) * 100))}"></span>
          <span class="pie">${i % paso === 0 ? esc(nombre(p.clave)) : ''}</span>
        </li>`).join('')}</ul>
    </div>
    <p class="chico">Cada barra es lo facturado ${evolucion.porMes ? 'en el mes' : 'en el día'}. El máximo del período es ${pesos(max)}.</p>`;
}

function vistaEstadisticas() {
  const s = datos.estadisticas;
  if (!s) return '<p class="cargando">Sacando cuentas…</p>';
  const r = s.resumen;
  const f = s.faltantes;
  const cobrable = Math.max(1, r.facturado);

  return `
    <div class="tarjeta">
      <h3>Período</h3>
      <p class="sub">Sin fechas, los últimos noventa días.</p>
      <div class="campos">
        <div class="campo"><label for="e-desde">Desde</label><input id="e-desde" type="date" value="${esc(filtroEstadisticas.desde)}"></div>
        <div class="campo"><label for="e-hasta">Hasta</label><input id="e-hasta" type="date" value="${esc(filtroEstadisticas.hasta)}"></div>
      </div>
      <div class="acciones">
        <button class="btn" data-ver-estadisticas>Ver</button>
        <button class="btn texto" data-periodo="30">Últimos 30 días</button>
        <button class="btn texto" data-periodo="90">90 días</button>
        <button class="btn texto" data-periodo="365">Un año</button>
      </div>
    </div>

    <div class="tarjeta">
      <h3>La plata</h3>
      <p class="sub">
        <b>Cobrado</b> es lo que llegó a destino: acá el portal no lleva estados de pago, y lo único
        que sabe con certeza es qué se entregó. Si alguien pagó por adelantado o quedó debiendo,
        eso todavía se lleva por afuera.
      </p>
      <div class="tarjetas-numero">
        <div><span>PEDIDOS</span><b>${r.pedidos}</b><small>${r.unidades} unidades</small></div>
        <div><span>FACTURADO</span><b>${pesos(r.facturado)}</b><small>sin los cancelados</small></div>
        <div class="verde"><span>COBRADO (ENTREGADOS)</span><b>${pesos(r.cobrado)}</b><small>${Math.round((r.cobrado / cobrable) * 100)} % de lo facturado</small></div>
        <div class="ambar"><span>POR COBRAR</span><b>${pesos(r.porCobrar)}</b><small>confirmados, modificados y enviados</small></div>
        <div class="rojo"><span>CANCELADO</span><b>${pesos(r.importeCancelado)}</b><small>${r.cancelados} pedido${r.cancelados === 1 ? '' : 's'}</small></div>
      </div>

      <div class="barra-compuesta">
        <i class="cobrado" data-ancho="${Math.round((r.cobrado / cobrable) * 100)}" title="Cobrado"></i>
        <i class="pendiente" data-ancho="${Math.round((r.porCobrar / cobrable) * 100)}" title="Por cobrar"></i>
      </div>

      <div class="totales-fila">
        <div><span class="chico">TICKET PROMEDIO</span><b>${pesos(r.ticket)}</b></div>
        <div><span class="chico">UNIDADES POR PEDIDO</span><b>${r.unidadesPorPedido}</b></div>
        <div><span class="chico">COMPRADORES</span><b>${r.clientes}</b></div>
      </div>
    </div>

    <div class="tarjeta">
      <h3>Cómo viene</h3>
      ${graficoEvolucion(s.evolucion)}
      <h4 class="separado">En qué estado está cada uno</h4>
      ${barras(s.porEstado.filter((e) => e.pedidos),
        (e) => ESTADOS[e.estado] || e.estado, (e) => e.pedidos,
        (e) => `${e.pedidos} · ${pesos(e.importe)}`)}
    </div>

    <div class="tarjeta">
      <h3>Lo más vendido</h3>
      <p class="sub">
        En plata, producto y categoría, que es donde el importe se puede repartir bien. Los colores
        y los talles van en unidades: adentro de un mismo producto conviven precios distintos y
        repartirlos sería inventar. Para decidir qué cortar, las unidades son el dato igual.
      </p>

      <h4>Productos</h4>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Producto</th><th>Categoría</th><th>U.</th><th>Facturado</th><th>Pedidos</th></tr></thead>
          <tbody>${s.ranking.productos.map((p) => `
            <tr>
              <td><div class="semi">${esc(p.titulo)}</div><div class="chico">${esc(p.clave)}</div></td>
              <td class="chico">${esc(p.categoria || '—')}</td>
              <td class="centrado">${p.unidades}</td>
              <td class="fuerte">${pesos(p.importe)}</td>
              <td class="centrado">${p.pedidos}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="vacio-tabla">Sin ventas en el período.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="dos-columnas">
        <div>
          <h4 class="separado">Categorías</h4>
          ${barras(s.ranking.categorias, (c) => c.clave, (c) => c.importe, (c) => pesos(c.importe))}
        </div>
        <div>
          <h4 class="separado">Colores <span class="apagado">(unidades)</span></h4>
          ${barras(s.ranking.colores, (c) => c.clave, (c) => c.unidades, (c) => `${c.unidades} u.`)}
        </div>
        <div>
          <h4 class="separado">Talles <span class="apagado">(unidades)</span></h4>
          ${barras(s.ranking.talles, (t) => t.clave, (t) => t.unidades, (t) => `${t.unidades} u.`)}
        </div>
        <div>
          <h4 class="separado">Quién compra</h4>
          ${barras(s.clientes, (c) => c.nombre + (c.conCuenta ? '' : ' (sin cuenta)'), (c) => c.importe,
            (c) => `${pesos(c.importe)} · ${c.pedidos}`)}
        </div>
      </div>
    </div>

    <div class="tarjeta">
      <h3>Qué piden y no hay</h3>
      <p class="sub">
        El catálogo no lleva stock: lo que "no hay" es el cruce de color y talle que el producto
        no tiene en la grilla. De los <b>${f.crucesPosibles}</b> cruces que darían los colores y
        talles de cada producto, <b>${f.crucesQueFaltan}</b> no existen, repartidos en
        <b>${f.productosConHuecos}</b> productos.
      </p>

      ${f.hayRegistro ? `
        <h4>Los que alguien buscó</h4>
        <p class="sub">Cruces que un cliente tocó en la tienda y no tenían casillero.</p>
        <div class="envoltorio-tabla">
          <table class="datos">
            <thead><tr><th>Producto</th><th>Color</th><th>Talle</th><th>Veces</th></tr></thead>
            <tbody>${f.registrados.map((x) => `
              <tr><td class="semi">${esc(x.titulo)}</td><td>${esc(x.color || '—')}</td>
                  <td>${esc(x.talle)}</td><td class="fuerte centrado">${x.intentos}</td></tr>`).join('')}</tbody>
          </table>
        </div>`
      : `<p class="mensaje info">
          Todavía no hay intentos registrados. La tienda tiene que avisar cuando alguien toca un
          cruce que no existe; mientras tanto, lo de abajo se calcula con lo que ya está guardado.
        </p>`}

      <h4 class="separado">Huecos con demanda al lado</h4>
      <p class="sub">
        El producto no tiene ese color en ese talle, pero en el período se pidieron unidades de ese
        mismo color en otros talles y de ese mismo talle en otros colores. No prueba que alguien lo
        haya querido: dice dónde mirar primero.
      </p>
      <div class="envoltorio-tabla">
        <table class="datos">
          <thead><tr><th>Producto</th><th>Huecos</th><th>Se pidió al lado</th><th>Cuáles</th></tr></thead>
          <tbody>${f.productos.map((p) => `
            <tr>
              <td><div class="semi">${esc(p.titulo)}</div><div class="chico">${esc(p.sku)}</div></td>
              <td class="centrado">${p.faltan} <span class="chico">de ${p.cruces}</span></td>
              <td class="fuerte centrado">${p.vecina} u.</td>
              <td class="chico">${p.huecos.map((h) => `${esc(h.color || 'Único')} ${esc(h.talle)}${h.vecina ? ` <b>(${h.vecina})</b>` : ''}`).join(' · ')}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="vacio-tabla">Ningún producto tiene huecos en la grilla.</td></tr>'}</tbody>
        </table>
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
  ['masivo', 'Precios en masa'], ['pedidos', 'Pedidos'],
  ['estadisticas', 'Estadísticas'], ['clientes', 'Clientes'], ['avisos', 'Avisos'],
];

function pintar() {
  const vistas = {
    catalogo: vistaCatalogo, colores: vistaColores, talles: vistaTalles,
    masivo: vistaMasivo, pedidos: vistaPedidos, estadisticas: vistaEstadisticas,
    clientes: vistaClientes, avisos: vistaAvisos,
  };
  raiz.innerHTML = `
    <div class="tabs">
      ${TABS.map(([id, nombre]) => `<button data-tab="${id}" aria-current="${vista.tab === id}">${nombre}</button>`).join('')}
    </div>
    ${pintarAviso()}
    <div id="contenido">${vistas[vista.tab]()}</div>`;
  aviso = null;
  /*
   * Colores y tamaños se ponen por CSSOM, después de pintar.
   *
   * La política de seguridad del sitio no lleva 'unsafe-inline' en style-src:
   * un atributo `style="..."` escrito en el HTML que arma este archivo no se
   * aplica —el navegador lo bloquea sin decir nada y la barra sale sin ancho—.
   * Asignar la propiedad desde JavaScript no pasa por esa política.
   */
  for (const i of raiz.querySelectorAll('[data-hex]')) {
    if (i.tagName === 'I') i.style.background = i.dataset.hex;
  }
  for (const i of raiz.querySelectorAll('[data-ancho]')) i.style.width = `${i.dataset.ancho}%`;
  for (const i of raiz.querySelectorAll('[data-alto]')) i.style.height = `${i.dataset.alto}%`;
  refrescarTotalEditor();
  el('#salir').hidden = false;
  seguirAvisos();
}

// ══ AVISOS ════════════════════════════════════════════════════════
/*
 * A dónde avisa el portal cuando entra un pedido.
 *
 * El mail no se configura desde acá —son variables del servidor—, pero sí se
 * dice si falta: sin eso no sale ningún mail, ni a ISUWAYA ni a los clientes, y
 * nada en el resto del panel lo haría notar.
 *
 * El WhatsApp se vincula escaneando un QR, como WhatsApp Web, y después se
 * elige el grupo. Mientras se espera el escaneo, la pantalla se actualiza sola:
 * el QR cambia cada tanto y uno viejo ya no sirve.
 */
const ESTADO_WHATSAPP = {
  apagado: ['no', 'Sin vincular'],
  conectando: ['aviso', 'Conectando…'],
  'esperando-qr': ['aviso', 'Esperando que escanees el QR'],
  conectado: ['si', 'Conectado'],
  reconectando: ['aviso', 'Reconectando…'],
  desvinculado: ['no', 'Desvinculado'],
  error: ['no', 'Con error'],
};
let timerAvisos = null;

async function cargarAvisos() {
  datos.avisos = await api('/avisos');
  if (datos.avisos.whatsapp.conexion === 'conectado' && !datos.gruposWhatsapp) {
    try { datos.gruposWhatsapp = (await api('/whatsapp/grupos')).grupos; } catch { datos.gruposWhatsapp = null; }
  }
}

function seguirAvisos() {
  clearTimeout(timerAvisos);
  const conexion = datos.avisos?.whatsapp?.conexion;
  if (vista.tab !== 'avisos' || !['conectando', 'esperando-qr', 'reconectando'].includes(conexion)) return;
  timerAvisos = setTimeout(() => conError(async () => {
    if (vista.tab !== 'avisos') return;
    await cargarAvisos();
    pintar();
  }), 3000);
}

function vistaAvisos() {
  if (!datos.avisos) return '<p class="cargando">Mirando cómo están los avisos…</p>';
  const { mail, whatsapp: w } = datos.avisos;
  const [clase, etiqueta] = ESTADO_WHATSAPP[w.conexion] || ['no', w.conexion];

  let cuerpo;
  if (w.conexion === 'esperando-qr' && w.qr) {
    cuerpo = `
      <div class="qr-caja">
        <img class="qr-whatsapp" src="${esc(w.qr)}" alt="Código QR para vincular WhatsApp">
        <ol class="pasos-qr">
          <li>Abrí WhatsApp en el teléfono del número que va a mandar los pedidos.</li>
          <li>Tocá <b>Dispositivos vinculados</b> y después <b>Vincular un dispositivo</b>.</li>
          <li>Escaneá este código. Si cambia, no pasa nada: la pantalla se actualiza sola.</li>
        </ol>
      </div>`;
  } else if (w.conexion === 'conectado') {
    const grupos = datos.gruposWhatsapp;
    cuerpo = `
      <p>Conectado${w.numero ? ` con el número <b>+${esc(w.numero)}</b>` : ''}.</p>
      <p>${w.grupo
        ? `Los pedidos nuevos van al grupo <b>${esc(w.grupo.nombre)}</b>.`
        : '<span class="pastilla aviso">Falta elegir el grupo</span> Hasta que lo elijas, los pedidos no llegan por WhatsApp.'}</p>
      ${grupos ? `
        <div class="campos">
          <div class="campo ancho">
            <label for="wa-grupo">Grupo de los empleados</label>
            <select id="wa-grupo">
              <option value="">Elegí un grupo…</option>
              ${grupos.map((g) => `<option value="${esc(g.id)}"${w.grupo?.id === g.id ? ' selected' : ''}>${esc(g.nombre)} (${g.integrantes} personas)</option>`).join('')}
            </select>
          </div>
        </div>` : '<p class="sub">No pude traer los grupos de este WhatsApp.</p>'}
      <div class="acciones">
        ${grupos ? '<button class="btn" data-wa-grupo>Guardar grupo</button>' : '<button class="btn borde" data-wa-buscar>Buscar grupos</button>'}
        ${w.grupo ? '<button class="btn borde" data-wa-prueba>Mandar mensaje de prueba</button>' : ''}
        <button class="btn texto quitar" data-wa-desvincular>Desvincular</button>
      </div>`;
  } else if (['conectando', 'reconectando'].includes(w.conexion)) {
    cuerpo = '<p class="cargando">Conectando con WhatsApp…</p>';
  } else {
    cuerpo = `
      ${w.error ? `<p class="mensaje error">${esc(w.error)}</p>` : ''}
      <div class="acciones"><button class="btn" data-wa-vincular>Vincular WhatsApp</button></div>`;
  }

  return `
    <div class="tarjeta">
      <h3>Mail</h3>
      ${mail.configurado
        ? `<p class="mensaje ok">Configurado. Los pedidos nuevos llegan a <b>${esc(mail.destino || 'sin destino cargado')}</b>, y los clientes que dejan su mail reciben la copia y cada confirmación.</p>`
        : `<p class="mensaje error">Falta configurar el correo: sin eso no sale ningún mail, ni a ustedes ni a los clientes.
             En Railway, en <b>Variables</b>, cargá <b>MAIL_USER</b> (la cuenta de Gmail) y <b>MAIL_PASS</b> (una contraseña de aplicación de Google).</p>`}
    </div>
    <div class="tarjeta">
      <h3>WhatsApp del grupo de empleados <span class="pastilla ${clase}">${esc(etiqueta)}</span></h3>
      <p class="mensaje info">
        Se conecta un WhatsApp común, como WhatsApp Web. No es la vía oficial de WhatsApp y el número puede quedar
        bloqueado: usá un número aparte, no el principal del negocio. Si se corta, los pedidos entran igual y el mail sale igual.
      </p>
      ${cuerpo}
    </div>`;
}

/** Trae las estadísticas del período elegido. */
async function cargarEstadisticas() {
  const q = new URLSearchParams(Object.entries(filtroEstadisticas).filter(([, v]) => v)).toString();
  datos.estadisticas = await api(`/estadisticas${q ? `?${q}` : ''}`);
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
  try { await fn(); } catch (e) {
    /*
     * Si el servidor dice que ya no sos el administrador, el panel se vacía.
     *
     * Pasa cuando la sesión vence con la pestaña abierta o cuando se cerró
     * desde otro lado. Mostrar el error arriba y dejar abajo la lista de
     * clientes y el historial deja a la vista datos de una sesión que ya no
     * existe.
     */
    if (e.status === 401 || e.status === 503) {
      datos = { productos: [], categorias: [], colores: [], talles: [], pedidos: [], totales: null, clientes: [], estadisticas: null };
      detalle = null;
      vista.editor = null;
      return pintarSinPermiso(e.status === 503 ? e.message : 'Se cerró tu sesión. Entrá de nuevo para ver el panel.');
    }
    mensaje(e.message, 'error');
    pintar();
  }
};

/*
 * Lo que se ve acá no puede sobrevivir a la sesión.
 *
 * El navegador congela la página entera cuando se sale de ella y el botón
 * Atrás la devuelve tal cual estaba: el DOM ya pintado y sin volver a correr
 * una línea de JavaScript, así que el chequeo de sesión nunca pasa. En una
 * computadora compartida eso deja el catálogo, los clientes y el historial de
 * pedidos a un Atrás de distancia del que se siente después.
 *
 * Son dos cosas y las dos hacen falta: al irse se borra lo pintado, para que
 * lo que se congele no tenga datos de nadie; y al volver se recarga, que es la
 * única forma de que el servidor vuelva a decir quién sos.
 */
window.addEventListener('pagehide', () => {
  datos = { productos: [], categorias: [], colores: [], talles: [], pedidos: [], totales: null, clientes: [], estadisticas: null };
  detalle = null;
  vista.editor = null;
  raiz.innerHTML = '<p class="cargando">Un momento…</p>';
});
window.addEventListener('pageshow', (e) => { if (e.persisted) window.location.reload(); });

// ══ Eventos ═══════════════════════════════════════════════════════
raiz.addEventListener('click', (e) => conError(async () => {
  const t = e.target;

  const tab = t.closest('[data-tab]');
  if (tab) {
    vista.tab = tab.dataset.tab; vista.sku = null; vista.pedido = null; vista.editor = null;
    pintar();
    // Las cuentas se piden al abrir la pestaña y no en cada carga del panel:
    // recorren todos los pedidos del período y nadie las mira desde el catálogo.
    if (vista.tab === 'estadisticas' && !datos.estadisticas) {
      await cargarEstadisticas();
      pintar();
    }
    // Los avisos se miran de nuevo cada vez: el WhatsApp se pudo haber cortado desde la última.
    if (vista.tab === 'avisos') {
      await cargarAvisos();
      pintar();
    }
    return;
  }

  if (t.closest('[data-volver]')) { vista.sku = null; detalle = null; pintar(); return; }
  if (t.closest('[data-volver-pedidos]')) { vista.pedido = null; vista.editor = null; pintar(); return; }

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

  // ── Los colores del producto
  const cambiarColor = t.closest('[data-cambiar-color]');
  if (cambiarColor) {
    const id = cambiarColor.dataset.cambiarColor;
    const destino = raiz.querySelector(`[data-cambiar-a="${id}"]`);
    if (!destino?.value) { mensaje('Elegí a qué color cambiarlo.', 'error'); pintar(); return; }
    const nombreNuevo = destino.selectedOptions[0].textContent;
    // Toca todos los talles de una vez: se pregunta antes, no se deshace con un clic.
    if (!window.confirm(`¿Cambiar ${cambiarColor.dataset.nombre} por ${nombreNuevo} en todos los talles de este producto?`)) return;
    const r = await api(`/productos/${encodeURIComponent(vista.sku)}/colores/${id}`, {
      method: 'PUT', body: JSON.stringify({ nuevoColorId: Number(destino.value) }),
    });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    mensaje(`Listo: ${r.variantes} variantes pasaron a ${nombreNuevo}`
      + (r.fotos.movidas ? `, con ${r.fotos.movidas} fotos` : '')
      + (r.fotos.generales ? `. ${r.fotos.generales} fotos pasaron a generales porque ${nombreNuevo} ya tenía cinco` : '') + '.');
    pintar();
    return;
  }
  const quitarColor = t.closest('[data-quitar-color]');
  if (quitarColor) {
    const nombre = quitarColor.dataset.nombre;
    if (!window.confirm(`¿Quitar ${nombre} de este producto, con todos sus talles? Sus fotos pasan a generales.`)) return;
    const r = await api(`/productos/${encodeURIComponent(vista.sku)}/colores/${quitarColor.dataset.quitarColor}`, { method: 'DELETE' });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    mensaje(`Listo: se quitó ${nombre} (${r.variantes} variantes)`
      + (r.fotosAGenerales ? ` y sus ${r.fotosAGenerales} fotos pasaron a generales` : '')
      + '. No vuelve aunque se importe la planilla.');
    pintar();
    return;
  }
  if (t.closest('[data-agregar-color]')) {
    const elegido = el('#agregar-color');
    if (!elegido?.value) { mensaje('Elegí qué color agregar.', 'error'); pintar(); return; }
    const nombre = elegido.selectedOptions[0].textContent;
    const talles = [...raiz.querySelectorAll('.talle-nuevo-color:checked')].map((i) => i.value);
    if (!talles.length) { mensaje('Marcá al menos un talle.', 'error'); pintar(); return; }
    const r = await api(`/productos/${encodeURIComponent(vista.sku)}/colores`, {
      method: 'POST', body: JSON.stringify({ colorId: Number(elegido.value), talles }),
    });
    detalle = await api(`/productos/${encodeURIComponent(vista.sku)}`);
    await cargar();
    mensaje(`Listo: ${nombre} agregado en ${r.creadas} ${r.creadas === 1 ? 'talle' : 'talles'}.`);
    pintar();
    return;
  }

  // ── Avisos: el WhatsApp del grupo
  if (t.closest('[data-wa-vincular]')) {
    datos.avisos.whatsapp = await api('/whatsapp/vincular', { method: 'POST' });
    datos.gruposWhatsapp = null;
    pintar();
    return;
  }
  if (t.closest('[data-wa-buscar]')) {
    datos.gruposWhatsapp = (await api('/whatsapp/grupos')).grupos;
    pintar();
    return;
  }
  if (t.closest('[data-wa-grupo]')) {
    const id = el('#wa-grupo')?.value;
    if (!id) { mensaje('Elegí el grupo.', 'error'); pintar(); return; }
    const r = await api('/whatsapp/grupo', { method: 'PUT', body: JSON.stringify({ id }) });
    await cargarAvisos();
    mensaje(`Listo: los pedidos nuevos van a llegar al grupo ${r.grupo.nombre}.`);
    pintar();
    return;
  }
  if (t.closest('[data-wa-prueba]')) {
    const r = await api('/whatsapp/prueba', { method: 'POST' });
    mensaje(`Mandé un mensaje de prueba al grupo ${r.grupo.nombre}. Fijate que haya llegado.`);
    pintar();
    return;
  }
  if (t.closest('[data-wa-desvincular]')) {
    if (!window.confirm('¿Desvincular el WhatsApp? Los pedidos dejan de llegar al grupo hasta que lo vuelvas a vincular.')) return;
    datos.avisos.whatsapp = await api('/whatsapp/desvincular', { method: 'POST' });
    datos.gruposWhatsapp = null;
    mensaje('WhatsApp desvinculado.');
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

  // ── Seguimiento: mover el pedido de estado
  const moverA = t.closest('[data-mover-a]');
  if (moverA) {
    const numero = vista.pedido;
    const r = await api(`/pedidos/${encodeURIComponent(numero)}/estado`, {
      method: 'PUT',
      body: JSON.stringify({ estado: moverA.dataset.moverA, nota: el('#nota-estado')?.value || '' }),
    });
    await cargar();
    sacarDelDetalleSiSeFue(numero);
    mensaje(`${numero}: ${ESTADOS[r.pedido.estado].toLowerCase()}.${r.avisoCliente ? ` Aviso al cliente: ${r.avisoCliente}.` : ''}`);
    pintar();
    return;
  }

  // ── Seguimiento: rearmar el pedido
  if (t.closest('[data-editar-pedido]')) {
    vista.editor = { numero: vista.pedido, lineas: null, ajuste: null, nota: '' };
    pintar();
    const r = await api(`/pedidos/${encodeURIComponent(vista.pedido)}/editor`);
    vista.editor = { numero: r.numero, lineas: r.lineas, ajuste: r.ajuste, nota: '' };
    pintar();
    return;
  }

  const sacar = t.closest('[data-sacar-linea]');
  if (sacar) {
    leerEditor();
    vista.editor.lineas = vista.editor.lineas.filter((l) => l.skuAgrupador !== sacar.dataset.sacarLinea);
    pintar();
    return;
  }

  if (t.closest('[data-sumar-producto]')) {
    const sku = el('#sumar-producto').value;
    if (!sku) { mensaje('Elegí un producto de la lista.', 'error'); return pintar(); }
    leerEditor();
    const r = await api(`/grilla/${encodeURIComponent(sku)}`);
    vista.editor.lineas = [...vista.editor.lineas, r.linea];
    pintar();
    return;
  }

  if (t.closest('[data-guardar-modificacion]')) {
    leerEditor();
    const e = vista.editor;
    const carrito = carritoDelEditor();
    if (!carrito.length) {
      mensaje('El pedido quedaría vacío. Si no va a salir, marcalo cancelado.', 'error');
      return pintar();
    }
    /*
     * Van SKU y cantidades. El importe no se manda ni de casualidad: el
     * servidor valoriza con sus precios y devuelve el total que vale.
     */
    const r = await api(`/pedidos/${encodeURIComponent(e.numero)}/items`, {
      method: 'PUT',
      body: JSON.stringify({ carrito, ajuste: e.ajuste, nota: e.nota }),
    });
    vista.editor = null;
    vista.pedido = e.numero;
    await cargar();
    sacarDelDetalleSiSeFue(e.numero);
    mensaje(`${e.numero} quedó modificado: ${pesos(r.pedido.total)}, ${r.pedido.unidades} u. El cliente ya lo ve.`);
    pintar();
    return;
  }

  // ── Estadísticas
  if (t.closest('[data-ver-estadisticas]')) {
    filtroEstadisticas = { desde: el('#e-desde').value, hasta: el('#e-hasta').value };
    datos.estadisticas = null;
    pintar();
    await cargarEstadisticas();
    pintar();
    return;
  }

  const periodo = t.closest('[data-periodo]');
  if (periodo) {
    const dias = Number(periodo.dataset.periodo);
    const desde = new Date(Date.now() - dias * 86400000);
    filtroEstadisticas = { desde: desde.toISOString().slice(0, 10), hasta: '' };
    datos.estadisticas = null;
    pintar();
    await cargarEstadisticas();
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

  if (t.dataset?.mover !== undefined) {
    if (!t.value) return;
    const numero = t.closest('tr').dataset.numero;
    await api(`/pedidos/${encodeURIComponent(numero)}/estado`, {
      method: 'PUT', body: JSON.stringify({ estado: t.value }),
    });
    /*
     * Se recarga la lista entera y no sólo esa fila: al cambiar el estado
     * cambian los pasos que se pueden ofrecer, y una fila que quedó diciendo
     * "Mover a: enviado" sobre un pedido ya enviado es un clic que va a fallar.
     */
    await cargar();
    mensaje(`${numero}: ${ESTADOS[t.value].toLowerCase()}.`);
    pintar();
    return;
  }
  if (t.id === 'aj-tipo' || t.id === 'aj-valor') { refrescarTotalEditor(); return; }
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

/*
 * La cuenta del editor se rehace con cada tecla, sin repintar.
 *
 * Quien está rearmando un pedido necesita ver a cuánto va quedando mientras
 * escribe: sin esto tendría que guardar para saber si el descuento le cierra,
 * y guardar deja un "modificado" en el historial del cliente.
 */
raiz.addEventListener('input', (e) => {
  if (e.target.dataset?.editorSku !== undefined || e.target.id === 'aj-valor') refrescarTotalEditor();
});

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
