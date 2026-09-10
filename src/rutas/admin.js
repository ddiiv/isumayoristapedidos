const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const { db, FOTOS_DIR, ordenDeTalle } = require('../db');
const { importarPlanilla } = require('../excel');
const { ordenarCatalogo } = require('../normalizar');
const paleta = require('../colores');
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

/*
 * Veinte fotos por producto.
 *
 * El tope no es capricho: cada foto se descarga en la fila del catálogo y en
 * el panel del producto, y un producto con cincuenta fotos hace que la página
 * tarde para todos, no sólo para quien lo abre. Veinte alcanza para el
 * producto entero más una por color.
 */
const MAX_FOTOS = 20;

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

r.post('/productos/:sku/fotos', subirFoto.single('foto'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Falta la imagen.' });
  const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?').get(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

  const cuantas = db.prepare('SELECT COUNT(*) n FROM fotos WHERE producto_id = ?').get(producto.id).n;
  if (cuantas >= MAX_FOTOS) {
    return res.status(400).json({
      message: `Este producto ya tiene ${MAX_FOTOS} fotos, que es el máximo. Borrá alguna antes de subir otra.`,
    });
  }

  const nombre = `${crypto.randomBytes(12).toString('hex')}${TIPOS_FOTO[req.file.mimetype]}`;
  fs.writeFileSync(path.join(FOTOS_DIR, nombre), req.file.buffer);
  const ruta = `/fotos/${nombre}`;

  const colorId = req.body?.colorId ? Number(req.body.colorId) : null;
  const orden = db.prepare('SELECT COALESCE(MAX(orden), -1) + 1 AS n FROM fotos WHERE producto_id = ?')
    .get(producto.id).n;
  db.prepare('INSERT INTO fotos (producto_id, ruta, color_id, orden) VALUES (?,?,?,?)')
    .run(producto.id, ruta, colorId, orden);

  // La primera que se sube queda como principal: es la que se ve en la fila
  // del catálogo, y sin una elegida la fila sale con el hueco gris.
  if (!cuantas) db.prepare('UPDATE productos SET foto = ? WHERE id = ?').run(ruta, producto.id);

  res.json({ ok: true, ruta, quedan: MAX_FOTOS - cuantas - 1 });
});

r.put('/fotos/:id', (req, res) => {
  const foto = db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(req.params.id));
  if (!foto) return res.status(404).json({ message: 'No existe esa foto.' });

  if (req.body?.colorId !== undefined) {
    const colorId = req.body.colorId === null || req.body.colorId === '' ? null : Number(req.body.colorId);
    db.prepare('UPDATE fotos SET color_id = ? WHERE id = ?').run(colorId, foto.id);
  }
  if (req.body?.orden !== undefined) {
    db.prepare('UPDATE fotos SET orden = ? WHERE id = ?').run(Math.trunc(Number(req.body.orden) || 0), foto.id);
  }
  if (req.body?.principal) {
    db.prepare('UPDATE productos SET foto = ? WHERE id = ?').run(foto.ruta, foto.producto_id);
  }
  res.json({ ok: true });
});

r.delete('/fotos/:id', (req, res) => {
  const foto = db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(req.params.id));
  if (!foto) return res.status(404).json({ message: 'No existe esa foto.' });

  db.prepare('DELETE FROM fotos WHERE id = ?').run(foto.id);

  /*
   * Si era la principal, la reemplaza la primera que quede.
   *
   * Dejando el campo apuntando a un archivo borrado, la fila del catálogo
   * muestra una imagen rota — que se ve peor que no tener foto.
   */
  const producto = db.prepare('SELECT foto FROM productos WHERE id = ?').get(foto.producto_id);
  if (producto?.foto === foto.ruta) {
    const otra = db.prepare('SELECT ruta FROM fotos WHERE producto_id = ? ORDER BY orden LIMIT 1')
      .get(foto.producto_id);
    db.prepare('UPDATE productos SET foto = ? WHERE id = ?').run(otra?.ruta ?? null, foto.producto_id);
  }

  // El archivo se borra del volumen: si no, cada foto reemplazada queda
  // ocupando lugar para siempre y el volumen se llena sin que nadie lo note.
  try { fs.unlinkSync(path.join(FOTOS_DIR, path.basename(foto.ruta))); } catch { /* ya no está */ }

  res.json({ ok: true });
});

