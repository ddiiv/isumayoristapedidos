const express = require('express');
const { db } = require('../db');
const {
  validarCliente, cuitValido, armarPedido, guardarPedido, leerPedido,
  minimoDeCompra, faltaParaElMinimo,
} = require('../pedidos');
const clientes = require('../clientes');
const { pdfPedido, pdfRotulo } = require('../pdf');
const { avisarPedido, avisarCliente } = require('../notificaciones');
const auth = require('../auth');
const eventos = require('../eventos');
const stocker = require('../stocker');

const pesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });

/*
 * El aviso del mínimo, con las mismas palabras en todos lados.
 *
 * Lo arma el servidor y no la pantalla: es el texto que se muestra mientras se
 * arma el carrito y también el que vuelve si alguien igual intenta confirmar.
 * Dos redacciones distintas para la misma regla se leen como dos reglas.
 */
const avisoDelMinimo = ({ minimo, falta }) =>
  `El pedido mínimo es de ${pesos(minimo)}. Te faltan ${pesos(falta)} para llegar.`;

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
// La búsqueda por CUIT: una por pedido alcanza y sobra, y así nadie recorre CUITs de a miles.
const demasiadasBusquedas = limitador(20);
// La medición manda lotes, no eventos sueltos: con uno cada diez segundos por
// visita sobra, y este techo deja lugar a varias personas detrás de la misma IP.
const demasiadosEventos = limitador(60);

const frenar = (mirar) => (req, res, next) => (mirar(req)
  ? res.status(429).json({ message: 'Estás yendo muy rápido. Esperá un momento y probá de nuevo.' })
  : next());

/*
 * POST /api/eventos
 *
 * Lo que la tienda informa de lo que se mira: fichas abiertas, clicks, lo que
 * entra al carrito y lo que queda abandonado al cerrar la pestaña. Llega en
 * lotes y se contesta sin cuerpo: es medición, y ninguna pantalla espera nada.
 *
 * Nunca falla para afuera. Un error midiendo no puede ensuciar la pantalla de
 * alguien que está comprando, así que lo que no se entiende se descarta.
 */
r.post('/eventos', frenar(demasiadosEventos), (req, res) => {
  try {
    // El cliente queda atado al evento sólo si ya tenía la sesión abierta.
    eventos.registrar(req.body, { clienteId: req.sesion?.cliente?.id || null });
  } catch { /* la tienda sigue andando igual */ }
  res.status(204).end();
});

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
           p.categoria_id, p.guia_talles, p.descripcion, p.creado_en, p.novedad
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

  /*
   * Todas las fotos de cada producto, con el color al que pertenecen.
   *
   * Antes el catálogo leía sólo la foto principal y una tabla vieja que ya no
   * se llena: el panel deja subir veinte fotos por producto, cada una con su
   * color, y al cliente no le llegaba ninguna más que la primera. Van en el
   * orden en que las acomodó el panel.
   */
  const fotos = db.prepare(`
    SELECT f.producto_id, f.ruta, f.miniatura, f.media, c.nombre AS color
    FROM fotos f LEFT JOIN colores c ON c.id = f.color_id
    ORDER BY f.producto_id, f.orden, f.id`).all();

  const porProducto = new Map(productos.map((p) => [p.id, []]));
  for (const v of variantes) porProducto.get(v.producto_id)?.push(v);
  const fotosPorProducto = new Map();
  for (const f of fotos) {
    if (!fotosPorProducto.has(f.producto_id)) fotosPorProducto.set(f.producto_id, []);
    fotosPorProducto.get(f.producto_id).push({
      ruta: f.ruta, color: f.color || null, miniatura: f.miniatura || null, media: f.media || null,
    });
  }

  /*
   * El orden lo decide lo que la gente mira, no el número de fila.
   *
   * `orden` quedó como desempate y como la forma de forzar algo a mano desde el
   * panel. Mientras no haya eventos suficientes manda la demanda de los
   * pedidos: así el catálogo está bien ordenado desde el primer día y no desde
   * dentro de un mes (ver src/eventos.js).
   */
  const { mapa: puntajes } = eventos.popularidad();
  const HACE_30_DIAS = new Date(Date.now() - 30 * 86_400_000).toISOString();

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
      // Cuándo entró a la plataforma, y si eso fue hace menos de 30 días. Nulo
      // = se cargó antes de que se registraran las altas, no que sea viejo.
      altaEn: p.creado_en || null,
      nuevo: Boolean(p.creado_en && p.creado_en >= HACE_30_DIAS),
      precio: p.precio,
      modelo: p.modelo,
      genero: p.genero,
      foto: p.foto,
      fotos: conLaPrincipalPrimero(fotosPorProducto.get(p.id) || [], p.foto),
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
  /*
   * Los más mirados primero, dentro de cada categoría.
   *
   * El navegador agrupa por categoría respetando este orden, así que alcanza
   * con ordenar la lista entera. Lo que empata queda como venía de la consulta
   * —`orden` y después título—, porque ordenar en JavaScript conserva el orden
   * previo de los empatados.
   */
  const idPorSku = new Map(productos.map((p) => [p.sku_agrupador, p.id]));
  const puntajeDe = (p) => puntajes.get(idPorSku.get(p.sku));
  salida.sort((a, b) => ((puntajeDe(b)?.puntajeFinal || 0) - (puntajeDe(a)?.puntajeFinal || 0))
    || ((puntajeDe(b)?.unidades || 0) - (puntajeDe(a)?.unidades || 0)));

  res.json({
    categorias,
    productos: salida,
    nuevos: salida.filter((p) => p.nuevo).length,
    // Cero es sin mínimo. Va en el catálogo para que la tienda lo sepa desde el primer clic.
    minimoCompra: minimoDeCompra(),
  });
});

