const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const { db, FOTOS_DIR } = require('../db');
const { importarPlanilla } = require('../excel');
const { leerPedido } = require('../pedidos');

const r = express.Router();

/*
 * Sesión del panel, sin tabla de sesiones.
 *
 * Una cookie firmada con HMAC: el servidor no guarda nada y puede verificarla
 * igual. Para un panel de una sola persona, una tabla de sesiones es
 * infraestructura que hay que mantener sin que resuelva nada.
 *
 * La clave sale de ADMIN_PASSWORD. Si no está seteada el panel no abre: un
 * valor por defecto es una puerta abierta con la llave puesta, y este panel
 * edita precios y ve los datos de todos los clientes.
 */
const COOKIE = 'isuwaya_admin';
const DURACION_MS = 8 * 60 * 60 * 1000;

const secreto = () => {
  const p = process.env.ADMIN_PASSWORD;
  if (!p) return null;
  return crypto.createHash('sha256').update(`isuwaya:${p}`).digest();
};

function firmar(vence) {
  const s = secreto();
  const firma = crypto.createHmac('sha256', s).update(String(vence)).digest('hex');
  return `${vence}.${firma}`;
}

function tokenValido(token) {
  const s = secreto();
  if (!s || !token) return false;
  const [vence, firma] = String(token).split('.');
  if (!vence || !firma) return false;
  if (Number(vence) < Date.now()) return false;
  const esperada = crypto.createHmac('sha256', s).update(String(vence)).digest('hex');
  // Comparación en tiempo constante: con un `===`, el tiempo de respuesta
  // filtra cuántos caracteres de la firma acertó quien está probando.
  const a = Buffer.from(firma, 'hex');
  const b = Buffer.from(esperada, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function leerCookie(req) {
  const bruto = req.headers.cookie || '';
  for (const parte of bruto.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function exigirAdmin(req, res, next) {
  if (!secreto()) {
    return res.status(503).json({ message: 'El panel no está configurado: falta ADMIN_PASSWORD en el servidor.' });
  }
  if (!tokenValido(leerCookie(req))) return res.status(401).json({ message: 'Entrá al panel.' });
  next();
}

// Un intento por segundo alcanza para una persona y no para un diccionario.
let ultimoIntento = 0;

r.post('/login', (req, res) => {
  if (!secreto()) {
    return res.status(503).json({ message: 'Falta ADMIN_PASSWORD en el servidor.' });
  }
  const ahora = Date.now();
  if (ahora - ultimoIntento < 1000) {
    return res.status(429).json({ message: 'Esperá un segundo y probá de nuevo.' });
  }
  ultimoIntento = ahora;

  const enviada = Buffer.from(String(req.body?.password || ''));
  const real = Buffer.from(String(process.env.ADMIN_PASSWORD));
  const ok = enviada.length === real.length && crypto.timingSafeEqual(enviada, real);
  if (!ok) return res.status(401).json({ message: 'Contraseña incorrecta.' });

  const token = firmar(Date.now() + DURACION_MS);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACION_MS / 1000}`
    + (req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : ''));
  res.json({ ok: true });
});

r.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

r.get('/sesion', (req, res) => res.json({
  configurado: Boolean(secreto()),
  entrado: tokenValido(leerCookie(req)),
}));

// ── De acá para abajo, todo pide sesión ───────────────────────────
r.use(exigirAdmin);

/*
 * Importar la planilla de STOCKER.
 *
 * En memoria y con tope: un archivo de veinte megas escrito a disco antes de
 * mirarlo llena el volumen, y el volumen es donde está la base.
 */
const subirPlanilla = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

r.post('/importar', subirPlanilla.single('planilla'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Subí el archivo .xlsx exportado de STOCKER.' });
    const resumen = await importarPlanilla(req.file.buffer);
    res.json({ ok: true, resumen });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    next(e);
  }
});

// ── Fotos ─────────────────────────────────────────────────────────
const TIPOS_FOTO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const subirFoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Se mira el tipo declarado Y se renombra con nuestra extensión: un archivo
    // llamado "foto.php" servido desde el volumen es un problema de otra clase.
    if (!TIPOS_FOTO[file.mimetype]) return cb(Object.assign(new Error('Sólo JPG, PNG o WebP.'), { status: 400 }));
    cb(null, true);
  },
});

r.post('/fotos', subirFoto.single('foto'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Falta la imagen.' });
  const { sku, color } = req.body || {};
  const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?').get(String(sku || ''));
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

  const ext = TIPOS_FOTO[req.file.mimetype];
  const nombre = `${crypto.randomBytes(12).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(FOTOS_DIR, nombre), req.file.buffer);
  const ruta = `/fotos/${nombre}`;

  if (color) {
    db.prepare(`INSERT INTO fotos_color (producto_id, color, ruta) VALUES (?, ?, ?)
                ON CONFLICT(producto_id, color) DO UPDATE SET ruta = excluded.ruta`)
      .run(producto.id, String(color), ruta);
  } else {
    db.prepare('UPDATE productos SET foto = ? WHERE id = ?').run(ruta, producto.id);
  }
  res.json({ ok: true, ruta });
});

// ── Productos ─────────────────────────────────────────────────────
r.get('/productos', (req, res) => {
  const filas = db.prepare(`
    SELECT p.id, p.sku_agrupador, p.titulo, p.precio, p.visible, p.orden, p.foto,
           c.nombre AS categoria,
           (SELECT COUNT(*) FROM variantes v WHERE v.producto_id = p.id) AS variantes
    FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
    ORDER BY c.nombre, p.orden, p.titulo`).all();
  res.json({ productos: filas });
});

r.put('/productos/:sku', (req, res) => {
  const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?').get(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

  const campos = [];
  const valores = [];
  if (req.body?.precio !== undefined) {
    const p = Number(req.body.precio);
    if (!Number.isFinite(p) || p < 0) return res.status(400).json({ message: 'Precio inválido.' });
    campos.push('precio = ?'); valores.push(p);
  }
  if (req.body?.visible !== undefined) { campos.push('visible = ?'); valores.push(req.body.visible ? 1 : 0); }
  if (req.body?.orden !== undefined) { campos.push('orden = ?'); valores.push(Math.trunc(Number(req.body.orden) || 0)); }
  if (req.body?.titulo !== undefined) { campos.push('titulo = ?'); valores.push(String(req.body.titulo).trim()); }
  if (!campos.length) return res.status(400).json({ message: 'No mandaste nada para cambiar.' });

  valores.push(producto.id);
  db.prepare(`UPDATE productos SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
  res.json({ ok: true });
});

// ── Categorías ────────────────────────────────────────────────────
r.get('/categorias', (req, res) => {
  res.json({ categorias: db.prepare('SELECT * FROM categorias ORDER BY orden, nombre').all() });
});

r.put('/categorias/:id', (req, res) => {
  const campos = [];
  const valores = [];
  if (req.body?.orden !== undefined) { campos.push('orden = ?'); valores.push(Math.trunc(Number(req.body.orden) || 0)); }
  if (req.body?.visible !== undefined) { campos.push('visible = ?'); valores.push(req.body.visible ? 1 : 0); }
  if (!campos.length) return res.status(400).json({ message: 'No mandaste nada para cambiar.' });
  valores.push(Number(req.params.id));
  db.prepare(`UPDATE categorias SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
  res.json({ ok: true });
});

// ── Pedidos ───────────────────────────────────────────────────────
r.get('/pedidos', (req, res) => {
  const filas = db.prepare(`
    SELECT numero, cliente, total, unidades, estado, creado_en, aviso_mail, aviso_whatsapp
    FROM pedidos ORDER BY id DESC LIMIT 200`).all();
  res.json({
    pedidos: filas.map((f) => ({ ...f, cliente: JSON.parse(f.cliente) })),
  });
});

r.get('/pedidos/:numero', (req, res) => {
  const pedido = leerPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ message: 'No existe ese pedido.' });
  res.json({ pedido });
});

r.put('/pedidos/:numero', (req, res) => {
  const estados = ['nuevo', 'preparando', 'enviado', 'cancelado'];
  const estado = String(req.body?.estado || '');
  if (!estados.includes(estado)) return res.status(400).json({ message: 'Ese estado no existe.' });
  const info = db.prepare('UPDATE pedidos SET estado = ? WHERE numero = ?').run(estado, req.params.numero);
  if (!info.changes) return res.status(404).json({ message: 'No existe ese pedido.' });
  res.json({ ok: true });
});

module.exports = { rutas: r, exigirAdmin };
