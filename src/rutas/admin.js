const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const {
  db, FOTOS_DIR, ordenDeTalle,
  ESTADOS, normalizarEstado, puedePasar, registrarEstado, historialDePedido,
} = require('../db');
const { hacerMiniatura, hacerMedia, nombreMiniatura, nombreMedia } = require('../miniaturas');
const { pdfPedido } = require('../pdf');
const { avisarCliente } = require('../notificaciones');
const whatsapp = require('../whatsapp');
const eventos = require('../eventos');
const stocker = require('../stocker');
const { seVeEnCuenta } = require('../clientes');
const { importarPlanilla } = require('../excel');
const { ordenarCatalogo } = require('../normalizar');
const paleta = require('../colores');
const { leerPedido, armarPedido } = require('../pedidos');
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
  /*
   * Sólo .xlsx, y se mira antes de cargarlo en memoria.
   *
   * Sin esto se aceptaba cualquier archivo de hasta quince megas y recién
   * exceljs, al no poder abrirlo, avisaba que no era una planilla: para ese
   * momento ya estaba entero en la memoria del proceso. Es una ruta del
   * administrador, así que no es una puerta abierta, pero un archivo
   * equivocado —un PDF, un .zip de fotos— no tiene por qué llegar tan lejos.
   * La prueba de que es una planilla de verdad la sigue haciendo exceljs.
   */
  fileFilter: (req, file, listo) => {
    if (/\.xlsx$/i.test(file.originalname || '')) return listo(null, true);
    listo(Object.assign(new Error('Tiene que ser el .xlsx que exporta STOCKER.'), { status: 400 }));
  },
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

/*
 * Hasta cinco fotos por color, y el producto crece con sus colores.
 *
 * Veinte alcanza para un producto de pocos colores, pero una remera en doce
 * colores quedaría con una o dos fotos por color, que no alcanza para ver cómo
 * es cada uno. La regla del negocio es cinco por color: el tope del producto
 * es 20, o cinco por cada color que vende si eso da más.
 */
const MAX_POR_COLOR = 5;

function topeDeFotos(productoId) {
  const colores = db.prepare(
    'SELECT COUNT(DISTINCT color_id) n FROM variantes WHERE producto_id = ? AND color_id IS NOT NULL',
  ).get(productoId).n;
  return Math.max(MAX_FOTOS, MAX_POR_COLOR * colores);
}

const fotosDelColor = (productoId, colorId) => db.prepare(
  'SELECT COUNT(*) n FROM fotos WHERE producto_id = ? AND color_id = ?',
).get(productoId, colorId).n;

/*
 * Hasta treinta fotos por tanda.
 *
 * Cargar un producto de doce colores de a una foto son veinte vueltas de elegir
 * archivo, esperar y repetir. De a tanda se eligen todas juntas y el panel dice
 * qué entró y qué no.
 *
 * Este tope es el de la TANDA, no el del producto: las que no entran por el
 * máximo del producto o de un color se rechazan una por una, con el motivo, y
 * las demás de la misma tanda entran igual.
 */
const MAX_POR_TANDA = 30;

const subirFoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: MAX_POR_TANDA },
  fileFilter: (req, file, cb) => {
    // Se mira el tipo declarado Y se renombra con nuestra extensión: un archivo
    // llamado "foto.php" servido desde el volumen es un problema de otra clase.
    if (!TIPOS_FOTO[file.mimetype]) return cb(Object.assign(new Error('Sólo JPG, PNG o WebP.'), { status: 400 }));
    cb(null, true);
  },
});

/*
 * Se aceptan los dos nombres de campo: `fotos` para la tanda y `foto` para una
 * sola, que es como lo mandaba el panel antes. Los errores de multer se
 * traducen acá: "Too many files" no le dice nada a nadie.
 */
const recibirFotos = (req, res, next) => subirFoto.fields([
  { name: 'fotos', maxCount: MAX_POR_TANDA },
  { name: 'foto', maxCount: MAX_POR_TANDA },
])(req, res, (e) => {
  if (e?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ message: `De a ${MAX_POR_TANDA} fotos por vez como máximo.` });
  }
  if (e?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'Cada foto puede pesar hasta 6 MB.' });
  }
  if (e?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ message: 'Mandá las fotos en el campo "fotos".' });
  }
  return next(e);
});

r.post('/productos/:sku/fotos', recibirFotos, async (req, res, next) => {
  try {
    const archivos = [...(req.files?.fotos || []), ...(req.files?.foto || [])];
    if (!archivos.length) return res.status(400).json({ message: 'Falta la imagen.' });

    const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?').get(req.params.sku);
    if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });

    // El color vale para toda la tanda: se eligen juntas las fotos de un color.
    const colorId = req.body?.colorId ? Number(req.body.colorId) : null;
    const tope = topeDeFotos(producto.id);
    let cuantas = db.prepare('SELECT COUNT(*) n FROM fotos WHERE producto_id = ?').get(producto.id).n;
    let enElColor = colorId ? fotosDelColor(producto.id, colorId) : 0;

    const subidas = [];
    const rechazadas = [];

    for (const archivo of archivos) {
      const nombreOriginal = String(archivo.originalname || 'foto').slice(0, 80);

      // Los topes se miran foto por foto y no al principio: dentro de la misma
      // tanda pueden entrar las primeras y no las últimas.
      if (cuantas >= tope) {
        rechazadas.push({ nombre: nombreOriginal, motivo: `el producto llegó a su máximo de ${tope} fotos` });
        continue;
      }
      if (colorId && enElColor >= MAX_POR_COLOR) {
        rechazadas.push({ nombre: nombreOriginal, motivo: `ese color ya tiene ${MAX_POR_COLOR} fotos` });
        continue;
      }

      /*
       * Las versiones chicas se hacen ANTES de escribir nada. Si sharp no puede
       * abrir el archivo, no es una imagen aunque el navegador diga que sí, y no
       * tiene que quedar ocupando el volumen.
       */
      let mini;
      let media;
      try {
        mini = await hacerMiniatura(archivo.buffer);
        media = await hacerMedia(archivo.buffer);
      } catch {
        rechazadas.push({ nombre: nombreOriginal, motivo: 'no es una imagen que se pueda abrir' });
        continue;
      }

      const nombre = `${crypto.randomBytes(12).toString('hex')}${TIPOS_FOTO[archivo.mimetype]}`;
      const nombreMini = nombreMiniatura(nombre);
      const nombreMed = nombreMedia(nombre);
      fs.writeFileSync(path.join(FOTOS_DIR, nombre), archivo.buffer);
      fs.writeFileSync(path.join(FOTOS_DIR, nombreMini), mini);
      fs.writeFileSync(path.join(FOTOS_DIR, nombreMed), media);

      const ruta = `/fotos/${nombre}`;
      const miniatura = `/fotos/${nombreMini}`;
      const rutaMedia = `/fotos/${nombreMed}`;
      const orden = db.prepare('SELECT COALESCE(MAX(orden), -1) + 1 AS n FROM fotos WHERE producto_id = ?')
        .get(producto.id).n;
      db.prepare('INSERT INTO fotos (producto_id, ruta, color_id, orden, miniatura, media) VALUES (?,?,?,?,?,?)')
        .run(producto.id, ruta, colorId, orden, miniatura, rutaMedia);

      // La primera de todas queda como principal: es la que se ve en la fila del
      // catálogo, y sin una elegida la fila sale con el hueco gris.
      if (!cuantas) db.prepare('UPDATE productos SET foto = ? WHERE id = ?').run(ruta, producto.id);

      cuantas += 1;
      if (colorId) enElColor += 1;
      subidas.push({ nombre: nombreOriginal, ruta, miniatura, media: rutaMedia });
    }

    /*
     * Si no entró ninguna es un error del pedido y se contesta 400 con el motivo
     * de la primera, que es lo que esperaba quien subía una sola foto.
     */
    if (!subidas.length) {
      return res.status(400).json({
        message: rechazadas[0] ? `No se pudo subir: ${rechazadas[0].motivo}.` : 'No se pudo subir ninguna foto.',
        rechazadas,
      });
    }

    res.json({
      ok: true,
      subidas,
      rechazadas,
      quedan: Math.max(0, tope - cuantas),
      // De a una, la respuesta sigue siendo la de antes.
      ruta: subidas[0].ruta,
      miniatura: subidas[0].miniatura,
      media: subidas[0].media,
    });
  } catch (e) { next(e); }
});