// POST /api/pedidos/previsualizar — valoriza sin guardar nada.
/*
 * POST /api/clientes/por-cuit — lo que ya se sabe de un CUIT, para el formulario.
 *
 * El nombre completo y el teléfono y el email tapados: ver src/clientes.js. Por
 * POST y no en la dirección, para que los CUIT no queden anotados en los logs.
 */
r.post('/clientes/por-cuit', frenar(demasiadasBusquedas), (req, res) => {
  const cuit = String(req.body?.cuit || '');
  if (!cuitValido(cuit)) return res.status(400).json({ message: 'Ese CUIT no es válido.' });
  res.json(clientes.datosParaAutocompletar(cuit));
});

r.post('/pedidos/previsualizar', frenar(demasiadosPapeles), (req, res) => {
  const { datos, ocultos } = clientes.completarConGuardados(req.body?.cliente);
  const { cliente, errores: erroresCliente } = validarCliente(datos);
  const { items, total, unidades, errores } = armarPedido(req.body?.carrito);

  if (!items.length) {
    return res.status(400).json({ message: 'El pedido está vacío.', errores, erroresCliente });
  }
  const falta = faltaParaElMinimo(total);
  // Lo que salió de lo guardado vuelve tapado: el resumen lo ve quien escribió el CUIT, que puede no ser el dueño.
  res.json({
    cliente: clientes.enmascarar(cliente, ocultos),
    items,
    total,
    unidades,
    errores,
    erroresCliente,
    // El resumen avisa, pero no rechaza: rechazar es cosa de confirmar.
    minimo: falta ? { ...falta, aviso: avisoDelMinimo(falta) } : null,
  });
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
    const { datos, ocultos } = clientes.completarConGuardados(req.body?.cliente);
    const { cliente } = validarCliente(datos);
    const { items, total, unidades } = armarPedido(req.body?.carrito);
    if (!items.length) return res.status(400).json({ message: 'El pedido está vacío.' });

    const pdf = await pdfPedido({
      numero: 'PRELIMINAR', creado_en: new Date().toISOString(),
      cliente: clientes.enmascarar(cliente, ocultos), items, total, unidades,
    });
    res.type('application/pdf')
      .setHeader('Content-Disposition', 'attachment; filename="pedido-preliminar.pdf"');
    res.send(pdf);
  } catch (e) { next(e); }
});