// ── Productos ─────────────────────────────────────────────────────
r.get('/productos', (req, res) => {
  const filas = db.prepare(`
    SELECT p.id, p.sku_agrupador, p.titulo, p.precio, p.visible, p.orden, p.foto,
           c.nombre AS categoria,
           (SELECT COUNT(*) FROM variantes v WHERE v.producto_id = p.id) AS variantes,
           (SELECT COUNT(*) FROM fotos f WHERE f.producto_id = p.id) AS fotos,
           p.categoria_id, p.descripcion
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
  if (req.body?.descripcion !== undefined) {
    campos.push('descripcion = ?'); valores.push(String(req.body.descripcion).trim() || null);
  }
  if (req.body?.categoriaId !== undefined) {
    const id = req.body.categoriaId ? Number(req.body.categoriaId) : null;
    if (id && !db.prepare('SELECT id FROM categorias WHERE id = ?').get(id)) {
      return res.status(400).json({ message: 'Esa categoría no existe.' });
    }
    campos.push('categoria_id = ?'); valores.push(id);
  }
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

/*
 * GET /api/admin/productos/:sku — todo lo de un producto en una sola respuesta.
 *
 * La pantalla de edición necesita variantes, fotos y guía a la vez. Pidiendo
 * cada cosa por separado, abrir un producto son cuatro vueltas al servidor y
 * cuatro formas distintas de quedar a medio cargar.
 */
r.get('/productos/:sku', (req, res) => {
  const p = db.prepare(`
    SELECT p.*, c.nombre AS categoria FROM productos p
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.sku_agrupador = ?`).get(req.params.sku);
  if (!p) return res.status(404).json({ message: 'No existe ese producto.' });

  const variantes = db.prepare(`
    SELECT v.id, v.sku, v.precio, v.color_id, v.talle_id,
           COALESCE(co.nombre, v.color) AS color, COALESCE(co.hex, '#cccccc') AS hex,
           COALESCE(t.nombre, v.talle) AS talle, COALESCE(t.orden, v.orden_talle) AS orden_talle
    FROM variantes v
    LEFT JOIN colores co ON co.id = v.color_id
    LEFT JOIN talles  t  ON t.id  = v.talle_id
    WHERE v.producto_id = ?
    ORDER BY color, orden_talle`).all(p.id);

  const fotos = db.prepare(`
    SELECT f.id, f.ruta, f.orden, f.color_id, c.nombre AS color
    FROM fotos f LEFT JOIN colores c ON c.id = f.color_id
    WHERE f.producto_id = ? ORDER BY f.orden`).all(p.id);

  /*
   * Los colores y talles de ESTE producto, no los del catálogo entero.
   *
   * La lista para asignarle un color a una foto tiene que ofrecer sólo los
   * colores que el producto tiene: con los treinta y seis del catálogo, se
   * puede etiquetar la foto de un pantalón negro como "Salmon" y esa foto no
   * se muestra nunca, sin ningún error que lo avise.
   */
  const coloresDelProducto = [...new Map(
    variantes.filter((v) => v.color_id).map((v) => [v.color_id, { id: v.color_id, nombre: v.color, hex: v.hex }]),
  ).values()];
  const tallesDelProducto = [...new Map(
    variantes.filter((v) => v.talle_id).map((v) => [v.talle_id, { id: v.talle_id, nombre: v.talle, orden: v.orden_talle }]),
  ).values()].sort((a, b) => a.orden - b.orden);

  res.json({
    producto: {
      ...p,
      guia_talles: p.guia_talles ? JSON.parse(p.guia_talles) : null,
      esPrincipal: p.foto,
    },
    variantes,
    fotos,
    colores: coloresDelProducto,
    talles: tallesDelProducto,
    maxFotos: MAX_FOTOS,
  });
});

/*
 * PUT /api/admin/productos/:sku/guia — la guía de medidas de ESTE producto.
 *
 * Las medidas cambian por producto: un talle M no mide lo mismo en una remera
 * que en una campera. Una tabla general serviría para adivinar y no para
 * decidir, que es lo que el cliente necesita hacer antes de pedir cincuenta
 * unidades y descubrir que le quedan chicas.
 */
r.put('/productos/:sku/guia', (req, res) => {
  const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?').get(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

  const guia = req.body?.guia;
  if (guia === null || guia === undefined || !guia.filas?.length) {
    db.prepare('UPDATE productos SET guia_talles = NULL WHERE id = ?').run(producto.id);
    return res.json({ ok: true, guia: null });
  }

  const columnas = (guia.columnas || []).map((c) => String(c).trim()).filter(Boolean);
  if (!columnas.length) return res.status(400).json({ message: 'Poné al menos una medida (ancho, largo…).' });

  const filas = guia.filas
    .map((f) => {
      const limpia = { talle: String(f.talle || '').trim() };
      for (const c of columnas) limpia[c] = String(f[c] ?? '').trim();
      return limpia;
    })
    .filter((f) => f.talle);
  if (!filas.length) return res.status(400).json({ message: 'Poné al menos un talle.' });

  const limpia = { columnas, filas, nota: String(guia.nota || '').trim() || null };
  db.prepare('UPDATE productos SET guia_talles = ? WHERE id = ?').run(JSON.stringify(limpia), producto.id);
  res.json({ ok: true, guia: limpia });
});

/*
 * PUT /api/admin/variantes — cambios en masa.
 *
 * Subir un 15 % a una categoría entera, o poner precio propio a todas las
 * variantes de un color, producto por producto son doscientos clics. Se aplica
 * sobre un filtro explícito y se contesta cuántas cambiaron: un cambio masivo
 * que no dice cuánto tocó es un cambio que hay que ir a verificar a mano.
 */
r.put('/variantes', (req, res) => {
  const { categoriaId, colorId, talleId, skuAgrupador } = req.body || {};
  const condiciones = ['1 = 1'];
  const params = [];

  if (skuAgrupador) {
    condiciones.push('v.producto_id = (SELECT id FROM productos WHERE sku_agrupador = ?)');
    params.push(String(skuAgrupador));
  }
  if (categoriaId) {
    condiciones.push('v.producto_id IN (SELECT id FROM productos WHERE categoria_id = ?)');
    params.push(Number(categoriaId));
  }
  if (colorId) { condiciones.push('v.color_id = ?'); params.push(Number(colorId)); }
  if (talleId) { condiciones.push('v.talle_id = ?'); params.push(Number(talleId)); }

  if (condiciones.length === 1) {
    /*
     * Sin ningún filtro, esto tocaría las 2356 variantes del catálogo. Un
     * cambio de ese tamaño tiene que pedirse a propósito, no salir de un
     * formulario que quedó vacío.
     */
    return res.status(400).json({ message: 'Elegí al menos un filtro: categoría, producto, color o talle.' });
  }
  const donde = condiciones.join(' AND ');

  // ── Qué se hace con el precio
  const accion = String(req.body?.accion || '');
  let sql;
  if (accion === 'fijar') {
    const precio = Number(req.body.valor);
    if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ message: 'Precio inválido.' });
    sql = db.prepare(`UPDATE variantes SET precio = ${precio} WHERE id IN (SELECT v.id FROM variantes v WHERE ${donde})`);
  } else if (accion === 'porcentaje') {
    const pct = Number(req.body.valor);
    if (!Number.isFinite(pct)) return res.status(400).json({ message: 'Porcentaje inválido.' });
    /*
     * El porcentaje se aplica sobre el precio EFECTIVO: el propio de la
     * variante si lo tiene, y si no el del producto. Aplicándolo sólo sobre
     * `precio`, las variantes que heredan quedarían en nulo y el aumento no
     * les llegaría — que es justamente la mayoría.
     */
    sql = db.prepare(`
      UPDATE variantes SET precio = ROUND(
        COALESCE(precio, (SELECT p.precio FROM productos p WHERE p.id = variantes.producto_id)) * ${1 + pct / 100}
      ) WHERE id IN (SELECT v.id FROM variantes v WHERE ${donde})`);
  } else if (accion === 'heredar') {
    // Vuelven a seguir el precio del producto padre.
    sql = db.prepare(`UPDATE variantes SET precio = NULL WHERE id IN (SELECT v.id FROM variantes v WHERE ${donde})`);
  } else {
    return res.status(400).json({ message: 'Decí qué hacer: fijar, porcentaje o heredar.' });
  }

  const info = sql.run(...params);
  res.json({ ok: true, cambiadas: info.changes });
});

/** Cuántas variantes tocaría un filtro, para mostrarlo antes de aplicar. */
r.post('/variantes/contar', (req, res) => {
  const { categoriaId, colorId, talleId, skuAgrupador } = req.body || {};
  const condiciones = ['1 = 1'];
  const params = [];
  if (skuAgrupador) {
    condiciones.push('v.producto_id = (SELECT id FROM productos WHERE sku_agrupador = ?)');
    params.push(String(skuAgrupador));
  }
  if (categoriaId) {
    condiciones.push('v.producto_id IN (SELECT id FROM productos WHERE categoria_id = ?)');
    params.push(Number(categoriaId));
  }
  if (colorId) { condiciones.push('v.color_id = ?'); params.push(Number(colorId)); }
  if (talleId) { condiciones.push('v.talle_id = ?'); params.push(Number(talleId)); }

  const n = db.prepare(`SELECT COUNT(*) n FROM variantes v WHERE ${condiciones.join(' AND ')}`).get(...params).n;
  res.json({ variantes: n, sinFiltro: condiciones.length === 1 });
});

/*
 * PUT /api/admin/variantes/:id — el precio de UNA variante.
 *
 * Los talles grandes —3XL, 4XL, 5XL— y el ÚNICO suelen costar más porque
 * llevan más tela, y eso cambia por producto. Con el precio sólo en el
 * producto padre, la única salida sería crear un producto aparte por talle,
 * que parte el catálogo y rompe la curva.
 *
 * Vacío o nulo = vuelve a seguir el precio del producto.
 */
r.put('/variantes/:id', (req, res) => {
  const variante = db.prepare('SELECT * FROM variantes WHERE id = ?').get(Number(req.params.id));
  if (!variante) return res.status(404).json({ message: 'No existe esa variante.' });

  const bruto = req.body?.precio;
  if (bruto === null || bruto === undefined || bruto === '') {
    db.prepare('UPDATE variantes SET precio = NULL WHERE id = ?').run(variante.id);
    return res.json({ ok: true, precio: null });
  }
  const precio = Number(bruto);
  if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ message: 'Precio inválido.' });
  db.prepare('UPDATE variantes SET precio = ? WHERE id = ?').run(precio, variante.id);
  res.json({ ok: true, precio });
});

/*
 * PUT /api/admin/productos/:sku/precio-talles — un precio para varios talles.
 *
 * El caso concreto: "en este producto, del 3XL para arriba sale dos mil pesos
 * más". Hacerlo variante por variante son doce clics por producto, y de esos
 * doce alguno se olvida — y el que se olvida sale barato hasta que alguien lo
 * nota en la facturación.
 */
r.put('/productos/:sku/precio-talles', (req, res) => {
  const producto = db.prepare('SELECT * FROM productos WHERE sku_agrupador = ?').get(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

  const talles = Array.isArray(req.body?.talles) ? req.body.talles.map(String) : [];
  if (!talles.length) return res.status(400).json({ message: 'Elegí al menos un talle.' });

  const marcas = talles.map(() => '?').join(',');
  const bruto = req.body?.precio;

  if (bruto === null || bruto === undefined || bruto === '') {
    const info = db.prepare(`
      UPDATE variantes SET precio = NULL
      WHERE producto_id = ? AND talle_id IN (SELECT id FROM talles WHERE nombre IN (${marcas}))`)
      .run(producto.id, ...talles);
    return res.json({ ok: true, cambiadas: info.changes, precio: null });
  }

  const precio = Number(bruto);
  if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ message: 'Precio inválido.' });
  const info = db.prepare(`
    UPDATE variantes SET precio = ?
    WHERE producto_id = ? AND talle_id IN (SELECT id FROM talles WHERE nombre IN (${marcas}))`)
    .run(precio, producto.id, ...talles);

  res.json({ ok: true, cambiadas: info.changes, precio });
});

// ── Colores ───────────────────────────────────────────────────────
/*
 * Los colores se administran acá porque el catálogo llega con el mismo color
 * escrito de varias formas. Unificarlos a mano una vez vale más que cualquier
 * regla automática: quien carga la planilla sabe si "Moliné" y "Melange" son
 * lo mismo, y el importador no.
 */
r.get('/colores', (req, res) => {
  const filas = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM variantes v WHERE v.color_id = c.id) AS variantes
    FROM colores c ORDER BY c.provisorio DESC, variantes DESC, c.nombre`).all();
  /*
   * Se marca cuáles están fuera de los veinte oficiales.
   *
   * No se unen solos: "Azul Marino" no es "Azul" y "Gris Topo" no es "Topo".
   * Unirlos por parecido sería decidir por el negocio qué color le llega al
   * cliente. Se marcan y se resuelven acá, a la vista.
   */
  res.json({
    colores: filas.map((c) => ({ ...c, oficial: paleta.esOficial(c.nombre) })),
    oficiales: paleta.OFICIALES,
  });
});