r.put('/fotos/:id', (req, res) => {
  const foto = db.prepare('SELECT * FROM fotos WHERE id = ?').get(Number(req.params.id));
  if (!foto) return res.status(404).json({ message: 'No existe esa foto.' });

  if (req.body?.colorId !== undefined) {
    const colorId = req.body.colorId === null || req.body.colorId === '' ? null : Number(req.body.colorId);
    // Cambiarle el color a una foto es la otra forma de pasarse de cinco en un color.
    if (colorId && colorId !== foto.color_id && fotosDelColor(foto.producto_id, colorId) >= MAX_POR_COLOR) {
      return res.status(400).json({ message: `Ese color ya tiene ${MAX_POR_COLOR} fotos.` });
    }
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
  for (const version of [foto.miniatura, foto.media].filter(Boolean)) {
    try { fs.unlinkSync(path.join(FOTOS_DIR, path.basename(version))); } catch { /* ya no está */ }
  }

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
  /*
   * Modelo nuevo de verdad, o viejo recién cargado.
   *
   * La fecha de alta la pone la plataforma sola, pero no sabe si el modelo es
   * nuevo o si estaba hace años en el negocio y recién ahora entró acá. Eso lo
   * dice una persona: 1 = modelo nuevo · 0 = ya existía · nulo = sin clasificar.
   */
  if (req.body?.novedad !== undefined) {
    const v = req.body.novedad === null ? null : Number(req.body.novedad);
    if (v !== null && v !== 0 && v !== 1) {
      return res.status(400).json({ message: 'La novedad es 1 (modelo nuevo), 0 (ya existía) o nula.' });
    }
    campos.push('novedad = ?'); valores.push(v);
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
    SELECT f.id, f.ruta, f.orden, f.color_id, f.miniatura, c.nombre AS color
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
    maxFotos: topeDeFotos(p.id),
    maxPorTanda: MAX_POR_TANDA,
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
// ── Los colores de un producto ───────────────────────────────────
/*
 * Cambiar, agregar o quitar un color de UN producto, con todos sus talles.
 *
 * La planilla a veces trae un color mal cargado —la remera verde como "azul"—
 * y corregirlo variante por variante son nueve cambios por color, de los que
 * alguno se olvida y queda un talle suelto del color equivocado. Acá se toca el
 * color entero del producto de una vez.
 *
 * Y tiene que sobrevivir a la próxima importación, porque la planilla sigue
 * diciendo lo que decía: un color cambiado queda marcado como puesto a mano y
 * el importador no lo pisa; uno quitado queda anotado y no se vuelve a crear.
 */
const productoPorSku = (sku) => db.prepare('SELECT * FROM productos WHERE sku_agrupador = ?').get(sku);
const colorPorId = (id) => db.prepare('SELECT * FROM colores WHERE id = ?').get(Number(id));
const variantesDelColor = (productoId, colorId) => db.prepare(`
  SELECT v.*, COALESCE(t.nombre, v.talle) AS talle_nombre
  FROM variantes v LEFT JOIN talles t ON t.id = v.talle_id
  WHERE v.producto_id = ? AND v.color_id = ?`).all(productoId, colorId);

/*
 * Las fotos de un color que se mueve van con él, hasta las cinco que admite
 * un color. Las que no entran —o todas, si el color se quita— pasan a
 * generales: se siguen viendo en "todas" y no se pierde ninguna.
 */
function moverFotosDeColor(productoId, desde, hacia) {
  const fotos = db.prepare('SELECT id FROM fotos WHERE producto_id = ? AND color_id = ? ORDER BY orden')
    .all(productoId, desde);
  let lugar = hacia ? MAX_POR_COLOR - fotosDelColor(productoId, hacia) : 0;
  const poner = db.prepare('UPDATE fotos SET color_id = ? WHERE id = ?');
  const resultado = { movidas: 0, generales: 0 };
  for (const f of fotos) {
    if (lugar > 0) { poner.run(hacia, f.id); lugar -= 1; resultado.movidas += 1; } else { poner.run(null, f.id); resultado.generales += 1; }
  }
  return resultado;
}

// El SKU de una variante creada acá, con la misma forma que los de STOCKER: ISUABEPAN + AZU + L.
const codigoDeColor = (nombre) => String(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'COL';

// PUT /api/admin/productos/:sku/colores/:colorId — { nuevoColorId }: el color entero pasa a otro.
r.put('/productos/:sku/colores/:colorId', (req, res) => {
  const producto = productoPorSku(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });
  const actual = colorPorId(req.params.colorId);
  const nuevo = colorPorId(req.body?.nuevoColorId);
  if (!actual || !nuevo) return res.status(400).json({ message: 'Elegí a qué color cambiarlo.' });
  if (actual.id === nuevo.id) return res.status(400).json({ message: 'Es el mismo color.' });

  const mover = variantesDelColor(producto.id, actual.id);
  if (!mover.length) return res.status(404).json({ message: 'Este producto no tiene ese color.' });

  /*
   * Si el color nuevo ya está en el producto con alguno de esos talles, se
   * frena: quedarían dos variantes del mismo color y talle, dos SKU para lo
   * mismo, y el pedido no sabría cuál descontar.
   */
  const yaEstan = new Set(variantesDelColor(producto.id, nuevo.id).map((v) => v.talle_nombre));
  const choque = mover.filter((v) => yaEstan.has(v.talle_nombre)).map((v) => v.talle_nombre);
  if (choque.length) {
    return res.status(409).json({
      message: `El producto ya tiene ${nuevo.nombre} en ${choque.join(', ')}. Quitá uno de los dos antes, así no quedan dos variantes del mismo color y talle.`,
    });
  }

  const fotos = db.transaction(() => {
    db.prepare('UPDATE variantes SET color_id = ?, color = ?, color_manual = 1 WHERE producto_id = ? AND color_id = ?')
      .run(nuevo.id, nuevo.nombre, producto.id, actual.id);
    return moverFotosDeColor(producto.id, actual.id, nuevo.id);
  })();
  res.json({ ok: true, variantes: mover.length, fotos });
});

// POST /api/admin/productos/:sku/colores — { colorId, talles? }: un color nuevo en el producto.
r.post('/productos/:sku/colores', (req, res) => {
  const producto = productoPorSku(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });
  const color = colorPorId(req.body?.colorId);
  if (!color) return res.status(400).json({ message: 'Elegí qué color agregar.' });
  if (variantesDelColor(producto.id, color.id).length) {
    return res.status(409).json({ message: `El producto ya tiene ${color.nombre}.` });
  }

  /*
   * Una variante por talle del producto, con el precio que ese talle ya tiene
   * en los otros colores: si del 3XL para arriba sale más caro, el color nuevo
   * también. Un precio vacío sigue siendo "el del producto".
   */
  const porTalle = new Map();
  for (const v of db.prepare(`
    SELECT v.*, COALESCE(t.nombre, v.talle) AS talle_nombre
    FROM variantes v LEFT JOIN talles t ON t.id = v.talle_id
    WHERE v.producto_id = ? ORDER BY v.id`).all(producto.id)) {
    if (!porTalle.has(v.talle_nombre)) porTalle.set(v.talle_nombre, v);
  }
  const pedidos = Array.isArray(req.body?.talles) && req.body.talles.length ? req.body.talles.map(String) : [...porTalle.keys()];
  const talles = pedidos.filter((t) => porTalle.has(t));
  if (!talles.length) return res.status(400).json({ message: 'Elegí al menos un talle de los que tiene el producto.' });

  const existe = db.prepare('SELECT 1 FROM variantes WHERE sku = ?');
  const yaNoQuitada = db.prepare('DELETE FROM variantes_quitadas WHERE sku = ?');
  const insertar = db.prepare(`
    INSERT INTO variantes (producto_id, sku, color, talle, orden_talle, precio, color_id, talle_id, color_manual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const codigo = codigoDeColor(color.nombre);
  db.transaction(() => {
    for (const t of talles) {
      const base = porTalle.get(t);
      const raiz = `${producto.sku_agrupador}${codigo}${String(t).toUpperCase().replace(/\s+/g, '')}`;
      let sku = raiz;
      for (let n = 2; existe.get(sku); n += 1) sku = `${raiz}-${n}`;
      yaNoQuitada.run(sku);   // si se había quitado antes y se vuelve a agregar, deja de estar quitada
      insertar.run(producto.id, sku, color.nombre, base.talle, base.orden_talle, base.precio, color.id, base.talle_id);
    }
  })();
  res.status(201).json({ ok: true, creadas: talles.length, talles });
});

// DELETE /api/admin/productos/:sku/colores/:colorId — el color sale del producto, con todos sus talles.
r.delete('/productos/:sku/colores/:colorId', (req, res) => {
  const producto = productoPorSku(req.params.sku);
  if (!producto) return res.status(404).json({ message: 'No existe ese producto.' });
  const color = colorPorId(req.params.colorId);
  const quitar = color ? variantesDelColor(producto.id, color.id) : [];
  if (!quitar.length) return res.status(404).json({ message: 'Este producto no tiene ese color.' });

  const otros = db.prepare('SELECT COUNT(DISTINCT color_id) n FROM variantes WHERE producto_id = ? AND color_id <> ?')
    .get(producto.id, color.id).n;
  if (!otros) {
    return res.status(409).json({ message: 'Es el único color del producto. Si no se vende, ocultá el producto en vez de quitarle el color.' });
  }

  const fotos = db.transaction(() => {
    const anotar = db.prepare('INSERT OR REPLACE INTO variantes_quitadas (sku, producto_id, color, quitada_en) VALUES (?, ?, ?, ?)');
    const ahora = new Date().toISOString();
    for (const v of quitar) anotar.run(v.sku, producto.id, color.nombre, ahora);
    db.prepare('DELETE FROM variantes WHERE producto_id = ? AND color_id = ?').run(producto.id, color.id);
    return moverFotosDeColor(producto.id, color.id, null);
  })();
  res.json({ ok: true, variantes: quitar.length, fotosAGenerales: fotos.generales });
});

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
   * Se marca cuáles están fuera de la lista oficial.
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
/*
 * GET /api/admin/clientes — todos los que compraron, con cuenta o sin ella.
 *
 * Cuántas veces compró cada uno y cuánto, sin los cancelados: un pedido
 * cancelado no es una compra. Ordena el último pedido: arriba, los que están
 * comprando ahora.
 */
r.get('/clientes', (req, res) => {
  const filas = db.prepare(`
    SELECT c.id, c.email, c.nombre, c.cuit, c.telefono, c.provincia, c.ciudad,
           c.activo, c.creado_en, c.ultimo_acceso, c.password_hash IS NOT NULL AS tieneCuenta,
           COUNT(p.id) FILTER (WHERE p.estado <> 'cancelado') AS pedidos,
           COUNT(p.id) FILTER (WHERE p.estado = 'cancelado') AS cancelados,
           COALESCE(SUM(p.total) FILTER (WHERE p.estado <> 'cancelado'), 0) AS comprado,
           MAX(p.creado_en) AS ultimoPedido
    FROM clientes c LEFT JOIN pedidos p ON p.cliente_id = c.id
    GROUP BY c.id
    ORDER BY (MAX(p.creado_en) IS NULL), MAX(p.creado_en) DESC, c.id DESC`).all();
  res.json({ clientes: filas.map((f) => ({ ...f, tieneCuenta: Boolean(f.tieneCuenta) })) });
});

/*
 * GET /api/admin/clientes/:id — un cliente, sus pedidos y a dónde mandó.
 *
 * El mismo cliente manda cada pedido a otro lado: los lugares se juntan con
 * cuántas veces se usó cada uno, en vez de guardar "la" dirección del cliente.
 */
r.get('/clientes/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ message: 'No existe ese cliente.' });

  const pedidos = db.prepare(`
    SELECT numero, cliente, total, unidades, estado, creado_en
    FROM pedidos WHERE cliente_id = ? ORDER BY id DESC`).all(c.id).map((f) => {
    let d = {};
    try { d = JSON.parse(f.cliente); } catch { /* pedido sin datos legibles */ }
    return {
      numero: f.numero, creado_en: f.creado_en, total: f.total, unidades: f.unidades,
      estado: normalizarEstado(f.estado),
      envio: {
        direccion: d.direccion || '', ciudad: d.ciudad || '', provincia: d.provincia || '',
        codigoPostal: d.codigoPostal || '', formaEnvio: d.formaEnvio || '',
      },
    };
  });

  const lugares = new Map();
  for (const p of pedidos) {
    const e = p.envio;
    const clave = [e.direccion, e.ciudad, e.codigoPostal, e.formaEnvio].map((x) => String(x).trim().toLowerCase()).join('|');
    if (!lugares.has(clave)) lugares.set(clave, { ...e, veces: 0, ultimo: p.creado_en });
    lugares.get(clave).veces += 1;
  }

  const { password_hash: clave, ...datos } = c;
  res.json({
    cliente: { ...datos, tieneCuenta: Boolean(clave) },
    pedidos,
    direcciones: [...lugares.values()].sort((a, b) => b.veces - a.veces),
  });
});

/*
 * PUT /api/admin/clientes/:id — { activo?, nombre?, telefono?, email? }
 *
 * Para corregir un dato mal cargado. El email de una CUENTA no se toca desde
 * acá: es con lo que el cliente entra, y cambiárselo lo deja afuera.
 */
r.put('/clientes/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ message: 'No existe ese cliente.' });
  const b = req.body || {};
  const campos = [];
  const valores = [];
  if (b.activo !== undefined) { campos.push('activo = ?'); valores.push(b.activo ? 1 : 0); }
  for (const [campo, etiqueta] of [['nombre', 'El nombre'], ['telefono', 'El teléfono']]) {
    if (b[campo] === undefined) continue;
    const v = String(b[campo]).trim();
    if (!v) return res.status(400).json({ message: `${etiqueta} no puede quedar vacío.` });
    campos.push(`${campo} = ?`); valores.push(v);
  }
  if (b.email !== undefined) {
    if (c.password_hash) {
      return res.status(400).json({ message: 'El email de una cuenta lo cambia el cliente: es con lo que entra.' });
    }
    const v = String(b.email).trim().toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return res.status(400).json({ message: 'Ese email no parece válido.' });
    campos.push('email = ?'); valores.push(v || null);
  }
  if (!campos.length) return res.status(400).json({ message: 'No mandaste nada para cambiar.' });
  db.prepare(`UPDATE clientes SET ${campos.join(', ')} WHERE id = ?`).run(...valores, c.id);
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
  if (req.query.estado) {
    /*
     * Filtrar por "confirmado" tiene que traer también los pedidos viejos, que
     * en la base dicen 'nuevo' o 'preparando'. Sin esto, el filtro más usado
     * del panel devuelve vacío sobre datos que están ahí.
     */
    const pedido = normalizarEstado(req.query.estado);
    const equivalentes = pedido === 'confirmado' ? ['confirmado', 'nuevo', 'preparando'] : [pedido];
    condiciones.push(`estado IN (${equivalentes.map(() => '?').join(',')})`);
    params.push(...equivalentes);
  }
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
           aviso_mail, aviso_whatsapp, aviso_cliente, cliente_id, original, ajuste, actualizado_en
    FROM pedidos WHERE ${donde} ORDER BY id DESC LIMIT ${limite}`).all(...params);

  const totales = db.prepare(`
    SELECT COUNT(*) AS pedidos, COALESCE(SUM(total), 0) AS facturado,
           COALESCE(SUM(unidades), 0) AS unidades
    FROM pedidos WHERE ${donde}`).get(...params);

  res.json({
    // Cuántos esperan la confirmación de stock, con cualquier filtro: es lo primero que hay que atender.
    pendientes: db.prepare("SELECT COUNT(*) n FROM pedidos WHERE estado = 'pendiente'").get().n,
    pedidos: filas.map((f) => ({
      ...f,
      cliente: JSON.parse(f.cliente),
      items: JSON.parse(f.items),
      estado: normalizarEstado(f.estado),
      ajuste: f.ajuste ? JSON.parse(f.ajuste) : null,
      original: f.original ? JSON.parse(f.original) : null,
      historial: historialDePedido(f),
    })),
    totales,
  });
});

/** El pedido con todo lo que hace falta para seguirlo: por dónde pasó y qué cambió. */
r.get('/pedidos/:numero', (req, res) => {
  const pedido = leerPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ message: 'No existe ese pedido.' });
  res.json({ pedido: conSeguimiento(pedido) });
});

/*
 * PUT /api/admin/pedidos/:numero/estado — mover el pedido.
 *
 * El paso se valida acá y no sólo escondiendo el botón: la pantalla decide qué
 * es cómodo, el servidor decide qué es posible. Un pedido entregado que vuelve
 * a "confirmado" desde una consola abierta deja el historial mintiendo, y el
 * historial es lo único que queda cuando hay que discutir un reclamo.
 */
/*
 * Los errores de una ruta asincrónica van al manejador de errores.
 *
 * Express 4 no espera las promesas: sin esto, un error después de un `await`
 * deja la pantalla esperando una respuesta que no llega nunca.
 */
const conErrores = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Un pedido se puede rearmar mientras no salió del depósito.
const EDITABLES = ['pendiente', 'confirmado', 'modificado'];

/*
 * Cómo se pagó, elegido al confirmar.
 *
 * Es el único momento en que se sabe de verdad: el cliente pide sin pagar y la
 * forma se acuerda al coordinar. Viaja a STOCKER para que la venta quede con su
 * forma de pago y no como un cobro sin identificar.
 */
function guardarPago(pedidoId, pago) {
  if (!pago || typeof pago !== 'object') return null;
  const forma = String(pago.forma ?? '').trim().slice(0, 60) || null;
  const condicion = String(pago.condicion ?? '').trim().slice(0, 20).toLowerCase() || null;
  if (condicion && !['contado', 'cuenta_corriente', 'financiado'].includes(condicion)) {
    return { error: 'La condición de pago es contado, cuenta_corriente o financiado.' };
  }
  db.prepare('UPDATE pedidos SET pago_forma = ?, pago_condicion = ? WHERE id = ?')
    .run(forma, condicion, pedidoId);
  return { forma, condicion };
}

/** Le cuenta a STOCKER cómo quedó el pedido. Nunca voltea la respuesta del panel. */
function avisarAStocker(pedidoId, evento) {
  try {
    stocker.anotar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId), evento);
  } catch (e) {
    console.error('  stocker:', e.message);
  }
}

