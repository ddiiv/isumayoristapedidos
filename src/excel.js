const ExcelJS = require('exceljs');
const { db, ordenDeTalle } = require('./db');

/*
 * Importador de la planilla que exporta STOCKER.
 *
 * Las columnas se buscan POR NOMBRE y no por posición. La planilla de STOCKER
 * agrega una columna de stock por cada local del negocio, así que las
 * posiciones se corren según cuántos locales tenga: leer por índice funciona
 * hasta que alguien abre un local nuevo, y ahí el precio empieza a leerse de la
 * columna del stock sin que nada avise.
 */

const norm = (v) => String(v ?? '').trim();
const normClave = (v) => norm(v).toLowerCase().replace(/\s+/g, ' ');

// Lo que ISUWAYA necesita de la planilla. Lo demás se ignora sin quejarse:
// la planilla es de STOCKER y va a tener columnas que acá no importan.
const COLUMNAS = {
  skuAgrupador: ['sku agrupador'],
  skuPadre: ['sku padre'],
  titulo: ['título', 'titulo'],
  categoria: ['categoría', 'categoria'],
  modelo: ['modelo'],
  genero: ['género', 'genero'],
  precio: ['precio mayorista'],
  skuVariante: ['sku variante'],
  v1Nombre: ['variante 1 nombre'],
  v1Valor: ['variante 1 valor'],
  v2Nombre: ['variante 2 nombre'],
  v2Valor: ['variante 2 valor'],
  precioVariante: ['precio mayorista variante'],
};

function mapearEncabezados(hoja) {
  const fila = hoja.getRow(1);
  const porColumna = {};
  fila.eachCell((celda, n) => {
    const clave = normClave(celda.value);
    for (const [campo, alias] of Object.entries(COLUMNAS)) {
      if (alias.includes(clave)) porColumna[campo] = n;
    }
  });
  return porColumna;
}

/*
 * ¿Cuál de las dos variantes es el color y cuál el talle?
 *
 * Se decide por el NOMBRE del atributo, que STOCKER exporta al lado del valor.
 * Asumir que la 1 es siempre color es la clase de suposición que anda con el
 * catálogo de hoy y se rompe con el primer producto cargado al revés — y
 * cuando se rompe, el resultado es una matriz con los colores en las columnas
 * de talle, que nadie relaciona con el importador.
 */
function repartirAtributos(fila, cols) {
  const leer = (c) => (cols[c] ? norm(fila.getCell(cols[c]).value) : '');
  const pares = [
    { nombre: normClave(leer('v1Nombre')), valor: leer('v1Valor') },
    { nombre: normClave(leer('v2Nombre')), valor: leer('v2Valor') },
  ];

  const esColor = (n) => /color|colour/.test(n);
  const esTalle = (n) => /talle|talles|tamañ|tamano|size|medida/.test(n);

  let color = pares.find((p) => esColor(p.nombre))?.valor || '';
  let talle = pares.find((p) => esTalle(p.nombre))?.valor || '';

  /*
   * Si los nombres no dicen nada —una planilla vieja, o atributos con nombres
   * propios del negocio— se cae a la convención de STOCKER: la 1 es color y la
   * 2 es talle. Queda anotado en el resultado para que el panel lo muestre, en
   * vez de adivinar en silencio.
   */
  let porPosicion = false;
  if (!color && !talle) {
    porPosicion = true;
    color = pares[0].valor;
    talle = pares[1].valor;
  } else if (!color) {
    color = pares.find((p) => p.valor && p.valor !== talle)?.valor || '';
  } else if (!talle) {
    talle = pares.find((p) => p.valor && p.valor !== color)?.valor || '';
  }

  return { color, talle, porPosicion };
}

const aNumero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'object' && v.result !== undefined ? v.result : v;
  const num = parseFloat(String(n).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(num) ? num : null;
};

/** Importa el .xlsx exportado de STOCKER (ver importarFilas). */
async function importarPlanilla(buffer) {
  const libro = new ExcelJS.Workbook();
  try {
    await libro.xlsx.load(buffer);
  } catch {
    /*
     * Un archivo que no es un .xlsx hace que la librería tire un error suyo,
     * sin `status`, y el manejador de errores lo trata como una falla del
     * servidor: "algo falló de este lado". Quien subió el archivo equivocado
     * necesita saber que el problema es el archivo, no el servidor.
     */
    throw Object.assign(
      new Error('Ese archivo no se puede abrir como planilla. Tiene que ser el .xlsx que exporta STOCKER.'),
      { status: 400 },
    );
  }
  const hoja = libro.worksheets[0];
  if (!hoja) throw Object.assign(new Error('La planilla no tiene ninguna hoja.'), { status: 400 });

  const cols = mapearEncabezados(hoja);
  const faltan = ['titulo', 'skuVariante'].filter((c) => !cols[c]);
  if (faltan.length) {
    throw Object.assign(
      new Error('Esto no parece la planilla de STOCKER: no encontré las columnas "Título" y "SKU Variante".'),
      { status: 400 },
    );
  }

  // Cada fila de la hoja, con los nombres de campo que entiende importarFilas.
  const filas = [];
  hoja.eachRow((fila, n) => {
    if (n === 1) return;
    const leer = (c) => (cols[c] ? norm(fila.getCell(cols[c]).value) : '');
    filas.push({
      titulo: leer('titulo'),
      skuVariante: leer('skuVariante'),
      skuAgrupador: leer('skuAgrupador'),
      skuPadre: leer('skuPadre'),
      categoria: leer('categoria'),
      modelo: leer('modelo'),
      genero: leer('genero'),
      precio: aNumero(cols.precio ? fila.getCell(cols.precio).value : null),
      precioVariante: aNumero(cols.precioVariante ? fila.getCell(cols.precioVariante).value : null),
      ...repartirAtributos(fila, cols),
    });
  });
  return importarFilas(filas);
}

