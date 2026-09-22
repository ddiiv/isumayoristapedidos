const {
  db, leerConfig, guardarConfig, normalizarEstado, puedePasar, registrarEstado,
} = require('./db');

/*
 * Lo que ISUWAYA le cuenta a STOCKER.
 *
 * STOCKER es el sistema de stock y ventas del negocio; ISUWAYA es el catálogo
 * mayorista donde el cliente arma el pedido:
 *
 *   1. El cliente confirma el pedido acá  → allá se abre una SOLICITUD
 *      mayorista "por revisar". No toca inventario ni numera nada.
 *   2. Se coordina con el cliente, se confirma el stock y se elige cómo pagó:
 *      cada envío reemplaza al anterior mientras la solicitud siga pendiente.
 *   3. Alguien la ACEPTA en STOCKER  → ahí nace la venta, con su cliente y su
 *      forma de pago, y ahí se resuelve el stock. Un pedido mayorista se
 *      produce contra el pedido, así que quien aprueba mira la percha.
 *
 * Lo que decide es el estado de la solicitud allá, no el evento que mandamos:
 * acá se informa lo que pasó y del otro lado una persona resuelve.
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
const RUTA_RESOLUCIONES = process.env.STOCKER_RUTA_RESOLUCIONES
  || `${RUTA.replace(/\/pedidos$/, '')}/pedidos/resoluciones`;
const RUTA_PRECIOS = process.env.STOCKER_RUTA_PRECIOS
  || `${RUTA.replace(/\/pedidos$/, '')}/precios`;
// Los precios cambian por día, no por minuto.
const CADA_PRECIOS = Number(process.env.STOCKER_PRECIOS_CADA_MS) || 15 * 60_000;
let ultimoErrorVuelta = null;
let ultimoErrorPrecios = null;
const ESPERA_ENVIO = Number(process.env.STOCKER_TIMEOUT_MS) || 15_000;
const CADA = Number(process.env.STOCKER_CADA_MS) || 20_000;
const TOPE_INTENTOS = 12;      // con la espera creciente, son casi dos días de reintentos
const TOPE_POR_VUELTA = 20;

/*
 * Con la dirección y el token alcanza: STOCKER saca de su token a qué negocio
 * entra el pedido. `STOCKER_NEGOCIO` viaja como referencia y allá se ignora —si
 * el negocio viniera de afuera, una credencial cualquiera podría escribirle
 * ventas a otro cliente de STOCKER—.
 */
const configurado = () => Boolean(URL_BASE && TOKEN);

const EVENTOS = ['alta', 'confirmado', 'modificado', 'enviado', 'entregado', 'cancelado'];

/*
 * Ningún error que se guarde o se muestre lleva la dirección de STOCKER.
 *
 * Los errores de red la traen adentro —"ENOTFOUND backend.railway.internal",
 * "request to https://… failed"— y de ahí pasan al panel, que se mira desde
 * cualquier lado y termina en capturas de pantalla. El backend de STOCKER no
 * tiene dominio público justamente para que nadie sepa dónde golpear: no vamos
 * a publicarlo nosotros en un mensaje de error.
 */
