const { db } = require('./db');

/*
 * Lo que ISUWAYA le cuenta a STOCKER.
 *
 * STOCKER es el sistema de stock y ventas del negocio; ISUWAYA es el catálogo
 * mayorista donde el cliente arma el pedido. El circuito es el mismo que STOCKER
 * ya tiene para Mercado Libre y Jumpseller:
 *
 *   1. El cliente confirma el pedido acá  → STOCKER lo encola y APARTA el stock.
 *      La mercadería queda comprometida y nadie más la vende.
 *   2. Se coordina con el cliente, se confirma el stock y se elige cómo pagó.
 *   3. El pedido sale  → STOCKER lo despacha: ahí recién EGRESA el stock, con
 *      su cliente y su forma de pago.
 *
 * ── Por qué una cola y no una llamada directa ──────────────────────
 *
 * El pedido se confirma en ISUWAYA aunque STOCKER esté caído: el cliente ya
 * apretó el botón y su pedido no puede depender de que otro sistema conteste a
 * tiempo. Cada cambio se anota en `stocker_cola` y se manda después, con
 * reintentos que esperan cada vez un poco más.
 *
 * ── Por qué va el pedido entero en cada envío ──────────────────────
 *
 * Cada fila de la cola lleva el pedido COMPLETO tal como quedó, no el cambio.
 * Así reintentar es volver a mandar el estado actual: no importa cuántas veces
 * llegue ni en qué orden, el último gana. La secuencia —el id de la fila— le
 * permite a STOCKER descartar una entrega vieja que llegó tarde.
 */

const URL_BASE = (process.env.STOCKER_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.STOCKER_TOKEN || '';
const NEGOCIO = Number(process.env.STOCKER_NEGOCIO) || null;
const RUTA = process.env.STOCKER_RUTA || '/integraciones/isuwaya/pedidos';
const ESPERA_ENVIO = Number(process.env.STOCKER_TIMEOUT_MS) || 15_000;
const CADA = Number(process.env.STOCKER_CADA_MS) || 20_000;
const TOPE_INTENTOS = 12;      // con la espera creciente, son casi dos días de reintentos
const TOPE_POR_VUELTA = 20;

/** Sin las tres variables no hay a dónde mandar: la integración queda apagada. */
const configurado = () => Boolean(URL_BASE && TOKEN && NEGOCIO);

const EVENTOS = ['alta', 'confirmado', 'modificado', 'enviado', 'entregado', 'cancelado'];

const recortar = (v, largo) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, largo) : null;
};
const soloNumeros = (v) => String(v ?? '').replace(/\D/g, '');

// ── El pedido, con los SKU que entiende STOCKER ───────────────────
/*
 * El pedido guarda el SKU del producto padre y el detalle por color y talle;
 * STOCKER descuenta por SKU de variante. La traducción se hace acá, contra el
 * catálogo, con los mismos nombres canónicos de color y talle con los que se
 * armó el pedido.
 *
 * Una variante que ya no está en el catálogo —el producto cambió después del
 * pedido— no se saltea: va con un SKU marcado, igual que hace Jumpseller con
 * sus líneas sin SKU, para que el pedido quede completo y se vea qué falta
 * identificar en vez de desaparecer una línea sin que nadie lo note.
 */
function variantesDelProducto(skuAgrupador) {
  const filas = db.prepare(`
    SELECT v.sku,
           COALESCE(c.nombre, v.color) AS color,
           COALESCE(t.nombre, v.talle) AS talle,
           v.precio
    FROM variantes v
    JOIN productos p ON p.id = v.producto_id
    LEFT JOIN colores c ON c.id = v.color_id
    LEFT JOIN talles  t ON t.id = v.talle_id
    WHERE p.sku_agrupador = ?`).all(skuAgrupador);
  return new Map(filas.map((f) => [`${f.color}|${f.talle}`, f]));
}

function lineasDelPedido(pedido) {
  let items = [];
  try { items = JSON.parse(pedido.items) || []; } catch { items = []; }
  const lineas = [];

  for (const it of items) {
    const variantes = variantesDelProducto(it.skuAgrupador);
    for (const linea of it.detalle || []) {
      for (const t of linea.talles || []) {
        const cantidad = Math.trunc(Number(t.cantidad) || 0);
        if (cantidad <= 0) continue;
        const variante = variantes.get(`${linea.color}|${t.talle}`);
        lineas.push({
          sku: recortar(variante?.sku || `SIN-SKU:${it.skuAgrupador}:${linea.color}:${t.talle}`, 80),
          cantidad,
          precioUnitario: Number(variante?.precio ?? it.precio) || null,
          // Descriptivo, para la pantalla del depósito. STOCKER puede ignorarlo.
          producto: recortar(it.titulo, 150),
          color: recortar(linea.color, 60),
          talle: recortar(t.talle, 20),
        });
      }
    }
  }
  return lineas;
}

