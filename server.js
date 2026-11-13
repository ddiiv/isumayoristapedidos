require('./src/entorno').cargarEnv();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { FOTOS_DIR, DATA_DIR } = require('./src/db');
const publicas = require('./src/rutas/publicas');
const asistente = require('./src/rutas/asistente');
const avisos = require('./src/rutas/avisos');
const { rutas: cuentas } = require('./src/rutas/cuentas');
const { rutas: admin } = require('./src/rutas/admin');
const { conSesion } = require('./src/auth');
const { completarMiniaturas } = require('./src/miniaturas');
const whatsapp = require('./src/whatsapp');
const { completarClientesDePedidos } = require('./src/clientes');
const { comprimir } = require('./src/comprimir');
const eventos = require('./src/eventos');
const stocker = require('./src/stocker');
const respaldos = require('./src/respaldos');
const tienda = require('./src/tienda');
const { avisosEnCurso } = require('./src/tomarPedido');

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
    `img-src 'self' data: blob:${tienda.origenFotos() ? ` ${tienda.origenFotos()}` : ''}`,
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

// Lo que tarda más de medio segundo queda en el log de Railway. Sólo la ruta: la query puede traer un CUIT o un token.
app.use((req, res, next) => {
  const desde = process.hrtime.bigint();
  const ruta = req.path;   // acá, antes de que un router montado le saque el prefijo
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - desde) / 1e6;
    if (ms > 500) console.warn('  lento', req.method, ruta, res.statusCode, `${Math.round(ms)}ms`);
  });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, datos: DATA_DIR }));
/*
 * Para un monitor externo (BetterStack, UptimeRobot): 503 si hay pedidos que
 * hace más de una hora no llegan a STOCKER. Aparte de /healthz a propósito:
 * una cola trabada no tiene que frenar un deploy ni reiniciar el portal.
 */
app.get('/healthz/stocker', (req, res) => {
  const n = stocker.trabados();
  res.set('Cache-Control', 'no-store').status(n ? 503 : 200).json({ ok: !n, trabados: n });
});

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
app.use('/api/asistente', asistente);
app.use('/api/avisos', avisos);

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

/*
 * El JS y el CSS, guardados un año bajo una ruta con la versión.
 *
 * Sin versión iban con max-age=0: quien volvía a la tienda revalidaba nueve
 * archivos, cada uno una vuelta entera hasta el servidor. Con la versión en la
 * ruta, un deploy es una ruta nueva y no hay forma de que se mezcle un módulo
 * viejo con uno nuevo; los `import './util.js'` heredan el prefijo solos. Las
 * páginas se reescriben al servirlas (ver enviarPagina) y siguen sin guardarse.
 *
 * Se acepta cualquier versión, no sólo la actual: una pestaña abierta antes
 * del deploy que pide un módulo tarde recibe el de ahora en vez de un 404.
 */
const PUBLIC = path.join(__dirname, 'public');
const COMMIT = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 12);
function version() {
  if (COMMIT) return COMMIT;
  // Sin commit (local, o un deploy con `railway up`): sale de la fecha y el tamaño de cada archivo, así editar uno cambia la ruta sin reiniciar.
  const h = crypto.createHash('sha1');
  for (const carpeta of ['js', 'css']) {
    for (const f of fs.readdirSync(path.join(PUBLIC, carpeta))) {
      const st = fs.statSync(path.join(PUBLIC, carpeta, f));
      h.update(`${carpeta}/${f}:${st.size}:${st.mtimeMs};`);
    }
  }
  return h.digest('hex').slice(0, 12);
}
for (const carpeta of ['js', 'css']) {
  app.use(`/v/:version/${carpeta}`, express.static(path.join(PUBLIC, carpeta), {
    maxAge: '365d', immutable: true, index: false,
  }));
}

function enviarPagina(res, nombre, next) {
  fs.readFile(path.join(PUBLIC, nombre), 'utf8', (err, html) => {
    if (err) return next(err.code === 'ENOENT' ? undefined : err);
    // La primera foto viene de otro origen (la tienda): la conexión se abre mientras baja el resto.
    if (tienda.origenFotos()) res.set('Link', `<${tienda.origenFotos()}>; rel=preconnect`);
    const v = version();
    res.type('html').send(html.replace(/(href|src)="\/(js|css)\//g, `$1="/v/${v}/$2/`));
  });
}
app.get(/^\/([a-z-]+\.html)?$/, (req, res, next) => enviarPagina(res, req.params[0] || 'index.html', next));

app.use(express.static(PUBLIC, { index: 'index.html' }));

// Cualquier /api que no existe contesta JSON, no el HTML de la página: un 200
// con HTML donde se espera JSON es la respuesta más confusa posible.
app.use('/api', (req, res) => res.status(404).json({ message: 'No existe ese endpoint.' }));

app.use((req, res, next) => {
  // Lo que parece un archivo y no está, es 404. Devolver el index con 200 hace
  // que un asset mal escrito llegue como HTML y reviente con "unexpected token".
  if (/\.[a-z0-9]{1,8}$/i.test(req.path)) return res.status(404).type('text/plain').send('No encontrado.');
  enviarPagina(res, 'index.html', next);
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
  // Fotos y guías de talles de la tienda online: cada minuto, en memoria.
  tienda.iniciar();
  /*
   * Los eventos de la tienda duran seis meses: sirven para ver tendencias, no
   * para archivar lo que mira cada uno. Se poda al arrancar y una vez por día.
   */
  const podar = () => { try { eventos.podar(); } catch (e) { console.error('  eventos:', e.message); } };
  podar();
  setInterval(podar, 24 * 60 * 60 * 1000).unref();

  // Una copia de la base por día, las últimas siete (src/respaldos.js).
  respaldos.respaldoDiario();
  setInterval(respaldos.respaldoDiario, 24 * 60 * 60 * 1000).unref();

  /*
   * Los pedidos que STOCKER todavía no vio salen ahora: si el servicio estuvo
   * caído, en la cola quedaron esperando (ver src/stocker.js).
   */
  console.log(`  stocker ${stocker.configurado() ? 'conectado' : 'sin configurar (los pedidos no se le mandan)'}`);
  stocker.arrancar();
});

/*
 * Una promesa rota no puede llevarse puesto el portal.
 *
 * Node termina el proceso cuando una promesa queda sin atender, y las hay
 * fuera de las rutas: los oyentes de WhatsApp, la cola de STOCKER, las
 * miniaturas. Un volumen lleno mientras alguien vincula el WhatsApp tiraba
 * abajo el sitio entero, con los pedidos adentro. Queda anotado en el log y
 * el portal sigue atendiendo.
 */
process.on('unhandledRejection', (e) => {
  console.error('  promesa sin atender:', e?.stack || e);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => server.close(async () => {
    // Los avisos salen después de contestar: se esperan (hasta 30 s) antes de cortar el WhatsApp y salir.
    await Promise.race([avisosEnCurso(), new Promise((r) => setTimeout(r, 30000))]);
    whatsapp.apagar();
    process.exit(0);
  }));
}
