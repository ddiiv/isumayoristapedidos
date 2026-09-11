const express = require('express');
const { db } = require('../db');
const { validarCliente, armarPedido, guardarPedido, leerPedido } = require('../pedidos');
const { pdfPedido, pdfRotulo } = require('../pdf');
const { avisarPedido } = require('../notificaciones');
const auth = require('../auth');

const r = express.Router();

/*
 * Un techo por IP para lo que cuesta caro y no pide cuenta.
 *
 * Confirmar un pedido es anónimo a propósito —no se le pide cuenta a nadie
 * para comprar—, pero cada llamada guarda una fila, arma dos PDF y le manda un
 * mail y un WhatsApp al dueño. Con CUIT válido, que es fácil de generar, un
 * script le llena la casilla y el WhatsApp (que además tiene tope y costo por
 * número en Meta) y engorda la base sin freno.
 *
 * No pretende ser un limitador serio —para eso hay que guardar estado afuera—,
 * pero corta el caso que importa. Los números son holgados: una persona
 * confirmando un pedido nunca los toca.
 */
function limitador(porMinuto) {
  const visto = new Map();
  return (req) => {
    const ip = req.ip || 'sin-ip';
    const ahora = Date.now();
    // La lista se limpia sola: sin esto, cada IP que alguna vez pasó queda
    // guardada para siempre y el proceso crece sin techo.
    if (visto.size > 5000) visto.clear();

    const ventana = visto.get(ip);
    if (!ventana || ahora - ventana.desde > 60_000) {
      visto.set(ip, { desde: ahora, cuantos: 1 });
      return false;
    }
    ventana.cuantos += 1;
    return ventana.cuantos > porMinuto;
  };
}

const demasiadosPedidos = limitador(10);
const demasiadosPapeles = limitador(60);

const frenar = (mirar) => (req, res, next) => (mirar(req)
  ? res.status(429).json({ message: 'Estás yendo muy rápido. Esperá un momento y probá de nuevo.' })
  : next());

/*
 * GET /api/catalogo
 *
 * Todo el catálogo en un solo pedido.
 *
 * Un endpoint por categoría obligaría a una vuelta al servidor por cada
 * pestaña que toca el cliente. El catálogo de un mayorista son cientos de
 * variantes, no cientos de miles: entra en una respuesta y deja la navegación
 * instantánea, que es lo que hace que alguien recorra el catálogo entero.
 */