function sinDireccion(texto) {
  let limpio = String(texto ?? '');
  limpio = limpio.replace(/https?:\/\/[^\s"']+/gi, 'STOCKER');
  if (URL_BASE) {
    let host = URL_BASE;
    try { host = new URL(URL_BASE).hostname; } catch { /* se usa tal cual */ }
    if (host) limpio = limpio.split(host).join('STOCKER');
  }
  return limpio.slice(0, 200);
}

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
  return { ok: false, definitivo, motivo: sinDireccion(`${r.status} ${texto}`) };
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
      resultado = { ok: false, motivo: sinDireccion(e?.message || e) };
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
      falta: ['STOCKER_URL', 'STOCKER_TOKEN'].filter((v) => !process.env[v]),
    };
  }
  const por = db.prepare(`SELECT estado, COUNT(*) n FROM stocker_cola GROUP BY estado`).all();
  const cuenta = Object.fromEntries(por.map((f) => [f.estado, f.n]));
  const ultimoError = db.prepare(`
    SELECT numero, ultimo_error, intentos FROM stocker_cola
    WHERE estado = 'error' ORDER BY id DESC LIMIT 1`).get();
  /*
   * A propósito NO salen la dirección de STOCKER ni el número de negocio.
   *
   * El panel se abre desde cualquier computadora y termina en capturas de
   * pantalla; esos dos datos son el mapa para golpearle la puerta a un backend
   * que justamente no tiene dominio público. Para saber a dónde apunta, están
   * las variables del servidor, que las ve quien administra el deploy.
   */
  return {
    configurado: true,
    pendientes: cuenta.pendiente || 0,
    enviados: cuenta.enviado || 0,
    conError: cuenta.error || 0,
    ultimoError: ultimoError
      ? { ...ultimoError, ultimo_error: sinDireccion(ultimoError.ultimo_error) }
      : null,
    /*
     * El 404 es el error más probable al configurar esto, y el motivo es casi
     * siempre el mismo: la ruta de STOCKER cuelga de /api y la dirección no lo
     * incluye. Decirlo acá ahorra la media hora de mirar logs, sin revelar a
     * dónde se manda.
     */
    pista: /^404/.test(String(ultimoError?.ultimo_error || ''))
      ? 'STOCKER contesta que esa ruta no existe. Con la ruta por omisión, la dirección configurada tiene que terminar en /api.'
      : null,
    /*
     * La vuelta también puede fallar, y su silencio es peor que el de la ida:
     * los pedidos salen igual, pero nadie se entera de que STOCKER los aceptó
     * o los rechazó, y el cliente queda esperando una respuesta que ya existe.
     * Va con la dirección tapada, como todo lo demás de acá.
     */
    vuelta: ultimoErrorVuelta ? sinDireccion(ultimoErrorVuelta) : null,
    precios: ultimoErrorPrecios ? sinDireccion(ultimoErrorPrecios) : null,
  };
}

/** El repartidor: manda lo pendiente cada tanto, mientras el servidor viva. */
/*
 * ══ La vuelta: qué hizo STOCKER con cada pedido ══════════════════
 *
 * Se pregunta en vez de esperar que STOCKER avise. Preguntando, una caída de
 * este lado no pierde nada: cuando vuelve, pregunta desde donde quedó. Que nos
 * avisen exigiría una URL pública acá, un secreto más, y una cola de reintentos
 * del otro lado para lo que no se pudo entregar.
 *
 * El cursor es la fecha de revisión de la última resolución aplicada, y lo
 * devuelve STOCKER: tomarlo del reloj de acá se saltearía las que se revisaron
 * entre la consulta y la respuesta.
 */
const CLAVE_CURSOR = 'stocker_resoluciones_desde';

/* Qué se hace acá con lo que decidió STOCKER. */
const DESTINO = { aceptada: 'confirmado', rechazada: 'cancelado' };

function notaDeLaResolucion(r) {
  if (r.estado === 'rechazada') {
    return r.motivo ? `No podemos hacer este pedido: ${r.motivo}` : 'No podemos hacer este pedido.';
  }
  const venta = r.venta?.numero ? ` (venta ${r.venta.numero})` : '';
  return r.venta?.condicionPago === 'cuenta_corriente'
    ? `Confirmado${venta}. Queda en tu cuenta corriente.`
    : `Confirmado${venta}.`;
}

/**
 * Aplica una resolución a su pedido. Devuelve qué se hizo, para el log.
 *
 * La misma resolución vuelve en cada vuelta hasta que el cursor avanza, así
 * que hay tres cosas que la frenan y conviene saber qué hace cada una:
 *
 *   · `stocker_resuelto_en` — corta al principio y deja el dato cierto: "esto
 *     ya se aplicó". Hoy no es lo único que evita reaplicarla, porque los
 *     estados de acá son de ida; es lo que la va a seguir evitando el día que
 *     alguien agregue una vuelta atrás.
 *   · `AUTOMATICO_DESDE` — nada automático toca un pedido que ya salió.
 *   · `puedePasar` — la tabla de estados del sistema, que manda siempre.
 */