/*
 * El cuerpo que viaja.
 *
 * Va separado en `comprador` y `cliente` a propósito: el primero es lo que
 * guarda el pedido de plataforma en STOCKER (nombre 150, documento 20, email
 * 150) y el segundo es la ficha de cliente (nombre 100, teléfono 30, dirección
 * 255). Cada campo sale ya recortado al largo de SU columna, así el otro lado
 * no tiene que adivinar cuál de los dos límites aplica.
 */
function cuerpoDelPedido(pedido, evento, secuencia) {
  let cliente = {};
  try { cliente = JSON.parse(pedido.cliente) || {}; } catch { cliente = {}; }

  const direccion = [
    cliente.direccion,
    cliente.entreCalles ? `(entre ${cliente.entreCalles})` : null,
    cliente.ciudad,
    cliente.codigoPostal ? `(${cliente.codigoPostal})` : null,
    cliente.provincia,
  ].filter(Boolean).join(', ');

  return {
    negocioId: NEGOCIO,
    plataforma: 'isuwaya',
    evento,
    secuencia,
    pedidoExterno: recortar(pedido.numero, 60),
    estado: pedido.estado,
    creadoEn: pedido.creado_en,
    actualizadoEn: pedido.actualizado_en || pedido.creado_en,
    total: Number(pedido.total) || 0,
    unidades: Math.trunc(Number(pedido.unidades) || 0),
    pago: {
      forma: recortar(pedido.pago_forma, 60),
      condicion: recortar(pedido.pago_condicion, 20) || 'contado',
    },
    comprador: {
      nombre: recortar(cliente.nombre, 150),
      documento: recortar(soloNumeros(cliente.cuit), 20),
      email: recortar(cliente.email, 150),
    },
    cliente: {
      nombre: recortar(cliente.nombre, 100),
      apellido: null,
      cuit: recortar(cliente.cuit, 20),
      email: recortar(cliente.email, 150),
      telefono: recortar(cliente.telefono, 30),
      whatsapp: recortar(cliente.telefono, 30),
      direccion: recortar(direccion, 255),
      tipo: 'mayorista',
    },
    envio: {
      forma: recortar(cliente.formaEnvio, 60),
      direccion: recortar(cliente.direccion, 255),
      entreCalles: recortar(cliente.entreCalles, 255),
      localidad: recortar(cliente.ciudad, 100),
      provincia: recortar(cliente.provincia, 100),
      codigoPostal: recortar(cliente.codigoPostal, 20),
    },
    items: lineasDelPedido(pedido),
  };
}

// ── La cola ───────────────────────────────────────────────────────
const marcarPedido = (pedidoId, estado, error = null) => db
  .prepare('UPDATE pedidos SET stocker_estado = ?, stocker_error = ? WHERE id = ?')
  .run(estado, error, pedidoId);

/**
 * Anota un cambio para mandarlo. No llama a nadie: eso lo hace la cola después.
 * Si la integración no está configurada, el pedido queda marcado como apagado
 * en vez de acumular envíos que no tienen a dónde ir.
 */
function anotar(pedido, evento) {
  if (!EVENTOS.includes(evento)) throw new Error(`Evento desconocido para STOCKER: ${evento}`);
  if (!configurado()) {
    marcarPedido(pedido.id, 'apagado');
    return null;
  }
  const ahora = new Date().toISOString();
  const fila = db.prepare(`
    INSERT INTO stocker_cola (pedido_id, numero, evento, cuerpo, creado_en, proximo_en)
    VALUES (?, ?, ?, '', ?, ?)`).run(pedido.id, pedido.numero, evento, ahora, ahora);

  // El cuerpo se arma con la secuencia ya asignada: es el id de esta fila.
  const cuerpo = cuerpoDelPedido(pedido, evento, fila.lastInsertRowid);
  db.prepare('UPDATE stocker_cola SET cuerpo = ? WHERE id = ?')
    .run(JSON.stringify(cuerpo), fila.lastInsertRowid);
  marcarPedido(pedido.id, 'pendiente');
  return fila.lastInsertRowid;
}

/** La espera antes del próximo intento: medio minuto, después el doble, hasta una hora. */
const esperaDelIntento = (intentos) => Math.min(3_600_000, 30_000 * 2 ** Math.min(intentos, 7));