/**
 * Guarda filas de catálogo, vengan de la planilla o de STOCKER directo
 * (src/stocker.js, sincronizarCatalogo).
 *
 * Es idempotente: las mismas filas dos veces dejan el catálogo igual, no
 * duplicado. La clave es el SKU Agrupador para el producto y el SKU Variante
 * para la variante — los mismos que usa STOCKER, así que volver a importar
 * actualiza lo que cambió y respeta lo demás. Nunca borra: un producto que ya
 * no viene sigue acá con sus fotos.
 *
 * `visibleNuevos` decide si un producto que no existía sale publicado. La
 * sincronización automática los deja ocultos: llegarían a la página sin fotos.
 */
function importarFilas(filas, { visibleNuevos = true } = {}) {
  const resumen = {
    filas: 0, productos: 0, variantes: 0, categorias: 0, nuevos: 0,
    sinAgrupador: 0, atributosPorPosicion: 0, ignoradas: 0,
  };

  const insCategoria = db.prepare(`INSERT INTO categorias (nombre, orden) VALUES (?, 0)
                                   ON CONFLICT(nombre) DO NOTHING`);
  const buscarCategoria = db.prepare('SELECT id FROM categorias WHERE nombre = ?');
  /*
   * `creado_en` sólo se escribe al dar de alta: una reimportación actualiza
   * precios y títulos, pero un producto no vuelve a ser nuevo porque se subió
   * la planilla otra vez. Lo mismo `visible`: se elige en el panel.
   */
  const ahora = new Date().toISOString();
  const upsertProducto = db.prepare(`
    INSERT INTO productos (sku_agrupador, titulo, categoria_id, modelo, genero, precio, creado_en, visible)
    VALUES (@sku, @titulo, @categoriaId, @modelo, @genero, @precio, @ahora, @visible)
    ON CONFLICT(sku_agrupador) DO UPDATE SET
      titulo = excluded.titulo, categoria_id = excluded.categoria_id,
      modelo = excluded.modelo, genero = excluded.genero, precio = excluded.precio`);
  const buscarProducto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ?');
  const upsertVariante = db.prepare(`
    INSERT INTO variantes (producto_id, sku, color, talle, orden_talle, precio)
    VALUES (@productoId, @sku, @color, @talle, @ordenTalle, @precio)
    ON CONFLICT(sku) DO UPDATE SET
      producto_id = excluded.producto_id,
      -- Un color corregido a mano en el panel no lo pisa la planilla.
      color = CASE WHEN variantes.color_manual = 1 THEN variantes.color ELSE excluded.color END,
      talle = excluded.talle, orden_talle = excluded.orden_talle, precio = excluded.precio`);

  // Lo que se quitó a mano en el panel no vuelve con la planilla.
  const quitada = db.prepare('SELECT 1 FROM variantes_quitadas WHERE sku = ?');

  const vistos = new Set();

  const correr = db.transaction(() => {
    for (const f of filas) {
      resumen.filas += 1;

      const titulo = norm(f.titulo);
      const skuVariante = norm(f.skuVariante);
      if (!titulo || !skuVariante) { resumen.ignoradas += 1; continue; }

      let agrupador = norm(f.skuAgrupador);
      if (!agrupador) {
        // Sin agrupador cada fila sería su propio producto y el catálogo
        // quedaría con un "producto" por talle. Se cae al SKU padre, que es lo
        // que STOCKER usa cuando el agrupador está vacío.
        agrupador = norm(f.skuPadre) || `SIN-AGRUP-${titulo}`;
        resumen.sinAgrupador += 1;
      }

      const nombreCategoria = norm(f.categoria) || 'Sin categoría';
      insCategoria.run(nombreCategoria);
      const categoria = buscarCategoria.get(nombreCategoria);
      if (categoria) resumen.categorias = db.prepare('SELECT COUNT(*) c FROM categorias').get().c;

      const existia = buscarProducto.get(agrupador);
      upsertProducto.run({
        ahora,
        sku: agrupador,
        titulo,
        categoriaId: categoria?.id ?? null,
        modelo: norm(f.modelo) || null,
        genero: norm(f.genero) || null,
        precio: f.precio ?? 0,
        visible: visibleNuevos ? 1 : 0,
      });
      const producto = existia || buscarProducto.get(agrupador);
      if (!vistos.has(agrupador)) {
        vistos.add(agrupador);
        resumen.productos += 1;
        if (!existia) resumen.nuevos += 1;
      }

      if (f.porPosicion) resumen.atributosPorPosicion += 1;

      if (quitada.get(skuVariante)) { resumen.quitadasSalteadas = (resumen.quitadasSalteadas || 0) + 1; continue; }

      const talle = norm(f.talle);
      upsertVariante.run({
        productoId: producto.id,
        sku: skuVariante,
        color: norm(f.color), talle,
        ordenTalle: ordenDeTalle(talle),
        precio: f.precioVariante ?? null,
      });
      resumen.variantes += 1;
    }
  });

  correr();
  return resumen;
}

module.exports = { importarPlanilla, importarFilas, repartirAtributos, ordenDeTalle };