/*
 * Avisarle al cliente lo que cambió en su pedido.
 *
 * Sólo los pasos que cambian lo que va a recibir: que se confirmó el stock, que
 * se rearmó o que se canceló. El aviso queda anotado en el pedido, así el panel
 * muestra si el cliente se enteró.
 */
async function avisarClienteDelCambio(numero, estado, nota, cambios = null) {
  if (!['confirmado', 'confirmado-con-cambios', 'modificado', 'cancelado'].includes(estado)) return null;
  const pedido = leerPedido(numero);
  if (!pedido) return null;
  pedido.seVeEnCuenta = seVeEnCuenta(pedido);
  let pdf = null;
  if (estado !== 'cancelado') {
    try { pdf = await pdfPedido(pedido); } catch { /* sin adjunto: el aviso sale igual */ }
  }
  const aviso = await avisarCliente(pedido, estado, { pdf, nota, cambios });
  db.prepare('UPDATE pedidos SET aviso_cliente = ? WHERE id = ?').run(aviso, pedido.id);
  return aviso;
}

r.put('/pedidos/:numero/estado', conErrores(async (req, res) => {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(req.params.numero);
  if (!fila) return res.status(404).json({ message: 'No existe ese pedido.' });

  const destino = String(req.body?.estado || '').trim().toLowerCase();
  if (!ESTADOS[destino]) return res.status(400).json({ message: 'Ese estado no existe.' });

  const actual = normalizarEstado(fila.estado);
  if (destino === actual) return res.status(409).json({ message: `El pedido ya está ${ESTADOS[actual].etiqueta.toLowerCase()}.` });
  if (destino === 'modificado') {
    return res.status(409).json({
      message: 'A "modificado" se llega editando los artículos del pedido, no eligiéndolo de la lista.',
    });
  }
  if (!puedePasar(actual, destino)) {
    return res.status(409).json({
      message: `Un pedido ${ESTADOS[actual].etiqueta.toLowerCase()} no puede pasar a ${ESTADOS[destino].etiqueta.toLowerCase()}.`,
    });
  }

  const pago = guardarPago(fila.id, req.body?.pago);
  if (pago?.error) return res.status(400).json({ message: pago.error });

  registrarEstado(fila.id, destino, { nota: limpiarNota(req.body?.nota) });
  /*
   * A STOCKER: mientras la solicitud siga por revisar, cada cambio la reemplaza.
   * Cancelar antes de que la revisen la deja cancelada y ya no se puede aceptar;
   * después de aceptada, el cambio se anota allá para que una persona resuelva.
   */
  avisarAStocker(fila.id, destino);
  const avisoCliente = await avisarClienteDelCambio(fila.numero, destino, limpiarNota(req.body?.nota));
  res.json({ pedido: conSeguimiento(leerPedido(fila.numero)), avisoCliente });
}));