// POST /api/pedidos — confirma, guarda y avisa.
r.post('/pedidos', frenar(demasiadosPedidos), async (req, res, next) => {
  try {
    const { datos, ocultos } = clientes.completarConGuardados(req.body?.cliente);
    const { cliente, errores: erroresCliente } = validarCliente(datos);
    if (Object.keys(erroresCliente).length) {
      return res.status(400).json({ message: 'Faltan datos para el envío.', erroresCliente });
    }

    const { items, total, unidades, errores } = armarPedido(req.body?.carrito);
    if (!items.length) return res.status(400).json({ message: 'El pedido está vacío.', errores });

    /*
     * El mínimo se exige acá, con los precios del servidor.
     *
     * La tienda ya avisa y no deja seguir, pero el total que decide es este: el
     * del navegador lo puede armar cualquiera desde la consola, y los precios
     * pueden haber cambiado entre que se armó el carrito y se confirmó.
     */
    const falta = faltaParaElMinimo(total);
    if (falta) {
      return res.status(400).json({ message: avisoDelMinimo(falta), minimo: falta });
    }

    /*
     * El pedido queda atado a su cliente: a la cuenta si hay sesión, y si no al
     * cliente de ese CUIT, que se crea reservado la primera vez. Así cada compra
     * suma en la sección de clientes y la próxima vez el CUIT completa los datos.
     *
     * Se guarda igual el cliente que vino en el formulario: son los datos de
     * ESTE envío, que puede ir a otra dirección. El cliente dice quién lo pidió;
     * el formulario, a dónde va. Todo en una transacción: no puede quedar un
     * cliente registrado por un pedido que no se guardó.
     */
    const cuentaId = req.sesion?.rol === 'cliente' ? req.sesion.cliente.id : null;
    const pedido = db.transaction(() => guardarPedido({
      cliente, items, total, unidades,
      clienteId: clientes.registrarCompra(cliente, { cuentaId }),
      conSesion: Boolean(cuentaId),
      datosGuardados: ocultos,
    }))();

    /*
     * El pedido ya está guardado antes de avisar.
     *
     * Si el mail o el WhatsApp fallaran y eso devolviera un error, el cliente
     * volvería a mandar el mismo pedido y llegarían dos. Primero se guarda —que
     * es lo que no se puede perder— y después se avisa.
     */
    const [pdfDelPedido, pdfDelRotulo] = await Promise.all([pdfPedido(pedido), pdfRotulo(pedido)]);
    /*
     * A ISUWAYA y al cliente a la vez. A ISUWAYA le llega el pedido para revisar
     * el stock; al cliente, la copia con el aviso de que falta esa confirmación.
     * El cliente no recibe el rótulo: es un papel del depósito.
     */
    const conCuenta = { ...pedido, seVeEnCuenta: clientes.seVeEnCuenta(pedido) };
    const [avisosNegocio, avisoCliente] = await Promise.all([
      avisarPedido(pedido, { pedido: pdfDelPedido, rotulo: pdfDelRotulo }),
      avisarCliente(conCuenta, 'pendiente', { pdf: pdfDelPedido }),
    ]);
    const avisos = { ...avisosNegocio, cliente: avisoCliente };
    db.prepare('UPDATE pedidos SET aviso_mail = ?, aviso_whatsapp = ?, aviso_cliente = ? WHERE id = ?')
      .run(avisos.mail, avisos.whatsapp, avisos.cliente, pedido.id);

    /*
     * Y a STOCKER, para que aparte el stock.
     *
     * Se anota en su cola y se manda en segundo plano: el pedido del cliente ya
     * está guardado y no puede depender de que otro sistema conteste a tiempo.
     * Si STOCKER está caído, la cola reintenta sola (ver src/stocker.js).
     */
    try {
      stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id), 'alta');
    } catch (e) {
      console.error('  stocker:', e.message);
    }

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

    const esSuyo = req.sesion?.rol === 'cliente' && clientes.visibleEnCuenta(pedido, req.sesion.cliente);
    if (!esAdmin && !esSuyo && !auth.documentoFirmado(pedido.numero, req.query.t)) {
      /*
       * Se contesta lo mismo exista o no el pedido de otro: un 404 acá y un
       * 403 allá le dice a quien prueba números cuáles existen.
       */
      return res.status(404).json({ message: 'No existe ese pedido.' });
    }

    /*
     * Quien lo baja con la firma —sin cuenta— ve tapados los datos que salieron
     * de lo guardado: la firma prueba que hizo el pedido, no que sea el dueño
     * del CUIT que escribió.
     */
    let ocultosDelPedido = [];
    try { ocultosDelPedido = JSON.parse(pedido.datos_guardados || '[]'); } catch { /* sin datos guardados */ }
    const paraImprimir = esAdmin || esSuyo ? pedido : { ...pedido, cliente: clientes.enmascarar(pedido.cliente, ocultosDelPedido) };
    const pdf = cual === 'rotulo' ? await pdfRotulo(pedido) : await pdfPedido(paraImprimir);
    res.type('application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${pedido.numero}-${cual}.pdf"`);
    res.send(pdf);
  } catch (e) { next(e); }
});

/*
 * La foto principal va primero: es la que se ve en la fila del catálogo antes
 * de tocar nada, y el carrusel tiene que arrancar por ella. Si la principal no
 * está entre las fotos cargadas —un producto de antes del panel—, se agrega.
 */
function conLaPrincipalPrimero(lista, principal) {
  if (!principal) return lista;
  const i = lista.findIndex((f) => f.ruta === principal);
  if (i === -1) return [{ ruta: principal, color: null }, ...lista];
  return [lista[i], ...lista.slice(0, i), ...lista.slice(i + 1)];
}

module.exports = r;