const HEX_VALIDO = /^#[0-9a-fA-F]{6}$/;

r.post('/colores', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const hex = String(req.body?.hex || '').trim();
  if (!nombre) return res.status(400).json({ message: 'Poné un nombre.' });
  if (!HEX_VALIDO.test(hex)) return res.status(400).json({ message: 'El color tiene que ser un hex tipo #1a2b3c.' });
  if (db.prepare('SELECT id FROM colores WHERE nombre = ?').get(nombre)) {
    return res.status(409).json({ message: 'Ya existe un color con ese nombre.' });
  }
  db.prepare('INSERT INTO colores (nombre, hex, provisorio, orden) VALUES (?, ?, 0, 0)').run(nombre, hex);
  res.status(201).json({ ok: true });
});

r.put('/colores/:id', (req, res) => {
  const color = db.prepare('SELECT * FROM colores WHERE id = ?').get(Number(req.params.id));
  if (!color) return res.status(404).json({ message: 'No existe ese color.' });

  const campos = [];
  const valores = [];

  if (req.body?.hex !== undefined) {
    const hex = String(req.body.hex).trim();
    if (!HEX_VALIDO.test(hex)) return res.status(400).json({ message: 'El color tiene que ser un hex tipo #1a2b3c.' });
    // Tocar el color lo saca de "provisorio": alguien lo miró y lo decidió.
    campos.push('hex = ?', 'provisorio = 0'); valores.push(hex);
  }
  if (req.body?.orden !== undefined) { campos.push('orden = ?'); valores.push(Math.trunc(Number(req.body.orden) || 0)); }

  if (req.body?.nombre !== undefined) {
    const nombre = String(req.body.nombre).trim();
    if (!nombre) return res.status(400).json({ message: 'Poné un nombre.' });

    const otro = db.prepare('SELECT * FROM colores WHERE nombre = ? AND id <> ?').get(nombre, color.id);
    if (otro) {
      /*
       * Renombrar a uno que ya existe = unirlos.
       *
       * Es la operación que más hace falta con este catálogo, y hacerla con un
       * "unir" aparte obligaría a elegir dos colores de una lista de treinta.
       * Renombrando "Negra" a "Negro" se dice lo mismo con lo que ya se tiene
       * en la mano.
       */
      const unir = db.transaction(() => {
        db.prepare('UPDATE variantes SET color_id = ? WHERE color_id = ?').run(otro.id, color.id);
        db.prepare('UPDATE fotos SET color_id = ? WHERE color_id = ?').run(otro.id, color.id);
        db.prepare('DELETE FROM colores WHERE id = ?').run(color.id);
      });
      unir();
      return res.json({ ok: true, accion: 'unido', con: otro.nombre });
    }
    campos.push('nombre = ?'); valores.push(nombre);
  }

  if (!campos.length) return res.status(400).json({ message: 'No mandaste nada para cambiar.' });
  valores.push(color.id);
  db.prepare(`UPDATE colores SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
  res.json({ ok: true, accion: 'guardado' });
});

r.delete('/colores/:id', (req, res) => {
  const id = Number(req.params.id);
  const usos = db.prepare('SELECT COUNT(*) n FROM variantes WHERE color_id = ?').get(id).n;
  if (usos) {
    /*
     * No se borra un color que están usando variantes.
     *
     * Borrarlo dejaría esas variantes sin color: el cliente vería una fila sin
     * cuadrito ni nombre y no sabría qué está pidiendo. Para sacarlo del medio
     * hay que unirlo a otro, que es lo que se quería hacer en realidad.
     */
    return res.status(409).json({
      message: `Ese color lo usan ${usos} variantes. Renombralo al color con el que se tenga que unir en vez de borrarlo.`,
    });
  }
  db.prepare('DELETE FROM colores WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── Talles ────────────────────────────────────────────────────────
r.get('/talles', (req, res) => {
  const talles = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM variantes v WHERE v.talle_id = t.id) AS variantes
    FROM talles t ORDER BY t.grupo, t.orden`).all();
  res.json({ talles });
});