function aplicarResolucion(r) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(r.pedidoExterno);
  if (!pedido) return 'no existe acá';
  if (pedido.stocker_resuelto_en) return 'ya aplicada';

  const destino = DESTINO[r.estado];
  if (!destino) return 'no se entiende';

  const actual = normalizarEstado(pedido.estado);
  db.prepare('UPDATE pedidos SET stocker_venta = ?, stocker_resuelto_en = ? WHERE id = ?')
    .run(r.venta?.numero || null, new Date().toISOString(), pedido.id);

  if (actual === destino) return 'ya estaba';
  /*
   * Lo automático llega hasta acá y no más.
   *
   * Las transiciones del panel son más anchas a propósito: una persona SÍ puede
   * cancelar un pedido ya enviado —pasa, y hay que poder registrarlo—. Pero que
   * eso lo haga solo una resolución que llegó tarde significa cancelar
   * mercadería que está en el camión, sin que nadie lo haya decidido.
   *
   * Mientras el pedido no salió, aplicar la decisión de STOCKER es exactamente
   * lo que se espera. Una vez que salió, queda anotada y la mira una persona.
   */
  const AUTOMATICO_DESDE = ['pendiente', 'confirmado', 'modificado'];
  if (!AUTOMATICO_DESDE.includes(actual)) return `el pedido ya está ${actual}`;
  if (!puedePasar(actual, destino)) return `no se puede pasar de ${actual} a ${destino}`;

  registrarEstado(pedido.id, destino, { nota: notaDeLaResolucion(r) });
  return destino;
}

/** Trae lo resuelto desde el último cursor y lo aplica. */
async function traerResoluciones() {
  if (!configurado()) return { aplicadas: 0, apagado: true };
  const desde = leerConfig(CLAVE_CURSOR);
  const url = `${URL_BASE}${RUTA_RESOLUCIONES}${desde ? `?desde=${encodeURIComponent(desde)}` : ''}`;

  let datos;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(ESPERA_ENVIO),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    datos = await r.json();
    ultimoErrorVuelta = null;
  } catch (e) {
    /*
     * El error se anota acá y no en quien llama: si dependiera del reloj, una
     * llamada a mano dejaría el panel diciendo que todo anda.
     */
    ultimoErrorVuelta = String(e.message || e).slice(0, 200);
    throw e;
  }

  const hechas = [];
  for (const resolucion of datos.resoluciones || []) {
    try {
      const resultado = aplicarResolucion(resolucion);
      hechas.push({ pedido: resolucion.pedidoExterno, resultado });
      /*
       * Al cliente se le avisa igual que cuando el cambio lo hace el panel: es
       * la misma noticia —su pedido se confirmó o no va— y no tiene por qué
       * llegarle distinto según quién la haya decidido.
       *
       * Un aviso que falla no puede voltear la vuelta: el estado ya cambió y
       * volver a traer la resolución no lo arreglaría.
       */
      if (resultado === 'confirmado' || resultado === 'cancelado') {
        const { leerPedido } = require('./pedidos');
        const { avisarCliente } = require('./notificaciones');
        await avisarCliente(leerPedido(resolucion.pedidoExterno), resultado, {
          nota: notaDeLaResolucion(resolucion),
        }).catch(() => {});
      }
    } catch (e) { hechas.push({ pedido: resolucion.pedidoExterno, resultado: `error: ${e.message}` }); }
  }
  /*
   * El cursor avanza aunque alguna no se haya podido aplicar: quedó anotada en
   * el pedido y volver a traerla en cada vuelta no la va a arreglar. Si no
   * avanzara, una sola resolución rara dejaría la vuelta trabada para siempre.
   */
  if (datos.hasta) guardarConfig(CLAVE_CURSOR, datos.hasta);
  return { aplicadas: hechas.length, hechas, truncado: Boolean(datos.truncado) };
}

