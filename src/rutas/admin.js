const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const { db, FOTOS_DIR } = require('../db');
const { importarPlanilla } = require('../excel');
const { ordenarCatalogo } = require('../normalizar');
const { leerPedido } = require('../pedidos');
const auth = require('../auth');

const r = express.Router();

/*
 * El panel del dueño.
 *
 * La sesión y el rol los maneja `src/auth.js`, que es el mismo camino por el
 * que entran los clientes: hay una sola puerta y un solo lugar donde se decide
 * quién es quién. Cuando esto tenía su propio login, había dos formas de estar
 * autenticado y dos lugares donde arreglar lo mismo.
 */
r.use(auth.exigirAdmin);

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

    /*
     * Ordenar el catálogo es parte de importar, no un paso aparte.
     *
     * Los colores repetidos, los talles en minúscula, las categorías con
     * tipeos y los productos de OFERTA vuelven con cada planilla nueva: es la
     * misma fuente. Dejándolo como un script que alguien corre después, la
     * primera importación que se haga sin acordarse devuelve el catálogo al
     * desorden y nadie relaciona una cosa con la otra.
     */
    const orden = ordenarCatalogo();
    res.json({ ok: true, resumen: { ...resumen, ...orden } });
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

/*
 * PUT /api/admin/categorias/:id/nombre — renombrar, y unir si el nombre ya existe.
 *
 * El catálogo real viene con categorías repetidas por tipeo —"Panalones" al
 * lado de "Pantalones", "Short" al lado de "Shorts"—, y cada una aparece como
 * una pestaña suelta con un producto adentro. No se unen solas al importar:
 * eso sería adivinar cuál quiso escribir la persona, y el día que se equivoque
 * la corrección estaría escondida en el importador. Se hace acá, a mano, y se
 * ve lo que pasa.
 */
r.put('/categorias/:id/nombre', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ message: 'Poné un nombre.' });

  const actual = db.prepare('SELECT * FROM categorias WHERE id = ?').get(Number(req.params.id));
  if (!actual) return res.status(404).json({ message: 'No existe esa categoría.' });

  const destino = db.prepare('SELECT * FROM categorias WHERE nombre = ? AND id <> ?')
    .get(nombre, actual.id);

  if (!destino) {
    db.prepare('UPDATE categorias SET nombre = ? WHERE id = ?').run(nombre, actual.id);
    return res.json({ ok: true, accion: 'renombrada' });
  }

  // Ya existe una con ese nombre: se mueven los productos y se borra la vacía.
  const mover = db.transaction(() => {
    db.prepare('UPDATE productos SET categoria_id = ? WHERE categoria_id = ?').run(destino.id, actual.id);
    db.prepare('DELETE FROM categorias WHERE id = ?').run(actual.id);
  });
  mover();
  res.json({ ok: true, accion: 'unida', destino: destino.nombre });
});

// ── Clientes ──────────────────────────────────────────────────────
r.get('/clientes', (req, res) => {
  const filas = db.prepare(`
    SELECT c.id, c.email, c.nombre, c.cuit, c.telefono, c.provincia, c.ciudad,
           c.activo, c.creado_en, c.ultimo_acceso,
           (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id) AS pedidos
    FROM clientes c ORDER BY c.id DESC`).all();
  res.json({ clientes: filas });
});

r.put('/clientes/:id', (req, res) => {
  if (req.body?.activo === undefined) {
    return res.status(400).json({ message: 'No mandaste nada para cambiar.' });
  }
  const info = db.prepare('UPDATE clientes SET activo = ? WHERE id = ?')
    .run(req.body.activo ? 1 : 0, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ message: 'No existe ese cliente.' });
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

module.exports = { rutas: r };