r.get('/catalogo', (req, res) => {
  const categorias = db.prepare(`
    SELECT id, nombre FROM categorias WHERE visible = 1 ORDER BY orden, nombre`).all();

  const productos = db.prepare(`
    SELECT p.id, p.sku_agrupador, p.titulo, p.precio, p.foto, p.modelo, p.genero,
           p.categoria_id, p.guia_talles, p.descripcion
    FROM productos p
    WHERE p.visible = 1
    ORDER BY p.orden, p.titulo`).all();

  /*
   * Las variantes salen con el color y el talle YA canónicos.
   *
   * El texto crudo de la planilla trae el mismo color escrito de cuatro formas.
   * Resolverlo acá y no en el navegador evita que la pantalla tenga que saber
   * que "Negra" y "Nero" son el mismo cuadrito — y que se olvide de saberlo la
   * próxima vez que alguien toque el catálogo.
   */
  const variantes = db.prepare(`
    SELECT v.producto_id, v.sku, v.precio,
           COALESCE(c.nombre, v.color) AS color,
           COALESCE(c.hex, '#cccccc')  AS hex,
           COALESCE(t.nombre, v.talle) AS talle,
           COALESCE(t.orden, v.orden_talle) AS orden_talle,
           COALESCE(t.grupo, 'adulto') AS grupo_talle,
           COALESCE(c.orden, 0) AS orden_color
    FROM variantes v
    JOIN productos p ON p.id = v.producto_id
    LEFT JOIN colores c ON c.id = v.color_id
    LEFT JOIN talles  t ON t.id = v.talle_id
    WHERE p.visible = 1
    ORDER BY orden_color, color, orden_talle`).all();

  const fotos = db.prepare('SELECT producto_id, color, ruta FROM fotos_color').all();

  const porProducto = new Map(productos.map((p) => [p.id, []]));
  for (const v of variantes) porProducto.get(v.producto_id)?.push(v);
  const fotosPorProducto = new Map();
  for (const f of fotos) {
    if (!fotosPorProducto.has(f.producto_id)) fotosPorProducto.set(f.producto_id, {});
    fotosPorProducto.get(f.producto_id)[f.color] = f.ruta;
  }

  const salida = productos.map((p) => {
    const vs = porProducto.get(p.id) || [];
    // Con su hex, para pintar el cuadrito sin una segunda consulta.
    const colores = [...new Map(vs.map((v) => [v.color, v.hex])).entries()]
      .map(([nombre, hex]) => ({ nombre, hex }));
    const talles = [...new Map(vs.map((v) => [v.talle, v.orden_talle])).entries()]
      .sort((a, b) => a[1] - b[1]).map(([t]) => t);
    const grupos = [...new Set(vs.map((v) => v.grupo_talle))];
    return {
      grupoTalle: grupos.includes('nino') && grupos.includes('adulto') ? 'mixto' : (grupos[0] || 'adulto'),
      guiaTalles: p.guia_talles ? JSON.parse(p.guia_talles) : null,
      descripcion: p.descripcion || null,
      sku: p.sku_agrupador,
      titulo: p.titulo,
      categoriaId: p.categoria_id,
      precio: p.precio,
      modelo: p.modelo,
      genero: p.genero,
      foto: p.foto,
      fotosPorColor: fotosPorProducto.get(p.id) || {},
      colores,
      talles,
      // La grilla completa: con qué SKU se pide cada cruce de color y talle.
      // Que lo resuelva el servidor evita que el navegador tenga que adivinar
      // qué combinaciones existen de verdad — no todas las existen.
      combinaciones: vs.map((v) => ({
        sku: v.sku, color: v.color, hex: v.hex, talle: v.talle, precio: v.precio ?? p.precio,
      })),
      // Una curva es una unidad de CADA combinación que existe.
      unidadesPorCurva: vs.length,
      precioPorCurva: vs.reduce((t, v) => t + (v.precio ?? p.precio), 0),
    };
  }).filter((p) => p.combinaciones.length > 0);

  res.json({ categorias, productos: salida });
});

// POST /api/pedidos/previsualizar — valoriza sin guardar nada.
r.post('/pedidos/previsualizar', frenar(demasiadosPapeles), (req, res) => {
  const { cliente, errores: erroresCliente } = validarCliente(req.body?.cliente);
  const { items, total, unidades, errores } = armarPedido(req.body?.carrito);

  if (!items.length) {
    return res.status(400).json({ message: 'El pedido está vacío.', errores, erroresCliente });
  }
  res.json({ cliente, items, total, unidades, errores, erroresCliente });
});

/*
 * POST /api/pedidos/pdf — el remito preliminar, antes de confirmar.
 *
 * Se genera con el mismo código que el definitivo. Con una vista previa hecha
 * aparte, el papel que el cliente descarga y el que llega al depósito pueden
 * decir cosas distintas, y nadie lo nota hasta que hay un reclamo.
 */
r.post('/pedidos/pdf', frenar(demasiadosPapeles), async (req, res, next) => {
  try {
    const { cliente } = validarCliente(req.body?.cliente);
    const { items, total, unidades } = armarPedido(req.body?.carrito);
    if (!items.length) return res.status(400).json({ message: 'El pedido está vacío.' });

    const pdf = await pdfPedido({
      numero: 'PRELIMINAR', creado_en: new Date().toISOString(), cliente, items, total, unidades,
    });
    res.type('application/pdf')
      .setHeader('Content-Disposition', 'attachment; filename="pedido-preliminar.pdf"');
    res.send(pdf);
  } catch (e) { next(e); }
});

