const { db, leerConfig } = require('./db');

/*
 * Qué se mira en la tienda, y qué se hace con eso.
 *
 * El portal guardaba sólo pedidos confirmados. Con eso no se puede contestar
 * nada de lo que hace falta para acomodar un catálogo: qué se mira y no se
 * pide, qué se agrega al carrito y se abandona, qué categoría se recorre.
 * Acá se registran esos eventos y se los resume.
 *
 * QUÉ SE GUARDA Y QUÉ NO
 *
 * Se guarda el tipo de evento, el producto o la categoría, cuándo, y un
 * identificador al azar de la visita —vive en la pestaña y se borra al cerrar
 * el navegador—. Si quien mira ya inició sesión, queda también su ficha de
 * cliente; si no, queda anónimo. No se guarda la IP, ni el navegador, ni nada
 * que permita reconocer a quien no entró con su cuenta.
 *
 * Los eventos se borran a los seis meses: esto es para ver tendencias, no para
 * archivar el comportamiento de nadie.
 */

/*
 * Cada tipo, con cuánto pesa para ordenar el catálogo.
 *
 * Los pesos dicen qué tan cerca de comprar está cada gesto: ver la fila en la
 * pantalla es casi nada, abrir la ficha es interés, y agregar al carrito es lo
 * más parecido a una intención de compra que se puede medir sin el pedido.
 */
const TIPOS = {
  catalogo:  { peso: 0, porProducto: false },
  categoria: { peso: 0, porProducto: false },
  impresion: { peso: 1, porProducto: true },
  producto:  { peso: 4, porProducto: true },
  click:     { peso: 2, porProducto: true },
  carrito:   { peso: 8, porProducto: true },
  abandono:  { peso: 0, porProducto: true },
  pedido:    { peso: 0, porProducto: true },
};

const RETENCION_DIAS = 180;
/*
 * Una sola ventana para todo: lo que se miró y lo que se pidió en los últimos
 * 30 días. Con ventanas distintas —30 días de gestos y 90 de pedidos— el panel
 * mostraba 54 unidades al lado de un puntaje que venía de 870, y no había forma
 * de entender de dónde salía el número.
 */
const VENTANA_ORDEN = 30;
/*
 * Cuánto pesa lo pedido al lado de lo mirado.
 *
 * Las dos señales suman siempre, en vez de que una reemplace a la otra: un
 * interruptor entre "ordeno por vistas" y "ordeno por pedidos" necesita un
 * umbral inventado, y el día que lo cruza el catálogo se reordena de golpe.
 *
 * Lo que pesa es EN CUÁNTOS PEDIDOS apareció, no cuántas unidades sumó. Un
 * mayorista que se lleva novecientas unidades de un producto en un solo pedido
 * no lo vuelve el más buscado del catálogo, y contando unidades ese producto
 * quedaba clavado en el primer puesto un mes entero —2796 puntos contra 154 del
 * más mirado—, tapando lo que la gente estaba mirando de verdad. El tamaño
 * suma, pero amortiguado por la raíz: entre 100 y 900 unidades hay tres veces
 * de diferencia, no nueve.
 */
const PESO_PEDIDO = 10;
const PESO_TAMANO = 2;
const TOPE_LOTE = 50;
const TOPE_UNIDADES = 100_000;
const TOPE_VALOR = 1_000_000_000;

const haceDias = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const entero = (v, tope) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, tope) : null;
};

/*
 * El identificador de visita llega del navegador, así que se lo trata como a
 * cualquier cosa que llega de afuera: sólo letras y números, y corto.
 */
const visitaValida = (v) => typeof v === 'string' && /^[a-z0-9]{8,64}$/i.test(v);

const insertar = db.prepare(`
  INSERT INTO eventos (tipo, producto_id, categoria_id, visita, cliente_id, unidades, valor, creado_en)
  VALUES (@tipo, @productoId, @categoriaId, @visita, @clienteId, @unidades, @valor, @creadoEn)`);

const porSku = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?');
const categoriaExiste = db.prepare('SELECT id FROM categorias WHERE id = ?');

/**
 * Registra un lote de eventos. Lo que no se entiende se descarta en silencio:
 * un evento perdido no vale una pantalla de error en la tienda.
 */