/*
 * ══ Los precios: una sola lista ══════════════════════════════════
 *
 * El catálogo de acá salió de una planilla exportada de STOCKER, y desde ese
 * día los precios viven por separado: se cambia allá y acá se sigue mostrando
 * el de la exportación. El cliente arma el pedido con ese número y la venta se
 * registra con otro.
 *
 * Se traen por SKU de variante. Lo que no está en el catálogo de acá se
 * ignora: STOCKER tiene más artículos de los que el portal publica.
 */
const CLAVE_PRECIOS = 'stocker_precios_desde';

async function sincronizarPrecios({ completo = false } = {}) {
  if (!configurado()) return { actualizados: 0, apagado: true };
  const desde = completo ? null : leerConfig(CLAVE_PRECIOS);
  const url = `${URL_BASE}${RUTA_PRECIOS}${desde ? `?desde=${encodeURIComponent(desde)}` : ''}`;

  let datos;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(ESPERA_ENVIO),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    datos = await r.json();
    ultimoErrorPrecios = null;
  } catch (e) {
    ultimoErrorPrecios = String(e.message || e).slice(0, 200);
    throw e;
  }

  const buscar = db.prepare('SELECT id, producto_id, precio FROM variantes WHERE sku = ?');
  const guardar = db.prepare('UPDATE variantes SET precio = ? WHERE id = ?');
  let actualizados = 0;
  let sinCatalogo = 0;

  const aplicar = db.transaction((filas) => {
    for (const fila of filas) {
      const precio = Number(fila.precio);
      if (!Number.isFinite(precio) || precio < 0) continue;
      const variante = buscar.get(String(fila.sku));
      if (!variante) { sinCatalogo += 1; continue; }
      /*
       * El precio se guarda en la VARIANTE, aunque en STOCKER lo herede del
       * producto. Acá no se sabe qué heredó de qué, y escribirlo en el padre
       * pisaría el precio de las variantes que sí tienen el suyo.
       */
      if (Number(variante.precio) === precio) continue;
      guardar.run(precio, variante.id);
      actualizados += 1;
    }
  });
  aplicar(datos.precios || []);

  if (datos.generadoEn && !datos.truncado) guardarConfig(CLAVE_PRECIOS, datos.generadoEn);
  return {
    actualizados,
    sinCatalogo,
    recibidos: (datos.precios || []).length,
    truncado: Boolean(datos.truncado),
  };
}

function arrancar() {
  if (!configurado()) return null;
  const vuelta = () => {
    procesarCola().catch(() => { /* al próximo ciclo */ });
    traerResoluciones().catch(() => { /* queda anotado adentro */ });
  };
  vuelta();
  const reloj = setInterval(vuelta, CADA);
  reloj.unref?.();

  /*
   * Los precios van en su propio reloj y mucho más lento: cambian por día, no
   * por minuto, y traerlos cada veinte segundos sería pedirle a STOCKER el
   * catálogo entero cuatro mil veces por día para que casi siempre no haya
   * nada nuevo.
   */
  const relojPrecios = setInterval(() => {
    sincronizarPrecios().catch(() => { /* queda anotado adentro */ });
  }, CADA_PRECIOS);
  relojPrecios.unref?.();
  return reloj;
}

module.exports = {
  configurado, anotar, procesarCola, reintentar, estadoPublico, arrancar,
  traerResoluciones, sincronizarPrecios, aplicarResolucion,
  cuerpoDelPedido, lineasDelPedido, sinDireccion, EVENTOS,
  erroresDeLaVuelta: () => ({ resoluciones: ultimoErrorVuelta, precios: ultimoErrorPrecios }),
};
