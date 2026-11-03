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
    // Los avisos salen después de contestar: se espera a que queden anotados.
    let avisado = null;
    for (let i = 0; i < 50 && !(avisado?.aviso_whatsapp && avisado?.aviso_mail); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      avisado = db.prepare('SELECT aviso_whatsapp, aviso_mail FROM pedidos WHERE numero = ?').get(numero);
    }
    chk('y se intentó avisar (sin WhatsApp ni mail configurados, queda anotado)', true, Boolean(avisado?.aviso_whatsapp && avisado?.aviso_mail));

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

    tit('6. UN PEDIDO POR SU NÚMERO, SÓLO DESDE SU TELÉFONO');
    const otro = (await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) })).json.numero;
    const reclamar = (n, telefono) => pedir('POST', `/asistente/pedidos/${n}/reclamar`, { telefono });
    const suyo = await reclamar(otro.replace(/^ISU-0+/, ''), '+54 9 11 5555-1234');
    chk('con el WhatsApp del pedido y el número sin ceros: lo trae', [200, otro, 'pendiente', true, 1],
      [suyo.status, suyo.json?.numero, suyo.json?.estado, suyo.json?.modificable, suyo.json?.items?.[0]?.unidades]);
    chk('con la firma para bajar el PDF', 200,
      (await fetch(`${base}/pedidos/${otro}/pedido.pdf?t=${encodeURIComponent(suyo.json?.token)}`)).status);
    chk('sin datos del cliente en la respuesta', undefined, suyo.json?.cliente);
    const ajeno = await reclamar(otro, '+5491166667777');
    chk('desde otro teléfono: como si no existiera, y sin firma', [404, undefined], [ajeno.status, ajeno.json?.token]);
    chk('sin teléfono: 404', 404, (await reclamar(otro, '')).status);
    chk('uno que no existe: 404', 404, (await reclamar('999999', '+5491155551234')).status);
    chk('el revisado se trae, pero no se puede cambiar', [200, false], [(await reclamar(numero, '1155551234')).status, (await reclamar(numero, '1155551234')).json?.modificable]);
    chk('el de la página se trae, pero no se puede cambiar', false, (await reclamar(dePagina.json?.numero, '1155551234')).json?.modificable);

    tit('7. LOS DATOS QUE NO SE REPITEN SIGUEN COMO ESTABAN');
    const sinRepetir = await pedir('PUT', `/asistente/pedidos/${otro}`, { cliente: { telefono: '+5491155551234', direccion: 'Mitre 10' }, carrito: carrito(3) });
    const cambiado = JSON.parse(db.prepare('SELECT cliente FROM pedidos WHERE numero = ?').get(otro).cliente);
    chk('se cambia sin volver a dar todo', [200, CLIENTE.cuit, 'Mitre 10'], [sinRepetir.status, cambiado.cuit, cambiado.direccion]);

    tit('8. CANCELAR');
    chk('uno de la página no lo cancela: 404', 404, (await pedir('POST', `/asistente/pedidos/${dePagina.json?.numero}/cancelar`)).status);
    chk('uno revisado no lo cancela: 409', 409, (await pedir('POST', `/asistente/pedidos/${numero}/cancelar`)).status);
    chk('sin la clave no entra: 401', 401, (await pedir('POST', `/asistente/pedidos/${otro}/cancelar`, null, null)).status);
    const cancelado = await pedir('POST', `/asistente/pedidos/${otro}/cancelar`);
    chk('el suyo pendiente se cancela', [200, 'cancelado'], [cancelado.status, cancelado.json?.estado]);
    chk('STOCKER se entera', ['alta', 'modificado', 'cancelado'], cola(otro));
    chk('y ya no se puede cambiar', 409, (await pedir('PUT', `/asistente/pedidos/${otro}`, { cliente: CLIENTE, carrito: carrito(1) })).status);

    tit('9. EL MÍNIMO DE COMPRA VALE IGUAL');
    guardarConfig('minimo_compra', '100000');
    const corto = await pedir('POST', '/asistente/pedidos', { cliente: CLIENTE, carrito: carrito(1) });
    chk('debajo del mínimo no se confirma, y dice cuánto falta', [400, 90000], [corto.status, corto.json?.minimo?.falta]);
  } finally {
    server.close();
  }

  console.log(`\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m\n`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
