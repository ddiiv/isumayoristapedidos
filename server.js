require('./src/entorno').cargarEnv();

const path = require('node:path');
const express = require('express');
const { FOTOS_DIR, DATA_DIR } = require('./src/db');
const publicas = require('./src/rutas/publicas');
const { rutas: cuentas } = require('./src/rutas/cuentas');
const { rutas: admin } = require('./src/rutas/admin');
const { conSesion } = require('./src/auth');
const { completarMiniaturas } = require('./src/miniaturas');
const whatsapp = require('./src/whatsapp');
const { completarClientesDePedidos } = require('./src/clientes');
const { comprimir } = require('./src/comprimir');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

/*
 * Railway termina TLS en su borde y reenvía por http, contándolo en
 * X-Forwarded-Proto. Sin esto, `req.secure` siempre da false y la cookie del
 * panel saldría sin el flag Secure en producción.
 */
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  /*
   * Política de seguridad de contenido.
   *
   * Se arranca de `default-src 'none'` y se abre sólo lo que hace falta. Lo que
   * la hace servir es que NO hay 'unsafe-inline' en script-src: todo el
   * JavaScript de la página está en archivos propios, así que un texto de un
   * producto que llegue con HTML adentro no se ejecuta.
   *
   * `img-src` acepta `data:` por los íconos que dibuja la hoja de estilos
   * (lupa, cruz, flechas) y `blob:` por la vista previa de una foto antes de
   * subirla en el panel.
   */
  /*
   * Una página HTML no se guarda en ningún cache.
   *
   * El panel y la tienda pintan datos de quien está adentro. Sin esto el
   * navegador guarda el documento y lo devuelve con el botón Atrás después de
   * cerrar sesión —sin volver a pedirle nada al servidor—, así que en una
   * computadora compartida el que se sienta después ve lo del anterior. Los
   * .js y .css no llevan la cabecera: no tienen datos de nadie y cachearlos
   * es lo que hace que la página abra rápido.
   */
  if (!req.path.startsWith('/fotos/') && !/\.[a-z0-9]{1,8}$/i.test(req.path) || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }

  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; '));
  next();
});

// Todo lo que sale, comprimido: ver src/comprimir.js. Va antes de las rutas y de /public.
app.use(comprimir);

app.get('/healthz', (req, res) => res.json({ ok: true, datos: DATA_DIR }));

/*
 * Quién sos se resuelve UNA vez, antes que cualquier ruta.
 *
 * Deja `req.sesion` puesto —o null— y no corta nada: el catálogo se ve con y
 * sin cuenta. Cortar el paso es trabajo de cada ruta que lo necesite.
 */
app.use('/api', conSesion);
app.use('/api', cuentas);
app.use('/api', publicas);
app.use('/api/admin', admin);

/*
 * Las fotos se sirven desde el volumen, no desde el código.
 *
 * Van con `immutable` porque el nombre es aleatorio y único: una foto nueva es
 * un nombre nuevo, así que la anterior puede quedar cacheada para siempre sin
 * que nadie vea una imagen vieja.
 */
app.use('/fotos', express.static(FOTOS_DIR, {
  maxAge: '365d', immutable: true, index: false, dotfiles: 'ignore',
}));

/*
 * Las letras no cambian nunca con el mismo nombre: si alguna vez se cambia una
 * fuente, va con otro archivo. Por eso pueden quedar guardadas un año y no se
 * vuelven a pedir en cada visita, como sí pasa con el resto de /public.
 */
app.use('/fuentes', express.static(path.join(__dirname, 'public', 'fuentes'), {
  maxAge: '365d', immutable: true, index: false,
}));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// Cualquier /api que no existe contesta JSON, no el HTML de la página: un 200
// con HTML donde se espera JSON es la respuesta más confusa posible.
app.use('/api', (req, res) => res.status(404).json({ message: 'No existe ese endpoint.' }));

app.use((req, res) => {
  // Lo que parece un archivo y no está, es 404. Devolver el index con 200 hace
  // que un asset mal escrito llegue como HTML y reviente con "unexpected token".
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return res.status(404).type('text/plain').send('No encontrado.');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.status === 400 || err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: err.message || 'Pedido inválido.' });
  }
  console.error('[error]', err?.message, err?.stack?.split('\n')[1]?.trim());
  res.status(500).json({ message: 'Algo falló de este lado. Probá de nuevo.' });
});

/*
 * Sin host: Node escucha en todas las interfaces, IPv6 e IPv4.
 *
 * Estaba fijo en '::'. Railway documenta que hay que escuchar en 0.0.0.0 con
 * el PORT que inyecta, y en un contenedor sin IPv6 abrir '::' falla: la app no
 * arranca y lo único que se ve desde afuera es "Application failed to
 * respond". Sin host, Node usa '::' cuando hay IPv6 —que en Linux también
 * atiende IPv4— y 0.0.0.0 cuando no. Anda en los dos casos.
 */
const server = app.listen(PORT, () => {
  console.log(`\n  ISUWAYA MAYORISTA`);
  /*
   * El puerto se escribe en el log a propósito: si el dominio de Railway
   * apunta a otro puerto que éste, el sitio contesta "Application failed to
   * respond" con la app andando perfecto, y es lo primero que hay que mirar.
   */
  console.log(`  escuchando en el puerto ${PORT}${process.env.PORT ? '' : ' (PORT no vino del entorno)'}`);
  console.log(`  datos en ${DATA_DIR}`);
  console.log(`  panel ${process.env.ADMIN_PASSWORD ? 'configurado' : '✖ SIN ADMIN_PASSWORD — no va a abrir'}\n`);
  // Las fotos de antes de las miniaturas se completan en segundo plano: el sitio ya está atendiendo.
  completarMiniaturas().catch((e) => console.error('  miniaturas:', e.message));
  // Los pedidos de antes, atados a su cliente por CUIT (una sola vez: después no queda ninguno suelto).
  try { completarClientesDePedidos(); } catch (e) { console.error('  clientes:', e.message); }
  // Si el WhatsApp del grupo ya estaba vinculado, se reconecta solo: un deploy no obliga a escanear de nuevo.
  whatsapp.arrancarSiHaySesion();
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => { whatsapp.apagar(); server.close(() => process.exit(0)); });
}
