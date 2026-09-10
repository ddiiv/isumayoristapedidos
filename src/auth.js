const crypto = require('node:crypto');
const { db } = require('./db');

/*
 * Quién sos: una sola puerta para los dos.
 *
 * El formulario de entrada es uno solo y el servidor decide qué sos. Dos
 * pantallas de login —una para el dueño y otra para el cliente— obligan a
 * elegir bien antes de saber si te equivocaste, y quien se confunde recibe
 * "contraseña incorrecta" cuando lo que erró fue la puerta.
 *
 * La sesión es una cookie firmada con HMAC, sin tabla de sesiones: el servidor
 * no guarda nada y la verifica igual. Para un portal con un dueño y unos
 * cientos de clientes, una tabla de sesiones es algo más que mantener sin que
 * resuelva nada que esto no resuelva.
 */

const COOKIE = 'isuwaya_sesion';
const DURACION_MS = 12 * 60 * 60 * 1000;

const secretoDelServidor = () => {
  const p = process.env.ADMIN_PASSWORD;
  if (!p) return null;
  return crypto.createHash('sha256').update(`isuwaya:sesion:${p}`).digest();
};

// ── Contraseñas de los clientes ───────────────────────────────────
/*
 * scrypt, no un hash a secas.
 *
 * SHA-256 sobre una contraseña se prueba de a millones por segundo con una
 * placa de video. scrypt está hecho para ser lento y caro en memoria, que es lo
 * único que sirve cuando la contraseña la elige una persona. Viene en Node, no
 * hace falta ninguna dependencia.
 */
function hashear(password) {
  const sal = crypto.randomBytes(16);
  const clave = crypto.scryptSync(String(password), sal, 64);
  return `scrypt$${sal.toString('hex')}$${clave.toString('hex')}`;
}

function verificar(password, guardado) {
  const [algo, salHex, claveHex] = String(guardado || '').split('$');
  if (algo !== 'scrypt' || !salHex || !claveHex) return false;
  const esperada = Buffer.from(claveHex, 'hex');
  const calculada = crypto.scryptSync(String(password), Buffer.from(salHex, 'hex'), esperada.length);
  return crypto.timingSafeEqual(esperada, calculada);
}

// ── La cookie ─────────────────────────────────────────────────────
function firmar(payload) {
  const s = secretoDelServidor();
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = crypto.createHmac('sha256', s).update(cuerpo).digest('base64url');
  return `${cuerpo}.${firma}`;
}

function leerToken(token) {
  const s = secretoDelServidor();
  if (!s || !token) return null;
  const [cuerpo, firma] = String(token).split('.');
  if (!cuerpo || !firma) return null;

  const esperada = crypto.createHmac('sha256', s).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  // Tiempo constante: con un `===`, cuánto tarda en contestar filtra cuántos
  // caracteres de la firma acertó quien está probando.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    if (!datos.vence || datos.vence < Date.now()) return null;
    return datos;
  } catch { return null; }
}

function ponerCookie(res, req, payload) {
  const token = firmar({ ...payload, vence: Date.now() + DURACION_MS });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACION_MS / 1000}`
    + (req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}

function borrarCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function leerCookie(req) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ── Middleware ────────────────────────────────────────────────────
/*
 * Deja en `req.sesion` quién es, o null. No corta nada: hay pantallas que se
 * ven con y sin sesión —el catálogo, sin ir más lejos— y sólo cambian por
 * dentro. Cortar el paso es trabajo de `exigirAdmin` y `exigirCliente`.
 */
function conSesion(req, res, next) {
  req.sesion = null;
  const datos = leerToken(leerCookie(req));
  if (!datos) return next();

  if (datos.rol === 'admin') {
    req.sesion = { rol: 'admin' };
    return next();
  }
  if (datos.rol === 'cliente' && datos.id) {
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(datos.id);
    /*
     * El cliente se relee en cada pedido, no se confía en lo que dice la
     * cookie. Sin esto, desactivar a alguien no le corta el acceso hasta que
     * su sesión venza: doce horas de un cliente al que se le cerró la cuenta.
     */
    if (cliente && cliente.activo) {
      req.sesion = { rol: 'cliente', cliente };
    }
  }
  next();
}

function exigirAdmin(req, res, next) {
  if (!secretoDelServidor()) {
    return res.status(503).json({ message: 'El panel no está configurado: falta ADMIN_PASSWORD en el servidor.' });
  }
  if (req.sesion?.rol !== 'admin') return res.status(401).json({ message: 'Entrá como administrador.' });
  next();
}

function exigirCliente(req, res, next) {
  if (req.sesion?.rol !== 'cliente') return res.status(401).json({ message: 'Entrá a tu cuenta.' });
  next();
}

/** Los datos del cliente en la forma que usa el formulario del pedido. */
function datosDePedido(cliente) {
  if (!cliente) return null;
  return {
    nombre: cliente.nombre || '',
    cuit: cliente.cuit || '',
    telefono: cliente.telefono || '',
    email: cliente.email || '',
    provincia: cliente.provincia || '',
    ciudad: cliente.ciudad || '',
    codigoPostal: cliente.codigo_postal || '',
    direccion: cliente.direccion || '',
    entreCalles: cliente.entre_calles || '',
    formaEnvio: cliente.forma_envio || '',
  };
}

const sinPassword = (c) => { const { password_hash, ...resto } = c; return resto; };

module.exports = {
  hashear, verificar, ponerCookie, borrarCookie, leerCookie, leerToken,
  conSesion, exigirAdmin, exigirCliente, datosDePedido, sinPassword,
  secretoDelServidor, COOKIE,
};