r.post('/talles', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim().toUpperCase();
  const grupo = req.body?.grupo === 'nino' ? 'nino' : 'adulto';
  if (!nombre) return res.status(400).json({ message: 'Poné un talle.' });
  if (db.prepare('SELECT id FROM talles WHERE nombre = ?').get(nombre)) {
    return res.status(409).json({ message: 'Ese talle ya existe.' });
  }
  db.prepare('INSERT INTO talles (nombre, grupo, orden) VALUES (?,?,?)')
    .run(nombre, grupo, ordenDeTalle(nombre));
  res.status(201).json({ ok: true });
});

r.put('/talles/:id', (req, res) => {
  const talle = db.prepare('SELECT * FROM talles WHERE id = ?').get(Number(req.params.id));
  if (!talle) return res.status(404).json({ message: 'No existe ese talle.' });

  const campos = [];
  const valores = [];
  if (req.body?.grupo !== undefined) {
    campos.push('grupo = ?'); valores.push(req.body.grupo === 'nino' ? 'nino' : 'adulto');
  }
  if (req.body?.orden !== undefined) { campos.push('orden = ?'); valores.push(Math.trunc(Number(req.body.orden) || 0)); }
  if (!campos.length) return res.status(400).json({ message: 'No mandaste nada para cambiar.' });
  valores.push(talle.id);
  db.prepare(`UPDATE talles SET ${campos.join(', ')} WHERE id = ?`).run(...valores);
  res.json({ ok: true });
});