function registrar({ visita, eventos } = {}, { clienteId = null } = {}) {
  if (!visitaValida(visita) || !Array.isArray(eventos) || !eventos.length) return 0;
  const creadoEn = new Date().toISOString();
  const filas = [];

  for (const e of eventos.slice(0, TOPE_LOTE)) {
    const tipo = TIPOS[e?.tipo] ? e.tipo : null;
    if (!tipo) continue;
    let productoId = null;
    if (e.sku) productoId = porSku.get(String(e.sku))?.id ?? null;
    if (TIPOS[tipo].porProducto && !productoId) continue;
    let categoriaId = entero(e.categoria, 1e9);
    if (categoriaId && !categoriaExiste.get(categoriaId)) categoriaId = null;
    filas.push({
      tipo,
      productoId,
      categoriaId,
      visita,
      clienteId: clienteId || null,
      unidades: entero(e.unidades, TOPE_UNIDADES),
      valor: entero(e.valor, TOPE_VALOR),
      creadoEn,
    });
  }
  if (!filas.length) return 0;
  db.transaction((lote) => { for (const f of lote) insertar.run(f); })(filas);
  if (filas.some((f) => TIPOS[f.tipo].peso > 0)) sucio = true;
  return filas.length;
}

/** Los eventos viejos se van solos. */
function podar() {
  const { changes } = db.prepare('DELETE FROM eventos WHERE creado_en < ?').run(haceDias(RETENCION_DIAS));
  return changes;
}

// ── Lo que ordena el catálogo ─────────────────────────────────────
/*
 * El puntaje se recalcula como mucho una vez por minuto.
 *
 * El catálogo entero se pide en cada visita; con la cuenta hecha en cada
 * pedido, cada visita pagaría un recorrido de la tabla de eventos para
 * devolver siempre lo mismo.
 */
let cache = { hasta: 0, calculado: 0, mapa: new Map(), fuente: 'sin datos' };
let sucio = false;   // llegaron eventos que la cuenta todavía no vio

/*
 * Un evento nuevo invalida la cuenta, pero no más de una vez cada cinco
 * segundos: así el orden reacciona enseguida sin que una ráfaga de visitas
 * obligue a recalcular en cada una.
 */
const REFRESCO_MINIMO = 5_000;

function contarPorProducto(desde) {
  const filas = db.prepare(`
    SELECT producto_id AS id, tipo, COUNT(*) AS n
    FROM eventos
    WHERE creado_en >= ? AND producto_id IS NOT NULL
    GROUP BY producto_id, tipo`).all(desde);
  const mapa = new Map();
  for (const f of filas) {
    const p = mapa.get(f.id) || { impresiones: 0, vistas: 0, clicks: 0, carritos: 0, abandonos: 0, pedidos: 0, puntaje: 0 };
    if (f.tipo === 'impresion') p.impresiones = f.n;
    if (f.tipo === 'producto') p.vistas = f.n;
    if (f.tipo === 'click') p.clicks = f.n;
    if (f.tipo === 'carrito') p.carritos = f.n;
    if (f.tipo === 'abandono') p.abandonos = f.n;
    if (f.tipo === 'pedido') p.pedidos = f.n;
    p.puntaje += (TIPOS[f.tipo]?.peso || 0) * f.n;
    mapa.set(f.id, p);
  }
  return mapa;
}

/*
 * Cuántas unidades se pidieron de cada producto.
 *
 * Es la señal de respaldo mientras no haya eventos suficientes: un pedido
 * confirmado dice más que cualquier vista, lo que pasa es que llega tarde y de
 * pocos. Los ítems del pedido viven como JSON, así que se leen en memoria: son
 * decenas de pedidos por mes, no millones.
 */
function demandaDePedidos(dias = VENTANA_ORDEN) {
  const filas = db.prepare(`
    SELECT items FROM pedidos
    WHERE creado_en >= ? AND estado <> 'cancelado'`).all(haceDias(dias));
  const porSkuAgrupador = new Map();
  for (const f of filas) {
    let items = [];
    try { items = JSON.parse(f.items) || []; } catch { continue; }
    for (const it of items) {
      const sku = it?.skuAgrupador || it?.sku;
      if (!sku) continue;
      const previo = porSkuAgrupador.get(sku) || { unidades: 0, pedidos: 0 };
      previo.unidades += Number(it.unidades) || 0;
      previo.pedidos += 1;
      porSkuAgrupador.set(sku, previo);
    }
  }
  const mapa = new Map();
  for (const [sku, datos] of porSkuAgrupador) {
    const id = porSku.get(sku)?.id;
    if (id) mapa.set(id, datos);
  }
  return mapa;
}

/**
 * Con qué ordenar el catálogo: producto → puntaje y de dónde salió.
 *
 * Mientras no haya eventos suficientes usa la demanda de los pedidos, así el
 * orden es real desde el primer día en vez de esperar semanas.
 */
