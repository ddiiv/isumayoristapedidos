/*
 * Un redeploy no se lleva puestos los avisos de un pedido recién confirmado.
 *
 * El pedido se contesta apenas queda guardado y los avisos salen después. Si
 * el proceso termina al cerrar el servidor, el mail que estaba saliendo se
 * corta y nadie lo vuelve a mandar. Se confirma un pedido contra un SMTP lento,
 * se manda SIGTERM enseguida y se mira que los mails lleguen igual.
 *
 * Con un servidor y una base propios en una carpeta temporal: no toca datos/.
 *
 * Uso: node pruebas/apagado.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PUERTO = 8097;
const PUERTO_CORREO = 2537;
const DATOS = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-apagado-'));
const CORREOS = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-apagado-correos-'));

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Un producto, cargado antes de que el servidor abra la base.
process.env.DATA_DIR = DATOS;
const { db } = require('../src/db');
db.prepare(`INSERT INTO productos (sku_agrupador, titulo, precio) VALUES ('ISUAPA', 'Remera de prueba', 10000)`).run();
const producto = db.prepare(`SELECT id FROM productos WHERE sku_agrupador = 'ISUAPA'`).get().id;
db.prepare(`INSERT INTO variantes (producto_id, sku, color, talle, orden_talle, precio)
            VALUES (?, 'ISUAPA-NEG-M', 'negro', 'm', 2, 9500)`).run(producto);

(async () => {
  console.log('\n\x1b[1mAPAGAR EL SERVIDOR NO CORTA LOS AVISOS\x1b[0m');
  // Saluda a los 1,5 s: el aviso sigue saliendo cuando llega la señal.
  const correo = spawn(process.execPath, [path.join(__dirname, 'correo-de-prueba.cjs'), String(PUERTO_CORREO), CORREOS, '1500'], { stdio: 'ignore' });
  const servidor = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, DATA_DIR: DATOS, PORT: String(PUERTO),
      MAIL_HOST: '127.0.0.1', MAIL_PORT: String(PUERTO_CORREO), MAIL_USER: 'x', MAIL_PASS: 'x',
      PEDIDOS_EMAIL: 'pedidos@prueba.test', STOCKER_URL: '',
    },
    stdio: 'ignore',
  });
  const termino = new Promise((r) => servidor.on('exit', r));
  try {
    for (let i = 0; i < 50; i += 1) {
      if (await fetch(`http://127.0.0.1:${PUERTO}/healthz`).then((r) => r.ok, () => false)) break;
      await esperar(200);
    }
    const r = await fetch(`http://127.0.0.1:${PUERTO}/api/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente: {
          nombre: 'QA Apagado', cuit: '27-30456789-4', telefono: '11 5555-5555',
          email: 'qa@prueba.test', provincia: 'Córdoba', ciudad: 'Villa Carlos Paz',
          codigoPostal: '5152', direccion: 'Av. San Martín 1847', entreCalles: '',
          formaEnvio: 'Andreani a sucursal',
        },
        carrito: [{ skuAgrupador: 'ISUAPA', curvas: 0, cantidades: { 'ISUAPA-NEG-M': 3 } }],
      }),
    });
    const { numero, copiaPorMail } = await r.json();
    chk('el pedido se confirma', 201, r.status);
    chk('y la tienda sabe que al cliente le va una copia por mail', true, copiaPorMail);
    servidor.kill('SIGTERM');
    chk('y el servidor termina solo', 0, await Promise.race([termino, esperar(40000).then(() => 'colgado')]));
    chk('pero antes salen los dos mails', 2, fs.readdirSync(CORREOS).length);
    chk('y queda anotado que salieron', ['ok', 'ok'],
      Object.values(db.prepare('SELECT aviso_mail, aviso_cliente FROM pedidos WHERE numero = ?').get(numero) || {}));
  } finally {
    servidor.kill('SIGKILL');
    correo.kill();
    fs.rmSync(DATOS, { recursive: true, force: true });
    fs.rmSync(CORREOS, { recursive: true, force: true });
  }
  console.log(`\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