/*
 * Lo pedido, traducido a la grilla vigente de cada producto: cada cruce con su
 * SKU, su precio y la cantidad pedida. Lo usan el editor y la revisión de stock.
 */
function lineasDelPedido(pedido) {
  const pedidos = new Map();   // skuAgrupador -> Map("color|talle" -> cantidad)
  for (const it of pedido.items) {
    if (!pedidos.has(it.skuAgrupador)) pedidos.set(it.skuAgrupador, new Map());
    const cruces = pedidos.get(it.skuAgrupador);
    for (const d of it.detalle) {
      for (const t of d.talles) cruces.set(`${d.color || ''}|${t.talle}`, t.cantidad);
    }
  }

  const lineas = [];
  for (const [sku, cruces] of pedidos) {
    const grilla = grillaDeProducto(sku);
    if (!grilla) {
      // El producto se borró del catálogo después del pedido: se muestra lo
      // pedido para poder sacarlo, y nada más — no hay grilla que ofrecer.
      lineas.push({
        skuAgrupador: sku, titulo: sku, categoria: '', combinaciones: [],
        huerfanos: [...cruces].map(([k, cantidad]) => ({ color: k.split('|')[0], talle: k.split('|')[1], cantidad })),
      });
      continue;
    }
    const vistos = new Set();
    grilla.combinaciones = grilla.combinaciones.map((c) => {
      const clave = `${c.color}|${c.talle}`;
      vistos.add(clave);
      return { ...c, cantidad: cruces.get(clave) || 0 };
    });
    grilla.huerfanos = [...cruces]
      .filter(([k]) => !vistos.has(k))
      .map(([k, cantidad]) => ({ color: k.split('|')[0], talle: k.split('|')[1], cantidad }));
    lineas.push(grilla);
  }
  return lineas;
}

