/*
 * Pruebas de la puerta del asistente de ventas por chat (src/rutas/asistente.js).
 *
 * Con una base propia en una carpeta temporal: no toca datos/ ni necesita el
 * servidor. Lo que se prueba es lo que puede salir mal de verdad: que entre
 * cualquiera sin la clave, que un pedido del asistente no sea igual a uno de la
 * página (cliente registrado, cola de STOCKER), y que el asistente pueda
 * cambiar un pedido que no es suyo o que ISUWAYA ya revisó.
 *
 * Uso: node pruebas/asistente.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-asistente-'));
process.env.ASISTENTE_TOKEN = 'clave-de-prueba-del-asistente';
// STOCKER configurado pero sin repartidor: se mira la cola, no se manda nada.
process.env.STOCKER_URL = 'http://127.0.0.1:9';
process.env.STOCKER_TOKEN = 'token-de-prueba';
process.env.STOCKER_NEGOCIO = '7';
process.env.STOCKER_CADA_MS = '3600000';
for (const v of ['PEDIDOS_EMAIL', 'PEDIDOS_WHATSAPP', 'MAIL_USER', 'MAIL_PASS']) delete process.env[v];

const express = require('express');
const { db, registrarEstado, guardarConfig } = require('../src/db');

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

function armarCatalogo() {
  db.prepare(`INSERT INTO productos (sku_agrupador, titulo, precio) VALUES ('ISUPRU', 'Remera de prueba', 10000)`).run();
  const producto = db.prepare(`SELECT id FROM productos WHERE sku_agrupador = 'ISUPRU'`).get().id;
  const variante = db.prepare(`INSERT INTO variantes (producto_id, sku, color, talle, orden_talle) VALUES (?, ?, ?, ?, ?)`);
  variante.run(producto, 'ISUPRU-NEG-M', 'Negro', 'M', 2);
  variante.run(producto, 'ISUPRU-NEG-L', 'Negro', 'L', 3);
}

const CLIENTE = {
  nombre: 'Boutique Ñandú S.R.L.', cuit: '27-30456789-4', telefono: '11 5555-1234',
  email: 'compras@nandu.test', provincia: 'Córdoba', ciudad: 'Villa Carlos Paz',
  codigoPostal: '5152', direccion: 'Av. San Martín 1847', entreCalles: 'Belgrano y Rivadavia',
  formaEnvio: 'Expreso Cruz del Sur',
};
const carrito = (m, l = 0) => [{ skuAgrupador: 'ISUPRU', cantidades: { 'ISUPRU-NEG-M': m, ...(l ? { 'ISUPRU-NEG-L': l } : {}) } }];
const cola = (numero) => db.prepare('SELECT evento FROM stocker_cola WHERE numero = ? ORDER BY id').all(numero).map((f) => f.evento);

(async () => {
  armarCatalogo();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../src/rutas/publicas'));
  app.use('/api/asistente', require('../src/rutas/asistente'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const pedir = async (metodo, ruta, cuerpo, clave = process.env.ASISTENTE_TOKEN) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(clave ? { Authorization: `Bearer ${clave}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  try {
    tit('1. SIN LA CLAVE NO ENTRA NADIE');
    chk('sin clave: 401', 401, (await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) }, null)).status);
    chk('con otra clave: 401', 401, (await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) }, 'otra')).status);
    const clave = process.env.ASISTENTE_TOKEN;
    delete process.env.ASISTENTE_TOKEN;
    chk('sin ASISTENTE_TOKEN en el servidor, la puerta está cerrada: 503', 503,
      (await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) }, clave)).status);
    process.env.ASISTENTE_TOKEN = clave;
    chk('ningún pedido se guardó', 0, db.prepare('SELECT COUNT(*) AS n FROM pedidos').get().n);

    tit('2. COTIZA CON LOS PRECIOS Y LAS REGLAS DE LA PÁGINA');
    const cot = await pedir('POST', '/asistente/pedidos/previsualizar', { cliente: CLIENTE, carrito: carrito(2, 1) });
    chk('total y unidades del servidor', [200, 30000, 3], [cot.status, cot.json?.total, cot.json?.unidades]);
    const sinDatos = await pedir('POST', '/asistente/pedidos', { cliente: { nombre: 'Ana' }, carrito: carrito(1) });
    chk('sin los datos de envío no se confirma, y dice cuáles faltan', [400, true],
      [sinDatos.status, ['cuit', 'direccion', 'formaEnvio'].every((c) => sinDatos.json?.erroresCliente?.[c])]);

    tit('3. EL PEDIDO ENTRA COMO UNO DE LA PÁGINA');
    const alta = await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(2) });
    chk('se confirma', 201, alta.status);
    const numero = alta.json?.numero;
    const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
    chk('pendiente, del asistente, con su total', ['pendiente', 'asistente', 20000], [fila?.estado, fila?.origen, fila?.total]);
    chk('el cliente queda registrado por su CUIT', true, Boolean(fila?.cliente_id));
    chk('va a la cola de STOCKER como alta', ['alta'], cola(numero));
    chk('y se intentó avisar (sin WhatsApp ni mail configurados, queda anotado)', true, Boolean(fila?.aviso_whatsapp && fila?.aviso_mail));

    tit('4. LO QUE PIDE DESPUÉS VA EN EL MISMO PEDIDO');
    const cambio = await pedir('PUT', `/asistente/pedidos/${numero}`, { cliente: CLIENTE, carrito: carrito(2, 3) });
    chk('se cambia', [200, numero], [cambio.status, cambio.json?.numero]);
    const despues = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(numero);
    chk('con lo nuevo: 5 prendas, $50.000, sigue pendiente', [5, 50000, 'pendiente'], [despues.unidades, despues.total, despues.estado]);
    chk('STOCKER recibe cómo quedó', ['alta', 'modificado'], cola(numero));
    chk('no se creó otro pedido', 1, db.prepare('SELECT COUNT(*) AS n FROM pedidos').get().n);
    chk('vacío no se puede dejar', 400, (await pedir('PUT', `/asistente/pedidos/${numero}`, { cliente: CLIENTE, carrito: [] })).status);

    tit('5. NO CAMBIA LO QUE NO ES SUYO NI LO YA REVISADO');
    const dePagina = await pedir('POST', '/pedidos', { cliente: CLIENTE, carrito: carrito(1) }, null);
    chk('la página sigue confirmando igual', [201, null],
      [dePagina.status, db.prepare('SELECT origen FROM pedidos WHERE numero = ?').get(dePagina.json?.numero)?.origen]);
    chk('un pedido de la página no lo toca: 404', 404,
      (await pedir('PUT', `/asistente/pedidos/${dePagina.json?.numero}`, { cliente: CLIENTE, carrito: carrito(9) })).status);
    registrarEstado(despues.id, 'confirmado');
    chk('uno que ISUWAYA ya revisó: 409', 409,
      (await pedir('PUT', `/asistente/pedidos/${numero}`, { cliente: CLIENTE, carrito: carrito(1) })).status);
    chk('y queda como lo dejó ISUWAYA', 5, db.prepare('SELECT unidades FROM pedidos WHERE numero = ?').get(numero).unidades);

    tit('6. EL MÍNIMO DE COMPRA VALE IGUAL');
    guardarConfig('minimo_compra', '100000');
    const corto = await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) });
    chk('debajo del mínimo no se confirma, y dice cuánto falta', [400, 90000], [corto.status, corto.json?.minimo?.falta]);
  } finally {
    server.close();
  }

  console.log(`\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m\n`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
