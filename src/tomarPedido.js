const { db, normalizarEstado, registrarEstado } = require('./db');
const {
  validarCliente, armarPedido, guardarPedido, leerPedido, faltaParaElMinimo,
} = require('./pedidos');
const clientes = require('./clientes');
const { pdfPedido, pdfRotulo } = require('./pdf');
const { avisarPedido, avisarCliente } = require('./notificaciones');
const auth = require('./auth');
const stocker = require('./stocker');

/*
 * Tomar un pedido: valorizarlo, confirmarlo y avisar.
 *
 * Lo usan la página (src/rutas/publicas.js) y el asistente de ventas por chat
 * (src/rutas/asistente.js). Es el mismo código a propósito: un pedido del
 * asistente tiene que validarse, guardarse, avisarse por WhatsApp y mail y
 * llegar a STOCKER exactamente como uno hecho en la página. Cada función
 * devuelve { status, json } y la ruta sólo lo contesta.
 */

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

// Valoriza sin guardar nada.
function previsualizar(cuerpo) {
  const { datos, ocultos } = clientes.completarConGuardados(cuerpo?.cliente);
  const { cliente, errores: erroresCliente } = validarCliente(datos);
  const { items, total, unidades, errores } = armarPedido(cuerpo?.carrito);

  if (!items.length) {
    return { status: 400, json: { message: 'El pedido está vacío.', errores, erroresCliente } };
  }
  const falta = faltaParaElMinimo(total);
  // Lo que salió de lo guardado vuelve tapado: el resumen lo ve quien escribió el CUIT, que puede no ser el dueño.
  return {
    status: 200,
    json: {
      cliente: clientes.enmascarar(cliente, ocultos),
      items,
      total,
      unidades,
      errores,
      erroresCliente,
      // El resumen avisa, pero no rechaza: rechazar es cosa de confirmar.
      minimo: falta ? { ...falta, aviso: avisoDelMinimo(falta) } : null,
    },
  };
}

/*
 * El pedido ya está guardado antes de avisar.
 *
 * Si el mail o el WhatsApp fallaran y eso devolviera un error, el cliente
 * volvería a mandar el mismo pedido y llegarían dos. Primero se guarda —que es
 * lo que no se puede perder— y después se avisa.
 *
 * A ISUWAYA y al cliente a la vez. A ISUWAYA le llega el pedido para revisar el
 * stock; al cliente, la copia con el aviso de que falta esa confirmación. El
 * cliente no recibe el rótulo: es un papel del depósito.
 */
async function avisar(pedido) {
  const [pdfDelPedido, pdfDelRotulo] = await Promise.all([pdfPedido(pedido), pdfRotulo(pedido)]);
  const conCuenta = { ...pedido, seVeEnCuenta: clientes.seVeEnCuenta(pedido) };
  const [avisosNegocio, avisoCliente] = await Promise.all([
    avisarPedido(pedido, { pedido: pdfDelPedido, rotulo: pdfDelRotulo }),
    avisarCliente(conCuenta, 'pendiente', { pdf: pdfDelPedido }),
  ]);
  const avisos = { ...avisosNegocio, cliente: avisoCliente };
  db.prepare('UPDATE pedidos SET aviso_mail = ?, aviso_whatsapp = ?, aviso_cliente = ? WHERE id = ?')
    .run(avisos.mail, avisos.whatsapp, avisos.cliente, pedido.id);
  return avisos;
}

/*
 * Y a STOCKER, para que aparte el stock.
 *
 * Se anota en su cola y se manda en segundo plano: el pedido del cliente ya
 * está guardado y no puede depender de que otro sistema conteste a tiempo. Si
 * STOCKER está caído, la cola reintenta sola (ver src/stocker.js).
 */
function contarleAStocker(pedidoId, evento) {
  try {
    stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId), evento);
  } catch (e) {
    console.error('  stocker:', e.message);
  }
}