function popularidad() {
  const ahora = Date.now();
  // Vale la cuenta guardada mientras no haya vencido y no hayan llegado eventos
  // nuevos desde hace más de unos segundos.
  const sirve = ahora < cache.hasta && !(sucio && ahora - cache.calculado > REFRESCO_MINIMO);
  if (sirve) return cache;

  const eventos = contarPorProducto(haceDias(VENTANA_ORDEN));
  const total = [...eventos.values()].reduce((t, p) => t + p.impresiones + p.vistas + p.clicks + p.carritos, 0);
  const demanda = demandaDePedidos();

  const mapa = new Map();
  for (const [id, p] of eventos) mapa.set(id, { ...p, unidades: 0, puntajeFinal: p.puntaje });
  for (const [id, d] of demanda) {
    const p = mapa.get(id) || { impresiones: 0, vistas: 0, clicks: 0, carritos: 0, abandonos: 0, pedidos: 0, puntaje: 0, puntajeFinal: 0 };
    p.unidades = d.unidades;
    p.vecesPedido = d.pedidos;
    mapa.set(id, p);
  }
  for (const p of mapa.values()) {
    p.puntajeFinal = p.puntaje
      + (p.vecesPedido || 0) * PESO_PEDIDO
      + Math.sqrt(p.unidades || 0) * PESO_TAMANO;
  }
  // La fuente es sólo para contarlo en el panel: el orden siempre suma las dos.
  const fuente = total ? 'eventos' : (demanda.size ? 'pedidos' : 'sin datos');

  sucio = false;
  cache = { hasta: ahora + 60_000, calculado: ahora, mapa, fuente };
  return cache;
}

/** Para las pruebas y para después de importar: la próxima cuenta se hace de nuevo. */
function olvidarPopularidad() {
  cache = { hasta: 0, calculado: 0, mapa: new Map(), fuente: 'sin datos' };
  sucio = false;
}