/*
 * GET /api/admin/pedidos/:numero/editor — la grilla para rearmar el pedido.
 *
 * Lo guardado dice "Negro, L: 4"; para volver a valorizarlo hace falta el SKU
 * de ese cruce, que es lo único que el servidor acepta como entrada. La
 * traducción de nombre a SKU se hace acá, con la base al lado, y no en el
 * navegador adivinando.
 */
r.get('/pedidos/:numero/editor', (req, res) => {
  const pedido = leerPedido(req.params.numero);
  if (!pedido) return res.status(404).json({ message: 'No existe ese pedido.' });

  const lineas = lineasDelPedido(pedido);

  res.json({
    numero: pedido.numero,
    estado: normalizarEstado(pedido.estado),
    ajuste: pedido.ajuste ? JSON.parse(pedido.ajuste) : null,
    lineas,
  });
});

/** La grilla de un producto suelto, para sumarlo a un pedido que se está rearmando. */
r.get('/grilla/:sku', (req, res) => {
  const grilla = grillaDeProducto(req.params.sku);
  if (!grilla) return res.status(404).json({ message: 'No existe ese producto.' });
  grilla.combinaciones = grilla.combinaciones.map((c) => ({ ...c, cantidad: 0 }));
  res.json({ linea: grilla });
});

/*
 * PUT /api/admin/pedidos/:numero/items — el pedido se rearma y queda "modificado".
 *
 * Es el caso que pidió el dueño: no hay todo para enviar, se arreglan otros
 * artículos y otro precio. Tres cosas que no se negocian acá:
 *
 *  · el total lo calcula el servidor sumando los ítems que él mismo valorizó.
 *    Lo que llega del navegador son SKU y cantidades — nunca importes. Es la
 *    misma regla del pedido original y por el mismo motivo;
 *  · el descuento o recargo acordado entra como instrucción ("-10 %", "-35000"),
 *    no como resultado: la cuenta la hace el servidor y queda escrita por qué
 *    el total no es la suma;
 *  · lo que el cliente confirmó se copia entero antes de tocar nada. Sin eso,
 *    a la semana no hay forma de mostrarle qué pidió él y qué se despachó.
 */
/*
 * Rearma un pedido con otro carrito: lo valoriza el servidor, guarda el pedido
 * original la primera vez y deja anotado qué cambió. Lo usan el editor y la
 * revisión de stock.
 */
function rearmarPedido(fila, carrito, { ajuste = null, nota = null, notaPorDefecto = null } = {}) {
  const { items, total: base, unidades, errores } = armarPedido(carrito);
  if (!items.length) {
    return { error: 'Un pedido modificado no puede quedar vacío. Si no va a salir, cancelalo.', errores };
  }
  let calculado;
  try { calculado = aplicarAjuste(base, ajuste); } catch (e) { return { error: e.message }; }

  const antes = { items: JSON.parse(fila.items), total: fila.total, unidades: fila.unidades };
  const cambios = {
    ...compararItems(antes.items, items),
    totalAntes: antes.total, totalDespues: calculado.total,
    unidadesAntes: antes.unidades, unidadesDespues: unidades,
    base: calculado.base, ajuste: calculado.ajuste,
  };
  db.transaction(() => {
    if (!fila.original) {
      db.prepare('UPDATE pedidos SET original = ? WHERE id = ?')
        .run(JSON.stringify({ ...antes, fecha: fila.creado_en }), fila.id);
    }
    db.prepare('UPDATE pedidos SET items = ?, total = ?, unidades = ?, ajuste = ? WHERE id = ?')
      .run(JSON.stringify(items), calculado.total, unidades, calculado.ajuste ? JSON.stringify(calculado.ajuste) : null, fila.id);
    registrarEstado(fila.id, 'modificado', { nota: nota || notaPorDefecto, cambios });
  })();
  return { cambios, errores };
}

r.put('/pedidos/:numero/items', conErrores(async (req, res) => {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(req.params.numero);
  if (!fila) return res.status(404).json({ message: 'No existe ese pedido.' });

  const actual = normalizarEstado(fila.estado);
  if (!EDITABLES.includes(actual)) {
    return res.status(409).json({
      message: `Un pedido ${ESTADOS[actual].etiqueta.toLowerCase()} ya no se edita. Lo que salió del depósito no cambia.`,
    });
  }

  const rearmado = rearmarPedido(fila, req.body?.carrito, { ajuste: req.body?.ajuste, nota: limpiarNota(req.body?.nota) });
  if (rearmado.error) return res.status(400).json({ message: rearmado.error, errores: rearmado.errores });

  /*
   * Rearmar un pedido que esperaba stock ES confirmarlo, con cambios: se revisó
   * y se decidió qué sale. Si ya estaba confirmado, es un cambio posterior. En
   * los dos casos al cliente le llega el pedido como queda y lo que cambió.
   */
  const aviso = actual === 'pendiente' ? 'confirmado-con-cambios' : 'modificado';
  const avisoCliente = await avisarClienteDelCambio(fila.numero, aviso, limpiarNota(req.body?.nota), rearmado.cambios);
  res.json({ pedido: conSeguimiento(leerPedido(fila.numero)), errores: rearmado.errores, avisoCliente });
}));

/*
 * PUT /api/admin/pedidos/:numero/confirmar-stock — { disponibles: { sku: n }, nota }
 *
 * La revisión del stock, renglón por renglón. Para cada cruce pedido se dice
 * cuánto hay, entre cero y lo pedido. Si hay todo, el pedido queda confirmado
 * tal cual; si falta algo, se rearma con lo que hay y queda modificado. En los
 * dos casos al cliente le llega el pedido como va a salir.
 *
 * Sumar artículos o cambiar el precio no es revisar el stock: para eso está el
 * editor. Por eso acá no entra más de lo pedido ni un cruce que no se pidió.
 */