async function mandar(cuerpo) {
  const corte = AbortSignal.timeout(ESPERA_ENVIO);
  const r = await fetch(`${URL_BASE}${RUTA}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: cuerpo,
    signal: corte,
  });
  const texto = await r.text().catch(() => '');
  if (r.ok) return { ok: true, respuesta: texto.slice(0, 300) };
  /*
   * Un 4xx que no es de espera significa que el cuerpo está mal: reintentarlo
   * mil veces sólo llena el log. Se deja en error y se ve en el panel, que es
   * donde alguien puede hacer algo.
   */
  const definitivo = r.status >= 400 && r.status < 500 && ![408, 429].includes(r.status);
  return { ok: false, definitivo, motivo: `${r.status} ${texto.slice(0, 200)}` };
}

/**
 * Manda lo que esté pendiente y le toque. De a un pedido por vez, en orden: un
 * pedido cuyo envío falla no deja pasar a los siguientes suyos, para que STOCKER
 * no reciba el despacho de algo que todavía no dio de alta.
 */
async function procesarCola({ tope = TOPE_POR_VUELTA } = {}) {
  if (!configurado()) return { mandados: 0, fallados: 0, apagado: true };
  const ahora = new Date().toISOString();
  const pendientes = db.prepare(`
    SELECT * FROM stocker_cola
    WHERE estado = 'pendiente' AND (proximo_en IS NULL OR proximo_en <= ?)
    ORDER BY id LIMIT ?`).all(ahora, tope);

  const frenados = new Set();
  let mandados = 0;
  let fallados = 0;

  for (const fila of pendientes) {
    if (frenados.has(fila.pedido_id)) continue;
    let resultado;
    try {
      resultado = await mandar(fila.cuerpo);
    } catch (e) {
      resultado = { ok: false, motivo: String(e?.message || e).slice(0, 200) };
    }

    if (resultado.ok) {
      db.prepare(`UPDATE stocker_cola SET estado = 'enviado', enviado_en = ?, ultimo_error = NULL WHERE id = ?`)
        .run(new Date().toISOString(), fila.id);
      mandados += 1;
      const quedan = db.prepare(
        `SELECT COUNT(*) n FROM stocker_cola WHERE pedido_id = ? AND estado = 'pendiente'`,
      ).get(fila.pedido_id).n;
      if (!quedan) marcarPedido(fila.pedido_id, 'enviado');
      continue;
    }

    fallados += 1;
    frenados.add(fila.pedido_id);
    const intentos = fila.intentos + 1;
    const agotado = resultado.definitivo || intentos >= TOPE_INTENTOS;
    db.prepare(`
      UPDATE stocker_cola
      SET intentos = ?, ultimo_error = ?, estado = ?, proximo_en = ?
      WHERE id = ?`).run(
      intentos,
      resultado.motivo || 'sin respuesta',
      agotado ? 'error' : 'pendiente',
      agotado ? null : new Date(Date.now() + esperaDelIntento(intentos)).toISOString(),
      fila.id,
    );
    marcarPedido(fila.pedido_id, agotado ? 'error' : 'pendiente', resultado.motivo || null);
  }
  return { mandados, fallados, apagado: false };
}

/*
 * Vuelve a poner en la fila lo que no salió: lo que quedó en error y también lo
 * que está esperando su próximo intento.
 *
 * Quien aprieta "reintentar" quiere que salga ahora, no dentro de la media hora
 * que faltaba de la espera creciente. Por eso se adelanta el turno y se pone la
 * cuenta de intentos en cero.
 */
function reintentar(numero = null) {
  const ahora = new Date().toISOString();
  const r = numero
    ? db.prepare(`UPDATE stocker_cola SET estado = 'pendiente', intentos = 0, proximo_en = ?
                  WHERE estado IN ('error', 'pendiente') AND numero = ?`).run(ahora, numero)
    : db.prepare(`UPDATE stocker_cola SET estado = 'pendiente', intentos = 0, proximo_en = ?
                  WHERE estado IN ('error', 'pendiente')`).run(ahora);
  if (r.changes) {
    if (numero) {
      db.prepare(`UPDATE pedidos SET stocker_estado = 'pendiente', stocker_error = NULL WHERE numero = ?`).run(numero);
    } else {
      db.prepare(`UPDATE pedidos SET stocker_estado = 'pendiente', stocker_error = NULL
                  WHERE stocker_estado IN ('error', 'pendiente')`).run();
    }
  }
  return r.changes;
}

/** Cómo va la sincronización, para la pantalla de avisos del panel. */
function estadoPublico() {
  if (!configurado()) {
    return {
      configurado: false,
      falta: ['STOCKER_URL', 'STOCKER_TOKEN', 'STOCKER_NEGOCIO'].filter(
        (v) => !process.env[v],
      ),
    };
  }
  const por = db.prepare(`SELECT estado, COUNT(*) n FROM stocker_cola GROUP BY estado`).all();
  const cuenta = Object.fromEntries(por.map((f) => [f.estado, f.n]));
  const ultimoError = db.prepare(`
    SELECT numero, ultimo_error, intentos FROM stocker_cola
    WHERE estado = 'error' ORDER BY id DESC LIMIT 1`).get();
  return {
    configurado: true,
    destino: `${URL_BASE}${RUTA}`,
    negocio: NEGOCIO,
    pendientes: cuenta.pendiente || 0,
    enviados: cuenta.enviado || 0,
    conError: cuenta.error || 0,
    ultimoError: ultimoError || null,
  };
}

/** El repartidor: manda lo pendiente cada tanto, mientras el servidor viva. */
function arrancar() {
  if (!configurado()) return null;
  const vuelta = () => { procesarCola().catch(() => { /* al próximo ciclo */ }); };
  vuelta();
  const reloj = setInterval(vuelta, CADA);
  reloj.unref?.();
  return reloj;
}

module.exports = {
  configurado, anotar, procesarCola, reintentar, estadoPublico, arrancar,
  cuerpoDelPedido, lineasDelPedido, EVENTOS,
};