// ── El reporte del panel ──────────────────────────────────────────
function reporte({ dias = 30 } = {}) {
  const desde = haceDias(dias);
  const una = (sql, ...args) => db.prepare(sql).get(desde, ...args) || {};

  const visitas = una(`
    SELECT COUNT(DISTINCT visita) AS total,
           COUNT(DISTINCT CASE WHEN cliente_id IS NOT NULL THEN visita END) AS conCuenta,
           COUNT(DISTINCT CASE WHEN tipo = 'carrito'  THEN visita END) AS conCarrito,
           COUNT(DISTINCT CASE WHEN tipo = 'pedido'   THEN visita END) AS conPedido,
           COUNT(DISTINCT CASE WHEN tipo = 'abandono' THEN visita END) AS conAbandono
    FROM eventos WHERE creado_en >= ?`);

  const totales = una(`
    SELECT
      SUM(tipo = 'catalogo')  AS catalogo,
      SUM(tipo = 'categoria') AS categoria,
      SUM(tipo = 'impresion') AS impresiones,
      SUM(tipo = 'producto')  AS vistas,
      SUM(tipo = 'click')     AS clicks,
      SUM(tipo = 'carrito')   AS carritos
    FROM eventos WHERE creado_en >= ?`);

  const porCategoria = db.prepare(`
    SELECT c.id, c.nombre,
           SUM(e.tipo = 'categoria') AS aperturas,
           SUM(e.tipo = 'impresion') AS impresiones,
           SUM(e.tipo = 'producto')  AS vistas,
           SUM(e.tipo = 'click')     AS clicks
    FROM categorias c
    LEFT JOIN productos p ON p.categoria_id = c.id
    LEFT JOIN eventos e ON (e.categoria_id = c.id OR e.producto_id = p.id) AND e.creado_en >= ?
    GROUP BY c.id
    ORDER BY vistas DESC, c.nombre`).all(desde);

  const productos = db.prepare(`
    SELECT p.id, p.sku_agrupador AS sku, p.titulo, c.nombre AS categoria, p.precio,
           p.creado_en AS alta, p.novedad,
           SUM(e.tipo = 'impresion') AS impresiones,
           SUM(e.tipo = 'producto')  AS vistas,
           SUM(e.tipo = 'click')     AS clicks,
           SUM(e.tipo = 'carrito')   AS carritos,
           COUNT(DISTINCT CASE WHEN e.tipo = 'producto' THEN e.visita END) AS visitasQueLoVieron
    FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN eventos e ON e.producto_id = p.id AND e.creado_en >= ?
    WHERE p.visible = 1
    GROUP BY p.id
    ORDER BY vistas DESC, impresiones DESC, p.titulo`).all(desde);

  /*
   * De cada visita vale SÓLO el último aviso de abandono.
   *
   * El aviso se manda cada vez que la pestaña se oculta, porque no hay forma de
   * saber cuál va a ser la última: alguien que mira el catálogo, se va a otra
   * app y vuelve manda varios. Contándolos todos, un carrito de medio millón se
   * informaba como millón y medio, y el producto que estuvo desde el principio
   * aparecía abandonado tres veces. El último aviso es el carrito con el que
   * esa persona finalmente se fue.
   */
  const ULTIMO_ABANDONO = `
    SELECT e.* FROM eventos e
    JOIN (SELECT visita, MAX(creado_en) AS cuando FROM eventos
          WHERE tipo = 'abandono' AND creado_en >= ? GROUP BY visita) u
      ON u.visita = e.visita AND u.cuando = e.creado_en
    WHERE e.tipo = 'abandono' AND e.creado_en >= ?`;

  const abandono = db.prepare(`
    SELECT COUNT(DISTINCT visita) AS carritos,
           COALESCE(SUM(valor), 0) AS valorTotal,
           COALESCE(SUM(unidades), 0) AS unidades,
           COUNT(DISTINCT producto_id) AS productosAfectados
    FROM (${ULTIMO_ABANDONO})`).get(desde, desde) || {};
  abandono.valorPromedio = abandono.carritos ? Math.round(abandono.valorTotal / abandono.carritos) : 0;

  const abandonoPorProducto = new Map(db.prepare(`
    SELECT producto_id AS id, COUNT(*) AS veces,
           COALESCE(SUM(valor), 0) AS valor, COALESCE(SUM(unidades), 0) AS unidades
    FROM (${ULTIMO_ABANDONO}) GROUP BY producto_id`).all(desde, desde).map((f) => [f.id, f]));

  const demanda = demandaDePedidos(dias);
  const porId = db.prepare('SELECT id, sku_agrupador AS sku FROM productos').all();
  const skuPorId = new Map(porId.map((p) => [p.id, p.sku]));
  const unidadesPorSku = new Map([...demanda].map(([id, d]) => [skuPorId.get(id), d.unidades]));
  /*
   * El ranking sale con el MISMO puntaje que ordena la tienda.
   *
   * Ordenarlo sólo por vistas dejaba al panel diciendo "este es el orden del
   * catálogo" mientras mostraba otro: un producto muy pedido y poco mirado
   * salía primero en la tienda y séptimo en la tabla.
   */
  const { mapa: puntajes } = popularidad();
  for (const p of productos) {
    const ab = abandonoPorProducto.get(p.id);
    p.abandonos = ab?.veces || 0;
    p.valorAbandonado = ab?.valor || 0;
    p.puntaje = Math.round(puntajes.get(p.id)?.puntajeFinal || 0);
    delete p.id;
    p.unidadesPedidas = unidadesPorSku.get(p.sku) || 0;
    p.tasaClick = p.impresiones ? Math.round((p.clicks / p.impresiones) * 1000) / 10 : null;
    p.tasaCarrito = p.vistas ? Math.round((p.carritos / p.vistas) * 1000) / 10 : null;
  }

  productos.sort((a, b) => b.puntaje - a.puntaje || b.vistas - a.vistas || b.impresiones - a.impresiones);

  const { fuente } = popularidad();
  return {
    periodo: { dias, desde, hasta: new Date().toISOString() },
    fuenteDelOrden: fuente,
    altasDesde: leerConfig('altas_desde'),
    visitas,
    totales,
    porCategoria,
    productos,
    abandono,
    conversion: {
      visitas: visitas.total || 0,
      conCarrito: visitas.conCarrito || 0,
      conPedido: visitas.conPedido || 0,
      tasaCarrito: visitas.total ? Math.round((visitas.conCarrito / visitas.total) * 1000) / 10 : null,
      tasaPedido: visitas.total ? Math.round((visitas.conPedido / visitas.total) * 1000) / 10 : null,
    },
  };
}

/** Los productos dados de alta en la plataforma en los últimos N días. */
function nuevos(dias = 30) {
  return db.prepare(`
    SELECT p.sku_agrupador AS sku, p.titulo, p.creado_en AS alta, p.novedad, c.nombre AS categoria
    FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.visible = 1 AND p.creado_en IS NOT NULL AND p.creado_en >= ?
    ORDER BY p.creado_en DESC, p.titulo`).all(haceDias(dias));
}

module.exports = {
  registrar, podar, popularidad, olvidarPopularidad, demandaDePedidos, reporte, nuevos,
  TIPOS, VENTANA_ORDEN, RETENCION_DIAS, PESO_PEDIDO, PESO_TAMANO, visitaValida,
};
