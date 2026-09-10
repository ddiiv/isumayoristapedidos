const path = require('node:path');
const fs = require('node:fs');

/*
 * Lee el .env local si existe.
 *
 * Doce líneas en vez de una dependencia: en Railway las variables las pone la
 * plataforma y este archivo no existe, así que `dotenv` sería un paquete que
 * sólo corre en la máquina de quien desarrolla.
 */
(() => {
  const archivo = path.join(__dirname, '.env');
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i < 1) continue;
    const clave = limpia.slice(0, i).trim();
    if (process.env[clave] !== undefined) continue;  // lo de afuera manda
    process.env[clave] = limpia.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
})();

const express = require('express');
const { FOTOS_DIR, DATA_DIR } = require('./src/db');
const publicas = require('./src/rutas/publicas');
const { rutas: cuentas } = require('./src/rutas/cuentas');
const { rutas: admin } = require('./src/rutas/admin');
const { conSesion } = require('./src/auth');

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
   * `img-src` acepta `data:` por el favicon embebido y `blob:` por la vista
   * previa de una foto antes de subirla en el panel.
   */
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

const server = app.listen(PORT, '::', () => {
  console.log(`\n  ISUWAYA MAYORISTA`);
  console.log(`  escuchando en http://localhost:${PORT}`);
  console.log(`  datos en ${DATA_DIR}`);
  console.log(`  panel ${process.env.ADMIN_PASSWORD ? 'configurado' : '✖ SIN ADMIN_PASSWORD — no va a abrir'}\n`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => server.close(() => process.exit(0)));
}