r.put('/pedidos/:numero/confirmar-stock', conErrores(async (req, res) => {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ?').get(req.params.numero);
  if (!fila) return res.status(404).json({ message: 'No existe ese pedido.' });
  const actual = normalizarEstado(fila.estado);
  if (actual !== 'pendiente') {
    return res.status(409).json({
      message: `El pedido ya está ${ESTADOS[actual].etiqueta.toLowerCase()}: el stock se revisa mientras espera confirmación.`,
    });
  }

  const pedidos = new Map();   // sku -> { skuAgrupador, cantidad }
  let huerfanos = 0;
  for (const linea of lineasDelPedido(leerPedido(fila.numero))) {
    for (const c of linea.combinaciones) {
      if (c.cantidad > 0) pedidos.set(c.sku, { skuAgrupador: linea.skuAgrupador, cantidad: c.cantidad });
    }
    huerfanos += (linea.huerfanos || []).length;
  }

  const disponibles = req.body?.disponibles && typeof req.body.disponibles === 'object' ? req.body.disponibles : {};
  for (const [sku, valor] of Object.entries(disponibles)) {
    const p = pedidos.get(sku);
    if (!p) {
      return res.status(400).json({ message: 'Hay un artículo que no está en este pedido. Para sumar artículos usá «Modificar artículos y precio».' });
    }
    const n = Number(valor);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ message: 'Las cantidades que hay son números enteros, desde cero.' });
    }
    if (n > p.cantidad) {
      return res.status(400).json({ message: 'No puede haber más de lo que se pidió. Para sumar artículos usá «Modificar artículos y precio».' });
    }
  }

  const pago = guardarPago(fila.id, req.body?.pago);
  if (pago?.error) return res.status(400).json({ message: pago.error });

  const hay = (sku) => (Object.prototype.hasOwnProperty.call(disponibles, sku) ? Number(disponibles[sku]) : pedidos.get(sku).cantidad);
  const faltaAlgo = [...pedidos.keys()].some((sku) => hay(sku) < pedidos.get(sku).cantidad);
  const nota = limpiarNota(req.body?.nota);

  // Hay de todo y todo se puede volver a valorizar: se confirma tal cual, sin rearmar nada.
  if (!faltaAlgo && !huerfanos) {
    registrarEstado(fila.id, 'confirmado', { nota: nota || 'Confirmamos el stock de todo lo que pediste.' });
    avisarAStocker(fila.id, 'confirmado');
    const avisoCliente = await avisarClienteDelCambio(fila.numero, 'confirmado', nota);
    return res.json({ pedido: conSeguimiento(leerPedido(fila.numero)), conCambios: false, avisoCliente });
  }

  const carrito = new Map();
  for (const [sku, p] of pedidos) {
    const n = hay(sku);
    if (!n) continue;
    if (!carrito.has(p.skuAgrupador)) carrito.set(p.skuAgrupador, { skuAgrupador: p.skuAgrupador, cantidades: {} });
    carrito.get(p.skuAgrupador).cantidades[sku] = n;
  }
  if (!carrito.size) {
    return res.status(400).json({ message: 'No hay stock de nada de lo que pidió. Si no va a salir, cancelá el pedido.' });
  }

  const rearmado = rearmarPedido(fila, [...carrito.values()], {
    ajuste: fila.ajuste ? JSON.parse(fila.ajuste) : null,
    nota,
    notaPorDefecto: 'Revisamos el stock y no teníamos todo: ajustamos el pedido con lo que hay.',
  });
  if (rearmado.error) return res.status(400).json({ message: rearmado.error });
  // Lo apartado en STOCKER ya no coincide con lo que va a salir: se le manda el pedido rearmado.
  avisarAStocker(fila.id, 'modificado');
  const avisoCliente = await avisarClienteDelCambio(fila.numero, 'confirmado-con-cambios', nota, rearmado.cambios);
  res.json({ pedido: conSeguimiento(leerPedido(fila.numero)), conCambios: true, cambios: rearmado.cambios, avisoCliente });
}));

/*
 * ══ Estadísticas ═══════════════════════════════════════════════════
 *
 * GET /api/admin/estadisticas?desde=&hasta=
 *
 * Lo que se mira para decidir qué producir y qué reponer, no un muro de
 * números: cuánto entró y cuánto de eso ya se cobró, qué se vende, y dónde
 * está pidiendo la gente algo que la grilla no tiene.
 *
 * Se calcula en JavaScript sobre los pedidos del período y no en SQL: el
 * detalle vive como JSON adentro de la fila, y desarmarlo con json_each deja
 * consultas que nadie vuelve a poder leer para un catálogo de este tamaño.
 */
/*
 * GET /api/admin/trafico
 *
 * Qué se mira en la tienda: vistas, clicks, carritos abandonados y el ranking
 * de productos. Sale de la tabla de eventos, que se empezó a llenar el día que
 * se instaló la medición: de antes no hay nada, y el panel lo dice en vez de
 * mostrar ceros como si nadie hubiera entrado.
 */
r.get('/trafico', (req, res) => {
  const dias = Math.min(365, Math.max(1, Math.trunc(Number(req.query.dias) || 30)));
  res.json({ ...eventos.reporte({ dias }), nuevos: eventos.nuevos(30) });
});

r.get('/estadisticas', (req, res) => {
  const { desde, hasta } = periodo(req.query);

  const filas = db.prepare(`
    SELECT id, numero, cliente, items, total, unidades, estado, creado_en, cliente_id
    FROM pedidos WHERE creado_en >= ? AND creado_en <= ? ORDER BY creado_en`).all(desde, hasta);

  const pedidos = filas.map((f) => ({
    ...f,
    cliente: JSON.parse(f.cliente),
    items: JSON.parse(f.items),
    estado: normalizarEstado(f.estado),
  }));
  const vivos = pedidos.filter((p) => p.estado !== 'cancelado');
  const cancelados = pedidos.filter((p) => p.estado === 'cancelado');

  const suma = (lista, campo) => lista.reduce((t, p) => t + (Number(p[campo]) || 0), 0);
  const facturado = suma(vivos, 'total');
  /*
   * Cobrado = entregado.
   *
   * No hay estados de pago en el portal: lo que el sistema sabe con certeza es
   * qué llegó a destino, y este negocio cobra contra entrega. Se lo llama por
   * su nombre en la pantalla —"cobrado (entregados)"— para que nadie lo lea
   * como una conciliación bancaria que acá no existe.
   */
  const cobrado = suma(vivos.filter((p) => p.estado === 'entregado'), 'total');

  const porEstado = Object.keys(ESTADOS).map((estado) => {
    const suyos = pedidos.filter((p) => p.estado === estado);
    return { estado, pedidos: suyos.length, importe: suma(suyos, 'total'), unidades: suma(suyos, 'unidades') };
  });

  res.json({
    periodo: { desde, hasta, dias: Math.max(1, Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000)) },
    resumen: {
      pedidos: vivos.length,
      unidades: suma(vivos, 'unidades'),
      facturado,
      cobrado,
      porCobrar: facturado - cobrado,
      cancelados: cancelados.length,
      importeCancelado: suma(cancelados, 'total'),
      ticket: vivos.length ? Math.round(facturado / vivos.length) : 0,
      unidadesPorPedido: vivos.length ? Math.round((suma(vivos, 'unidades') / vivos.length) * 10) / 10 : 0,
      clientes: new Set(vivos.map((p) => p.cliente_id || p.cliente?.cuit || p.numero)).size,
    },
    porEstado,
    evolucion: evolucion(vivos, desde, hasta),
    ranking: ranking(vivos),
    clientes: rankingClientes(vivos),
    faltantes: faltantes(vivos, desde, hasta),
  });
});