r.delete('/talles/:id', (req, res) => {
  const id = Number(req.params.id);
  const usos = db.prepare('SELECT COUNT(*) n FROM variantes WHERE talle_id = ?').get(id).n;
  if (usos) {
    return res.status(409).json({ message: `Ese talle lo usan ${usos} variantes. No se puede borrar.` });
  }
  db.prepare('DELETE FROM talles WHERE id = ?').run(id);
  res.json({ ok: true });
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
/*
 * GET /api/admin/pedidos — el historial, con filtros.
 *
 * "Los últimos doscientos" alcanza para mirar el día de hoy y para nada más.
 * Un historial sirve cuando se puede preguntarle algo: qué pidió este cliente
 * en marzo, cuánto se vendió el mes pasado, qué quedó sin despachar. Por eso
 * filtra por fecha, cliente y estado, y devuelve los totales de lo filtrado —
 * si no, hay que sumarlos a mano en la pantalla.
 */
r.get('/pedidos', (req, res) => {
  const condiciones = ['1 = 1'];
  const params = [];

  if (req.query.desde) { condiciones.push('creado_en >= ?'); params.push(String(req.query.desde)); }
  // Hasta el FINAL del día pedido: con `<= '2026-03-15'` no entra ningún
  // pedido de ese día, porque todos tienen hora después de medianoche.
  if (req.query.hasta) { condiciones.push('creado_en <= ?'); params.push(`${String(req.query.hasta)}T23:59:59.999Z`); }
  if (req.query.estado) { condiciones.push('estado = ?'); params.push(String(req.query.estado)); }
  if (req.query.clienteId) { condiciones.push('cliente_id = ?'); params.push(Number(req.query.clienteId)); }
  if (req.query.buscar) {
    // Busca en el número y en los datos del cliente, que es como se acuerda
    // la gente: "el pedido de Gutiérrez", no "el ISU-000042".
    condiciones.push('(numero LIKE ? OR cliente LIKE ?)');
    const like = `%${String(req.query.buscar)}%`;
    params.push(like, like);
  }
  const donde = condiciones.join(' AND ');
  const limite = Math.min(Number(req.query.limite) || 200, 1000);

  const filas = db.prepare(`
    SELECT id, numero, cliente, items, total, unidades, estado, creado_en,
           aviso_mail, aviso_whatsapp, cliente_id
    FROM pedidos WHERE ${donde} ORDER BY id DESC LIMIT ${limite}`).all(...params);

  const totales = db.prepare(`
    SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS facturado,
           COALESCE(SUM(unidades), 0) AS unidades
    FROM pedidos WHERE ${donde}`).get(...params);

  res.json({
    pedidos: filas.map((f) => ({
      ...f,
      cliente: JSON.parse(f.cliente),
      items: JSON.parse(f.items),
    })),
    totales,
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