// POST /api/pedidos — confirma, guarda y avisa.
r.post('/pedidos', frenar(demasiadosPedidos), async (req, res, next) => {
  try {
    const { cliente, errores: erroresCliente } = validarCliente(req.body?.cliente);
    if (Object.keys(erroresCliente).length) {
      return res.status(400).json({ message: 'Faltan datos para el envío.', erroresCliente });
    }

    const { items, total, unidades, errores } = armarPedido(req.body?.carrito);
    if (!items.length) return res.status(400).json({ message: 'El pedido está vacío.', errores });

    const pedido = guardarPedido({ cliente, items, total, unidades });

    /*
     * Si venía con la sesión abierta, el pedido queda atado a esa cuenta.
     *
     * Se guarda igual el cliente que vino en el formulario y no el de la
     * cuenta: son los datos de ESTE envío, que puede ir a otra dirección. La
     * cuenta dice quién lo pidió; el formulario, a dónde va.
     */
    if (req.sesion?.rol === 'cliente') {
      db.prepare('UPDATE pedidos SET cliente_id = ? WHERE id = ?')
        .run(req.sesion.cliente.id, pedido.id);
    }

    /*
     * El pedido ya está guardado antes de avisar.
     *
     * Si el mail o el WhatsApp fallaran y eso devolviera un error, el cliente
     * volvería a mandar el mismo pedido y llegarían dos. Primero se guarda —que
     * es lo que no se puede perder— y después se avisa.
     */
    const [pdfDelPedido, pdfDelRotulo] = await Promise.all([pdfPedido(pedido), pdfRotulo(pedido)]);
    const avisos = await avisarPedido(pedido, { pedido: pdfDelPedido, rotulo: pdfDelRotulo });
    db.prepare('UPDATE pedidos SET aviso_mail = ?, aviso_whatsapp = ? WHERE id = ?')
      .run(avisos.mail, avisos.whatsapp, pedido.id);

    res.status(201).json({
      numero: pedido.numero,
      total: pedido.total,
      unidades: pedido.unidades,
      avisos,
      /*
       * La firma para bajar el remito. Quien pidió sin cuenta no tiene otra
       * forma de probar que el pedido es suyo.
       */
      token: auth.firmarDocumento(pedido.numero),
    });
  } catch (e) { next(e); }
});

/*
 * GET /api/pedidos/:numero/pedido.pdf | rotulo.pdf
 *
 * Quién puede bajar qué:
 *  · el rótulo, sólo el administrador. Es la etiqueta que se pega en el bulto
 *    y la usa quien despacha, no quien compra;
 *  · el remito, el administrador, el cliente dueño del pedido, y quien traiga
 *    la firma de ese número —que es la forma que tiene de bajarlo quien pidió
 *    sin cuenta—.
 *
 * Antes no se pedía nada. Con números correlativos eso alcanzaba para bajar el
 * remito de cualquier cliente probando ISU-000001, ISU-000002 y así.
 */
r.get('/pedidos/:numero/:documento.pdf', async (req, res, next) => {
  try {
    const cual = req.params.documento;
    if (cual !== 'pedido' && cual !== 'rotulo') {
      return res.status(404).json({ message: 'Ese documento no existe.' });
    }

    const esAdmin = req.sesion?.rol === 'admin';
    if (cual === 'rotulo' && !esAdmin) {
      return res.status(403).json({ message: 'El rótulo lo descarga ISUWAYA cuando prepara el envío.' });
    }

    const pedido = leerPedido(req.params.numero);
    if (!pedido) return res.status(404).json({ message: 'No existe ese pedido.' });

    const esSuyo = req.sesion?.rol === 'cliente' && pedido.cliente_id === req.sesion.cliente.id;
    if (!esAdmin && !esSuyo && !auth.documentoFirmado(pedido.numero, req.query.t)) {
      /*
       * Se contesta lo mismo exista o no el pedido de otro: un 404 acá y un
       * 403 allá le dice a quien prueba números cuáles existen.
       */
      return res.status(404).json({ message: 'No existe ese pedido.' });
    }

    const pdf = cual === 'rotulo' ? await pdfRotulo(pedido) : await pdfPedido(pedido);
    res.type('application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${pedido.numero}-${cual}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

module.exports = r;
