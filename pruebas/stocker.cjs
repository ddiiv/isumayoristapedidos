/*
 * Pruebas de lo que ISUWAYA le manda a STOCKER.
 *
 * Contra un STOCKER de mentira (pruebas/stocker-de-prueba.cjs) y con una base
 * propia en una carpeta temporal: no toca datos/ ni necesita el servidor.
 *
 * Lo que se prueba es lo que puede salir mal de verdad: que las líneas viajen
 * con el SKU de VARIANTE —que es por donde descuenta STOCKER, y el pedido
 * guarda el del producto padre—, que cada campo respete el largo de su columna,
 * y que un STOCKER caído no pierda un pedido.
 *
 * Uso: node pruebas/stocker.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PUERTO = 4599;
const CARPETA = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-stocker-'));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-datos-'));
process.env.STOCKER_URL = `http://127.0.0.1:${PUERTO}`;
process.env.STOCKER_TOKEN = 'token-de-prueba';
process.env.STOCKER_NEGOCIO = '7';
process.env.STOCKER_CADA_MS = '3600000';   // el repartidor automático no corre durante la prueba

const { db } = require('../src/db');
const stocker = require('../src/stocker');

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const recibidos = () => fs.readdirSync(CARPETA).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(CARPETA, f), 'utf8')).cuerpo);

// ── Un catálogo mínimo y un pedido, como los guarda la tienda ─────
function armarDatos() {
  db.prepare(`INSERT INTO productos (sku_agrupador, titulo, precio) VALUES ('ISUPRU', 'Remera de prueba', 10000)`).run();
  const producto = db.prepare(`SELECT id FROM productos WHERE sku_agrupador = 'ISUPRU'`).get().id;
  db.prepare(`INSERT INTO colores (nombre, hex, orden) VALUES ('Negro', '#000000', 1)`).run();
  const color = db.prepare(`SELECT id FROM colores WHERE nombre = 'Negro'`).get().id;
  db.prepare(`INSERT INTO talles (nombre, orden, grupo) VALUES ('M', 2, 'adulto')`).run();
  const talle = db.prepare(`SELECT id FROM talles WHERE nombre = 'M'`).get().id;
  db.prepare(`INSERT INTO variantes (producto_id, sku, color, talle, orden_talle, precio, color_id, talle_id)
              VALUES (?, 'ISUPRU-NEG-M', 'negro', 'm', 2, 9500, ?, ?)`).run(producto, color, talle);

  const cliente = {
    nombre: 'Boutique Ñandú S.R.L.', cuit: '27-30456789-4', telefono: '11 5555-1234',
    email: 'compras@nandu.test', provincia: 'Córdoba', ciudad: 'Villa Carlos Paz',
    codigoPostal: '5152', direccion: 'Av. San Martín 1847', entreCalles: 'Belgrano y Rivadavia',
    formaEnvio: 'Expreso Cruz del Sur, que retira en el depósito los martes',
  };
  const items = [{
    skuAgrupador: 'ISUPRU', titulo: 'Remera de prueba', categoria: 'Remeras', precio: 10000,
    curvas: 0, unidades: 3, subtotal: 28500,
    detalle: [{ color: 'Negro', talles: [{ talle: 'M', cantidad: 3 }] }],
  }];
  db.prepare(`INSERT INTO pedidos (numero, cliente, items, total, unidades, estado, creado_en)
              VALUES ('ISU-000777', ?, ?, 28500, 3, 'pendiente', ?)`)
    .run(JSON.stringify(cliente), JSON.stringify(items), new Date().toISOString());
  return db.prepare(`SELECT * FROM pedidos WHERE numero = 'ISU-000777'`).get();
}

(async () => {
  const falso = spawn(process.execPath, [path.join(__dirname, 'stocker-de-prueba.cjs'), String(PUERTO), CARPETA], {
    env: { ...process.env, TOKEN: 'token-de-prueba' }, stdio: 'ignore',
  });
  await esperar(600);
  const pedido = armarDatos();

  tit('1. EL ALTA LLEGA CON LO QUE STOCKER NECESITA');
  stocker.anotar(pedido, 'alta');
  chk('queda anotado para mandar', 'pendiente',
    db.prepare(`SELECT stocker_estado FROM pedidos WHERE id = ?`).get(pedido.id).stocker_estado);
  const r1 = await stocker.procesarCola();
  chk('se manda', { mandados: 1, fallados: 0, apagado: false }, r1);
  chk('y el pedido queda como enviado a STOCKER', 'enviado',
    db.prepare(`SELECT stocker_estado FROM pedidos WHERE id = ?`).get(pedido.id).stocker_estado);

  const [alta] = recibidos();
  chk('con el negocio y la plataforma', [7, 'isuwaya', 'alta'], [alta.negocioId, alta.plataforma, alta.evento]);
  chk('el número de pedido es el externo', 'ISU-000777', alta.pedidoExterno);
  chk('el total y las unidades', [28500, 3], [alta.total, alta.unidades]);

  /*
   * Lo que de verdad importa: el pedido guarda "Negro / M" y el SKU del producto
   * padre; STOCKER descuenta por SKU de variante. Si esta traducción falla, el
   * stock se descuenta de otra cosa o no se descuenta.
   */
  chk('la línea viaja con el SKU de VARIANTE', ['ISUPRU-NEG-M', 3], [alta.items[0].sku, alta.items[0].cantidad]);
  chk('con el precio de la variante, no el del padre', 9500, alta.items[0].precioUnitario);
  chk('y con color y talle para el depósito', ['Negro', 'M'], [alta.items[0].color, alta.items[0].talle]);

  tit('2. LOS DATOS DEL CLIENTE, CON EL LARGO DE CADA COLUMNA');
  chk('el comprador del pedido de plataforma', ['Boutique Ñandú S.R.L.', '27304567894', 'compras@nandu.test'],
    [alta.comprador.nombre, alta.comprador.documento, alta.comprador.email]);
  chk('el documento va sólo con números, como lo guarda Stocker', true, /^\d+$/.test(alta.comprador.documento));
  chk('la ficha de cliente va aparte y como mayorista', 'mayorista', alta.cliente.tipo);
  chk('con CUIT, teléfono y dirección armada', true,
    alta.cliente.cuit === '27-30456789-4'
    && alta.cliente.telefono === '11 5555-1234'
    && alta.cliente.direccion.includes('Villa Carlos Paz')
    && alta.cliente.direccion.includes('(5152)'));
  chk('ningún campo se pasa del largo de su columna', true,
    alta.cliente.nombre.length <= 100 && alta.comprador.nombre.length <= 150
    && alta.cliente.telefono.length <= 30 && alta.cliente.direccion.length <= 255
    && alta.comprador.documento.length <= 20 && alta.pedidoExterno.length <= 60);
  chk('y el envío viaja entero, con su forma', true,
    alta.envio.forma.startsWith('Expreso Cruz del Sur') && alta.envio.codigoPostal === '5152');

  tit('3. LA FORMA DE PAGO VIAJA AL CONFIRMAR');
  db.prepare(`UPDATE pedidos SET estado = 'confirmado', pago_forma = 'Transferencia', pago_condicion = 'contado' WHERE id = ?`)
    .run(pedido.id);
  stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id), 'confirmado');
  await stocker.procesarCola();
  const confirmado = recibidos().at(-1);
  chk('el evento es el de confirmación', 'confirmado', confirmado.evento);
  chk('con la forma y la condición de pago', ['Transferencia', 'contado'],
    [confirmado.pago.forma, confirmado.pago.condicion]);
  chk('y con la secuencia más alta que la del alta', true, confirmado.secuencia > alta.secuencia);

  tit('4. UN STOCKER CAÍDO NO PIERDE UN PEDIDO');
  falso.kill();
  await esperar(300);
  db.prepare(`UPDATE pedidos SET estado = 'enviado' WHERE id = ?`).run(pedido.id);
  stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id), 'enviado');
  const r2 = await stocker.procesarCola();
  chk('el envío falla', { mandados: 0, fallados: 1, apagado: false }, r2);
  const enCola = db.prepare(`SELECT * FROM stocker_cola WHERE evento = 'enviado'`).get();
  chk('pero queda en la cola para reintentar', ['pendiente', 1], [enCola.estado, enCola.intentos]);
  chk('con su próximo intento agendado más adelante', true, enCola.proximo_en > new Date().toISOString());
  chk('y el pedido avisa que está pendiente de sincronizar', 'pendiente',
    db.prepare(`SELECT stocker_estado FROM pedidos WHERE id = ?`).get(pedido.id).stocker_estado);

  const revive = spawn(process.execPath, [path.join(__dirname, 'stocker-de-prueba.cjs'), String(PUERTO), CARPETA], {
    env: { ...process.env, TOKEN: 'token-de-prueba' }, stdio: 'ignore',
  });
  await esperar(600);
  stocker.reintentar('ISU-000777');
  await stocker.procesarCola();
  const despacho = recibidos().at(-1);
  chk('cuando STOCKER vuelve, el despacho llega', 'enviado', despacho.evento);
  chk('con el pedido entero, no sólo el cambio', true,
    despacho.items.length === 1 && despacho.cliente.nombre === 'Boutique Ñandú S.R.L.');

  tit('5. UN CUERPO QUE STOCKER RECHAZA NO SE REINTENTA PARA SIEMPRE');
  revive.kill();
  await esperar(300);
  const rechazador = spawn(process.execPath, [path.join(__dirname, 'stocker-de-prueba.cjs'), String(PUERTO), CARPETA], {
    env: { ...process.env, TOKEN: 'token-de-prueba', FALLAR: '400' }, stdio: 'ignore',
  });
  await esperar(600);
  db.prepare(`UPDATE pedidos SET estado = 'entregado' WHERE id = ?`).run(pedido.id);
  stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id), 'entregado');
  await stocker.procesarCola();
  const rechazado = db.prepare(`SELECT * FROM stocker_cola WHERE evento = 'entregado'`).get();
  chk('un 400 queda en error, no reintentando', 'error', rechazado.estado);
  chk('y dice por qué', true, String(rechazado.ultimo_error).startsWith('400'));
  chk('el panel lo ve como error', 'error',
    db.prepare(`SELECT stocker_estado FROM pedidos WHERE id = ?`).get(pedido.id).stocker_estado);
  chk('y se puede volver a poner en la fila', 1, stocker.reintentar('ISU-000777'));
  rechazador.kill();

  tit('5b. EL 404 VIENE CON LA PISTA DE POR QUÉ');
  /*
   * La ruta de STOCKER cuelga de /api y la dirección configurada casi siempre
   * se pone sin él: es el primer error que aparece al conectar esto. El panel
   * lo dice en vez de dejar a alguien media hora mirando logs.
   */
  const cuatrocientosCuatro = spawn(process.execPath, [path.join(__dirname, 'stocker-de-prueba.cjs'), String(PUERTO), CARPETA], {
    env: { ...process.env, TOKEN: 'token-de-prueba', FALLAR: '404' }, stdio: 'ignore',
  });
  await esperar(600);
  db.prepare(`UPDATE pedidos SET estado = 'cancelado' WHERE id = ?`).run(pedido.id);
  stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedido.id), 'cancelado');
  await stocker.procesarCola();
  chk('la pista habla del /api', true, /\/api/.test(stocker.estadoPublico().pista || ''));
  chk('y no dice a dónde se manda', false, (stocker.estadoPublico().pista || '').includes(String(PUERTO)));
  cuatrocientosCuatro.kill();
  await esperar(200);

  tit('6. NI LA DIRECCIÓN DE STOCKER NI EL NEGOCIO SALEN DEL SERVIDOR');
  /*
   * El panel se abre desde cualquier computadora y termina en capturas de
   * pantalla. La dirección del backend de STOCKER y el número de negocio son el
   * mapa para golpearle la puerta a un servicio que justamente no tiene dominio
   * público: no pueden viajar al navegador, ni siquiera dentro de un error.
   */
  const publico = stocker.estadoPublico();
  const comoTexto = JSON.stringify(publico);
  chk('el estado dice si está configurado', true, publico.configurado);
  chk('pero no lleva la dirección', [false, false],
    [Object.hasOwn(publico, 'destino'), comoTexto.includes(String(PUERTO))]);
  chk('ni el número de negocio', [false, false],
    [Object.hasOwn(publico, 'negocio'), comoTexto.includes('"negocioId"')]);
  chk('ni el token', false, comoTexto.includes('token-de-prueba'));

  chk('una dirección adentro de un error se reemplaza', 'request to STOCKER failed',
    stocker.sinDireccion('request to http://127.0.0.1:4599/integraciones/isuwaya/pedidos failed'));
  chk('y el host suelto también', 'ENOTFOUND STOCKER', stocker.sinDireccion('ENOTFOUND 127.0.0.1'));
  chk('el error guardado del 400 no tiene dirección', false,
    String(db.prepare(`SELECT ultimo_error FROM stocker_cola WHERE evento = 'entregado'`).get().ultimo_error)
      .includes(String(PUERTO)));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  fs.rmSync(CARPETA, { recursive: true, force: true });
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