// ── Las cuentas de las estadísticas ───────────────────────────────
function periodo(query) {
  const hoy = new Date();
  // Sin `hasta`, hasta este momento. Un fin de día en UTC se pasaría de largo
  // o se quedaría corto según la hora, y eso mueve los totales sin motivo.
  const hasta = String(query.hasta || '').trim()
    ? `${String(query.hasta).slice(0, 10)}T23:59:59.999Z`
    : hoy.toISOString();
  const desde = String(query.desde || '').trim()
    ? `${String(query.desde).slice(0, 10)}T00:00:00.000Z`
    // Sin filtro, los últimos noventa días: alcanza para ver una temporada y no
    // obliga a elegir fechas para empezar a mirar.
    : new Date(hoy.getTime() - 90 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  return { desde, hasta };
}

/*
 * La evolución se agrupa por día o por mes según lo que se pidió.
 *
 * Un año en barras diarias son trescientas sesenta y cinco rayitas de un
 * píxel: la forma de la curva se pierde justo cuando el período es largo, que
 * es cuando se la mira para ver una tendencia.
 */
function evolucion(pedidos, desde, hasta) {
  const dias = (Date.parse(hasta) - Date.parse(desde)) / 86400000;
  const porMes = dias > 92;
  const cubos = new Map();

  for (const p of pedidos) {
    const clave = porMes ? p.creado_en.slice(0, 7) : p.creado_en.slice(0, 10);
    if (!cubos.has(clave)) cubos.set(clave, { clave, pedidos: 0, unidades: 0, importe: 0 });
    const c = cubos.get(clave);
    c.pedidos += 1; c.unidades += p.unidades; c.importe += p.total;
  }
  return { porMes, puntos: [...cubos.values()].sort((a, b) => a.clave.localeCompare(b.clave)) };
}

/*
 * Qué se vende, por producto, categoría, color y talle.
 *
 * En plata sólo lo que la plata puede repartirse bien: el ítem guarda su
 * subtotal, así que producto y categoría salen exactos. Un color o un talle
 * sueltos no tienen importe propio —dentro de un ítem conviven varios precios—
 * y se cuentan en unidades, que además es lo que se necesita para decidir qué
 * cortar.
 */
function ranking(pedidos) {
  const productos = new Map();
  const categorias = new Map();
  const colores = new Map();
  const talles = new Map();

  const sumar = (mapa, clave, extra = {}) => {
    if (!mapa.has(clave)) mapa.set(clave, { clave, unidades: 0, pedidos: 0, ...extra });
    return mapa.get(clave);
  };

  for (const p of pedidos) {
    const vistosColor = new Set();
    const vistosTalle = new Set();
    for (const it of p.items) {
      const prod = sumar(productos, it.skuAgrupador, { titulo: it.titulo, categoria: it.categoria, importe: 0 });
      prod.unidades += it.unidades; prod.importe += it.subtotal; prod.pedidos += 1;

      const cat = sumar(categorias, it.categoria || 'Sin categoría', { importe: 0 });
      cat.unidades += it.unidades; cat.importe += it.subtotal; cat.pedidos += 1;

      for (const d of it.detalle) {
        const unidadesColor = d.talles.reduce((t, x) => t + x.cantidad, 0);
        const color = sumar(colores, d.color || 'Único');
        color.unidades += unidadesColor;
        if (!vistosColor.has(d.color)) { color.pedidos += 1; vistosColor.add(d.color); }

        for (const t of d.talles) {
          const talle = sumar(talles, t.talle || 'Único');
          talle.unidades += t.cantidad;
          if (!vistosTalle.has(t.talle)) { talle.pedidos += 1; vistosTalle.add(t.talle); }
        }
      }
    }
  }

  const ordenar = (mapa, por = 'unidades') => [...mapa.values()].sort((a, b) => b[por] - a[por]);
  return {
    productos: ordenar(productos, 'importe').slice(0, 20),
    categorias: ordenar(categorias, 'importe'),
    colores: ordenar(colores).slice(0, 15),
    talles: ordenar(talles).slice(0, 20),
  };
}

function rankingClientes(pedidos) {
  const mapa = new Map();
  for (const p of pedidos) {
    // Sin cuenta, el CUIT es lo que identifica al mismo comprador entre pedidos.
    const clave = p.cliente_id ? `c${p.cliente_id}` : `x${p.cliente?.cuit || p.numero}`;
    if (!mapa.has(clave)) {
      mapa.set(clave, { clave, nombre: p.cliente?.nombre || '—', conCuenta: Boolean(p.cliente_id), pedidos: 0, unidades: 0, importe: 0 });
    }
    const c = mapa.get(clave);
    c.pedidos += 1; c.unidades += p.unidades; c.importe += p.total;
  }
  return [...mapa.values()].sort((a, b) => b.importe - a.importe).slice(0, 12);
}

/*
 * "Cuántos piden y no hay".
 *
 * El catálogo no lleva stock, así que "no hay" es el cruce de color y talle que
 * el producto no tiene en la grilla. Se contesta con dos cosas distintas y se
 * dicen por separado, porque valen distinto:
 *
 *  · los intentos registrados: alguien tocó ese cruce y no había casillero.
 *    Es el dato real, y sólo existe desde que la tienda empezó a avisarlo;
 *  · los huecos con demanda al lado: el producto no tiene Negro en L, pero se
 *    pidieron 40 unidades de Negro en otros talles y 30 de L en otros colores.
 *    No prueba que alguien lo haya querido; señala dónde mirar, y se calcula
 *    con lo que ya está guardado desde el primer día.
 */
function faltantes(pedidos, desde, hasta) {
  const registrados = db.prepare(`
    SELECT p.sku_agrupador AS sku, p.titulo, f.color, f.talle, COUNT(*) AS intentos
    FROM faltantes f JOIN productos p ON p.id = f.producto_id
    WHERE f.fecha >= ? AND f.fecha <= ?
    GROUP BY f.producto_id, f.color, f.talle
    ORDER BY intentos DESC LIMIT 25`).all(desde, hasta);

  // Lo pedido en el período, por producto y cruce, para medir los vecinos.
  const demanda = new Map();
  for (const p of pedidos) {
    for (const it of p.items) {
      if (!demanda.has(it.skuAgrupador)) demanda.set(it.skuAgrupador, { colores: new Map(), talles: new Map() });
      const d = demanda.get(it.skuAgrupador);
      for (const linea of it.detalle) {
        const n = linea.talles.reduce((t, x) => t + x.cantidad, 0);
        d.colores.set(linea.color, (d.colores.get(linea.color) || 0) + n);
        for (const t of linea.talles) d.talles.set(t.talle, (d.talles.get(t.talle) || 0) + t.cantidad);
      }
    }
  }

  const grilla = db.prepare(`
    SELECT p.sku_agrupador AS sku, p.titulo,
           COALESCE(c.nombre, v.color) AS color,
           COALESCE(t.nombre, v.talle) AS talle,
           COALESCE(t.orden, v.orden_talle) AS orden_talle
    FROM variantes v
    JOIN productos p ON p.id = v.producto_id
    LEFT JOIN colores c ON c.id = v.color_id
    LEFT JOIN talles  t ON t.id = v.talle_id
    WHERE p.visible = 1`).all();

  const porProducto = new Map();
  for (const v of grilla) {
    if (!porProducto.has(v.sku)) {
      porProducto.set(v.sku, { sku: v.sku, titulo: v.titulo, colores: new Set(), talles: new Map(), cruces: new Set() });
    }
    const p = porProducto.get(v.sku);
    p.colores.add(v.color);
    p.talles.set(v.talle, v.orden_talle);
    p.cruces.add(`${v.color}|${v.talle}`);
  }

  let crucesPosibles = 0;
  let crucesQueFaltan = 0;
  const conHuecos = [];

  for (const p of porProducto.values()) {
    const talles = [...p.talles.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
    const d = demanda.get(p.sku) || { colores: new Map(), talles: new Map() };
    const huecos = [];

    for (const color of p.colores) {
      for (const talle of talles) {
        crucesPosibles += 1;
        if (p.cruces.has(`${color}|${talle}`)) continue;
        crucesQueFaltan += 1;
        const vecina = (d.colores.get(color) || 0) + (d.talles.get(talle) || 0);
        huecos.push({ color, talle, vecina });
      }
    }
    if (!huecos.length) continue;
    huecos.sort((a, b) => b.vecina - a.vecina);
    conHuecos.push({
      sku: p.sku,
      titulo: p.titulo,
      cruces: p.colores.size * talles.length,
      faltan: huecos.length,
      // Cuánto se pidió de los vecinos de TODOS sus huecos: lo que ordena la lista.
      vecina: huecos.reduce((t, h) => t + h.vecina, 0),
      huecos: huecos.slice(0, 8),
    });
  }

  conHuecos.sort((a, b) => b.vecina - a.vecina || b.faltan - a.faltan);
  return {
    registrados,
    hayRegistro: registrados.length > 0,
    crucesPosibles,
    crucesQueFaltan,
    productosConHuecos: conHuecos.length,
    productos: conHuecos.slice(0, 12),
  };
}

// ── Piezas compartidas del seguimiento ────────────────────────────
const limpiarNota = (v) => (String(v ?? '').trim().slice(0, 400) || null);

/** El pedido con su línea de tiempo y lo que se le cambió. */
function conSeguimiento(pedido) {
  return {
    ...pedido,
    estado: normalizarEstado(pedido.estado),
    ajuste: pedido.ajuste ? JSON.parse(pedido.ajuste) : null,
    original: pedido.original ? JSON.parse(pedido.original) : null,
    historial: historialDePedido(pedido),
  };
}

/**
 * El descuento o el recargo, aplicado por el servidor.
 *
 * Llega la instrucción —"-10 %", "-35000"— y no el resultado. Aceptar un total
 * del navegador es la única forma de que el pedido termine valorizado en lo que
 * alguien quiso, y esa puerta no se abre ni para el administrador.
 */
function aplicarAjuste(base, ajuste) {
  const redondo = Math.round(base);
  if (!ajuste || !ajuste.tipo) return { base: redondo, total: redondo, ajuste: null };

  const valor = Number(ajuste.valor);
  if (!Number.isFinite(valor)) throw new Error('El descuento o recargo tiene que ser un número.');

  let total;
  if (ajuste.tipo === 'porcentaje') {
    if (valor < -100 || valor > 100) throw new Error('El porcentaje va entre -100 y 100.');
    total = Math.round(redondo * (1 + valor / 100));
  } else if (ajuste.tipo === 'monto') {
    total = Math.round(redondo + valor);
  } else {
    throw new Error('El ajuste es por porcentaje o por monto.');
  }

  if (total < 0) throw new Error('Con ese descuento el pedido queda en negativo.');
  return {
    base: redondo, total,
    ajuste: { tipo: ajuste.tipo, valor, motivo: limpiarNota(ajuste.motivo), importe: total - redondo },
  };
}

/** La grilla vigente de un producto: cada cruce con su SKU y su precio del catálogo. */
function grillaDeProducto(sku) {
  const p = db.prepare(`
    SELECT p.id, p.sku_agrupador, p.titulo, p.precio, c.nombre AS categoria
    FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE p.sku_agrupador = ?`).get(String(sku));
  if (!p) return null;

  const combinaciones = db.prepare(`
    SELECT v.sku, v.precio,
           COALESCE(co.nombre, v.color) AS color,
           COALESCE(t.nombre, v.talle)  AS talle,
           COALESCE(t.orden, v.orden_talle) AS orden_talle,
           COALESCE(co.orden, 0) AS orden_color
    FROM variantes v
    LEFT JOIN colores co ON co.id = v.color_id
    LEFT JOIN talles  t  ON t.id  = v.talle_id
    WHERE v.producto_id = ?
    ORDER BY orden_color, color, orden_talle`).all(p.id);

  return {
    skuAgrupador: p.sku_agrupador,
    titulo: p.titulo,
    categoria: p.categoria || 'Sin categoría',
    /*
     * Los colores y los talles ya ordenados, aparte de la lista de cruces.
     *
     * El cuadro se dibuja color por talle, y sacar las cabeceras de las
     * combinaciones en el navegador obliga a reordenar los talles ahí —donde
     * "10" va antes que "2" y XS después de XL—. El orden ya está resuelto en
     * la base; se manda hecho.
     */
    colores: [...new Set(combinaciones.map((v) => v.color))],
    talles: [...new Map(combinaciones.map((v) => [v.talle, v.orden_talle])).entries()]
      .sort((a, b) => a[1] - b[1]).map(([t]) => t),
    combinaciones: combinaciones.map((v) => ({
      sku: v.sku, color: v.color, talle: v.talle, precio: v.precio ?? p.precio,
    })),
  };
}

/*
 * Qué cambió, cruce por cruce.
 *
 * "Modificado" sin decir qué obliga a poner dos remitos uno al lado del otro y
 * compararlos a ojo. Se guarda la diferencia por color y talle, que es como se
 * explica: "no había negro en L, van cuatro azules".
 */
function compararItems(antes, despues) {
  const aplanar = (items) => {
    const m = new Map();
    for (const it of items || []) {
      for (const d of it.detalle || []) {
        for (const t of d.talles || []) {
          m.set(`${it.skuAgrupador}\u0000${d.color || ''}\u0000${t.talle}`, { titulo: it.titulo, color: d.color, talle: t.talle, cantidad: t.cantidad });
        }
      }
    }
    return m;
  };

  const a = aplanar(antes);
  const b = aplanar(despues);
  const lineas = [];
  const linea = (v, antesN, despuesN) => ({ titulo: v.titulo, color: v.color, talle: v.talle, antes: antesN, despues: despuesN });

  for (const [clave, v] of a) {
    const nuevo = b.get(clave);
    if (!nuevo) lineas.push(linea(v, v.cantidad, 0));
    else if (nuevo.cantidad !== v.cantidad) lineas.push(linea(v, v.cantidad, nuevo.cantidad));
  }
  for (const [clave, v] of b) {
    if (!a.has(clave)) lineas.push(linea(v, 0, v.cantidad));
  }

  return {
    // Veinte líneas alcanzan para entender qué pasó; guardar el diff entero de
    // un pedido de trescientos cruces engorda la fila sin que nadie lo lea.
    lineas: lineas.slice(0, 20),
    masLineas: Math.max(0, lineas.length - 20),
  };
}

// ── Avisos: el WhatsApp del grupo de empleados y el mail ───────────
/*
 * Los errores esperables —no está conectado, ese grupo no existe— vuelven con
 * su código y su mensaje, para que el panel diga qué hacer en vez de "falló".
 */
const conAviso = (fn) => conErrores(async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ message: e.message });
    throw e;
  }
});

