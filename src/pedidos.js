const { db, ordenDeTalle, proximoNumeroDePedido } = require('./db');

/*
 * Armado y valorización del pedido.
 *
 * ── Los precios los pone el servidor, siempre ──
 *
 * El navegador manda QUÉ y CUÁNTO; nunca a cuánto. Confiar en el precio que
 * llega del cliente es dejar que cualquiera edite el total desde la consola del
 * navegador, y el pedido llegaría al depósito valorizado en lo que el
 * comprador quiso.
 */

const CAMPOS_CLIENTE = {
  nombre: 'Nombre y apellido',
  cuit: 'CUIT',
  telefono: 'Teléfono',
  provincia: 'Provincia',
  ciudad: 'Ciudad',
  codigoPostal: 'Código postal',
  direccion: 'Dirección',
  formaEnvio: 'Forma de envío',
};
const OPCIONALES = ['email', 'entreCalles'];

const limpiar = (v) => String(v ?? '').trim();

/*
 * El CUIT se valida de verdad, con su dígito verificador.
 *
 * Comprobar sólo que tenga once números deja pasar cualquier número inventado,
 * y el error aparece recién al facturar — cuando el pedido ya se armó, se
 * embaló y salió.
 */
function cuitValido(cuit) {
  const d = limpiar(cuit).replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(d[i]), 0);
  let verificador = 11 - (suma % 11);
  if (verificador === 11) verificador = 0;
  if (verificador === 10) verificador = 9;
  return verificador === Number(d[10]);
}

function validarCliente(datos = {}) {
  const errores = {};
  const cliente = {};

  for (const [campo, etiqueta] of Object.entries(CAMPOS_CLIENTE)) {
    const valor = limpiar(datos[campo]);
    if (!valor) errores[campo] = `${etiqueta} es obligatorio.`;
    cliente[campo] = valor;
  }
  for (const campo of OPCIONALES) cliente[campo] = limpiar(datos[campo]);

  if (cliente.cuit && !cuitValido(cliente.cuit)) {
    errores.cuit = 'Ese CUIT no es válido. Revisá los números.';
  }
  if (cliente.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cliente.email)) {
    errores.email = 'Ese email no parece válido.';
  }
  if (cliente.codigoPostal && !/^[A-Za-z]?\d{4}[A-Za-z]{0,3}$/.test(cliente.codigoPostal.replace(/\s/g, ''))) {
    errores.codigoPostal = 'El código postal no parece válido (ej. 1425 o C1425DFG).';
  }

  return { cliente, errores };
}

/**
 * Convierte el carrito del navegador en el pedido valorizado.
 *
 * Devuelve `{ items, total, unidades, errores }`. Cada ítem trae el desglose
 * por color con sus talles, que es la forma en que se arma el pedido en el
 * depósito y la que va al PDF.
 */
function armarPedido(carrito = []) {
  const errores = [];
  const items = [];
  let total = 0;
  let unidades = 0;

  const buscarProducto = db.prepare(`
    SELECT p.*, c.nombre AS categoria
    FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.sku_agrupador = ?`);
  const buscarVariantes = db.prepare('SELECT * FROM variantes WHERE producto_id = ?');

  for (const entrada of Array.isArray(carrito) ? carrito : []) {
    const producto = buscarProducto.get(limpiar(entrada?.skuAgrupador));
    if (!producto) { errores.push(`El producto ${entrada?.skuAgrupador} ya no está en el catálogo.`); continue; }
    if (!producto.visible) { errores.push(`"${producto.titulo}" ya no está disponible.`); continue; }

    const variantes = buscarVariantes.all(producto.id);
    const porSku = new Map(variantes.map((v) => [v.sku, v]));

    // Cantidades por SKU de variante. Las curvas ya vienen resueltas a
    // cantidades desde el navegador, pero se recalculan acá igual: el número de
    // curvas es el dato, y las cantidades son su consecuencia.
    const cantidades = new Map();
    const sumar = (sku, n) => cantidades.set(sku, (cantidades.get(sku) || 0) + n);

    const curvas = Math.max(0, Math.trunc(Number(entrada?.curvas) || 0));
    if (curvas > 0) for (const v of variantes) sumar(v.sku, curvas);

    for (const [sku, valor] of Object.entries(entrada?.cantidades || {})) {
      const n = Math.max(0, Math.trunc(Number(valor) || 0));
      if (!n) continue;
      if (!porSku.has(sku)) { errores.push(`Una talle/color de "${producto.titulo}" ya no existe.`); continue; }
      sumar(sku, n);
    }

    if (!cantidades.size) continue;

    // Desglose por color, con los talles ordenados como en la matriz.
    const porColor = new Map();
    let unidadesItem = 0;
    let subtotal = 0;

    for (const [sku, n] of cantidades) {
      const v = porSku.get(sku);
      const precio = v.precio ?? producto.precio;
      unidadesItem += n;
      subtotal += precio * n;

      const color = v.color || '';
      if (!porColor.has(color)) porColor.set(color, []);
      porColor.get(color).push({ talle: v.talle || 'Único', cantidad: n, orden: v.orden_talle });
    }

    const detalle = [...porColor.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'es'))
      .map(([color, talles]) => ({
        color,
        talles: talles.sort((a, b) => a.orden - b.orden).map(({ talle, cantidad }) => ({ talle, cantidad })),
      }));

    items.push({
      skuAgrupador: producto.sku_agrupador,
      titulo: producto.titulo,
      categoria: producto.categoria || 'Sin categoría',
      precio: producto.precio,
      curvas,
      unidades: unidadesItem,
      subtotal,
      detalle,
    });
    unidades += unidadesItem;
    total += subtotal;
  }

  return { items, total, unidades, errores };
}

function guardarPedido({ cliente, items, total, unidades }) {
  const numero = proximoNumeroDePedido();
  const creadoEn = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO pedidos (numero, cliente, items, total, unidades, estado, creado_en)
    VALUES (?, ?, ?, ?, ?, 'nuevo', ?)`)
    .run(numero, JSON.stringify(cliente), JSON.stringify(items), total, unidades, creadoEn);
  return { id: info.lastInsertRowid, numero, cliente, items, total, unidades, creado_en: creadoEn };
}

function leerPedido(numero) {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
  if (!fila) return null;
  return { ...fila, cliente: JSON.parse(fila.cliente), items: JSON.parse(fila.items) };
}

module.exports = { validarCliente, cuitValido, armarPedido, guardarPedido, leerPedido, CAMPOS_CLIENTE };