// Confirma, guarda y avisa.
async function confirmar(cuerpo, { cuentaId = null, origen = null } = {}) {
  const { datos, ocultos } = clientes.completarConGuardados(cuerpo?.cliente);
  const { cliente, errores: erroresCliente } = validarCliente(datos);
  if (Object.keys(erroresCliente).length) {
    return { status: 400, json: { message: 'Faltan datos para el envío.', erroresCliente } };
  }

  const { items, total, unidades, errores } = armarPedido(cuerpo?.carrito);
  if (!items.length) return { status: 400, json: { message: 'El pedido está vacío.', errores } };

  /*
   * El mínimo se exige acá, con los precios del servidor.
   *
   * La tienda ya avisa y no deja seguir, pero el total que decide es este: el
   * del navegador lo puede armar cualquiera desde la consola, y los precios
   * pueden haber cambiado entre que se armó el carrito y se confirmó.
   */
  const falta = faltaParaElMinimo(total);
  if (falta) {
    return { status: 400, json: { message: avisoDelMinimo(falta), minimo: falta } };
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
  const pedido = db.transaction(() => guardarPedido({
    cliente, items, total, unidades,
    clienteId: clientes.registrarCompra(cliente, { cuentaId }),
    conSesion: Boolean(cuentaId),
    datosGuardados: ocultos,
    origen,
  }))();

  const avisos = await avisar(pedido);
  contarleAStocker(pedido.id, 'alta');

  return {
    status: 201,
    json: {
      numero: pedido.numero,
      total: pedido.total,
      unidades: pedido.unidades,
      avisos,
      /*
       * La firma para bajar el remito. Quien pidió sin cuenta no tiene otra
       * forma de probar que el pedido es suyo.
       */
      token: auth.firmarDocumento(pedido.numero),
    },
  };
}

/*
 * El cliente cambia lo que lleva antes de que ISUWAYA lo revise.
 *
 * Por chat se pide de a partes: "y sumame dos curvas de negro". Eso es el mismo
 * pedido, no otro: se reemplaza lo que lleva y los datos de envío, se vuelve a
 * avisar (el WhatsApp dice que es una actualización) y STOCKER recibe cómo
 * quedó. Sólo los pedidos del asistente y sólo mientras esperan la revisión:
 * uno revisado ya tiene stock apartado y quizás un bulto armado, y lo cambia
 * ISUWAYA desde el panel.
 */
async function cambiar(numero, cuerpo, { origen }) {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(String(numero || ''));
  if (!fila || fila.origen !== origen) return { status: 404, json: { message: 'No existe ese pedido.' } };
  if (normalizarEstado(fila.estado) !== 'pendiente') {
    return { status: 409, json: { message: 'ISUWAYA ya revisó ese pedido: lo nuevo tiene que ir en otro pedido.' } };
  }

  const { datos } = clientes.completarConGuardados(cuerpo?.cliente);
  const { cliente, errores: erroresCliente } = validarCliente(datos);
  if (Object.keys(erroresCliente).length) {
    return { status: 400, json: { message: 'Faltan datos para el envío.', erroresCliente } };
  }
  const { items, total, unidades, errores } = armarPedido(cuerpo?.carrito);
  if (!items.length) return { status: 400, json: { message: 'El pedido está vacío.', errores } };
  const falta = faltaParaElMinimo(total);
  if (falta) return { status: 400, json: { message: avisoDelMinimo(falta), minimo: falta } };

  db.transaction(() => {
    db.prepare('UPDATE pedidos SET cliente = ?, items = ?, total = ?, unidades = ? WHERE id = ?')
      .run(JSON.stringify(cliente), JSON.stringify(items), total, unidades, fila.id);
    // Sigue pendiente; el historial anota que lo cambió el cliente.
    registrarEstado(fila.id, 'pendiente', { nota: 'El cliente cambió el pedido por el chat.' });
  })();

  const pedido = leerPedido(fila.numero);
  const avisos = await avisar({ ...pedido, cambio: true });
  contarleAStocker(fila.id, 'modificado');
  return { status: 200, json: { numero: pedido.numero, total, unidades, items, avisos } };
}

module.exports = { previsualizar, confirmar, cambiar, avisoDelMinimo, pesos };