// El mail no se puede vincular desde el panel —son variables de Railway—, pero sí mostrar si falta.
const estadoDelMail = () => ({
  configurado: Boolean(process.env.MAIL_USER && process.env.MAIL_PASS),
  destino: process.env.PEDIDOS_EMAIL || null,
});

r.get('/avisos', (req, res) => res.json({
  whatsapp: whatsapp.estadoPublico(),
  mail: estadoDelMail(),
  stocker: stocker.estadoPublico(),
}));

/*
 * POST /api/admin/stocker/reintentar
 *
 * Vuelve a poner en la fila lo que quedó en error. Sin esto, un pedido que
 * falló doce veces se queda afuera para siempre y hay que tocarle la base.
 */
r.post('/stocker/reintentar', conErrores(async (req, res) => {
  const numero = req.body?.numero ? String(req.body.numero).trim() : null;
  const reencolados = stocker.reintentar(numero);
  const resultado = await stocker.procesarCola();
  res.json({ reencolados, ...resultado, stocker: stocker.estadoPublico() });
}));
// Sin número, el QR de siempre; con número, el código de ocho letras para escribir en el teléfono.
r.post('/whatsapp/vincular', conAviso(async (req, res) => res.json(await whatsapp.vincular(req.body?.numero))));
r.post('/whatsapp/desvincular', conAviso(async (req, res) => res.json(await whatsapp.desvincular())));
r.get('/whatsapp/grupos', conAviso(async (req, res) => res.json({ grupos: await whatsapp.grupos() })));
r.put('/whatsapp/grupo', conAviso(async (req, res) => res.json({ grupo: await whatsapp.elegirGrupo(String(req.body?.id || '')) })));
r.post('/whatsapp/prueba', conAviso(async (req, res) => res.json(await whatsapp.mandarPrueba())));

module.exports = { rutas: r };
