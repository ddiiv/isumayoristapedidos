const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

/*
 * Dónde vive todo.
 *
 * Una sola carpeta —la del volumen de Railway— con la base y las fotos
 * adentro. Separarlas obligaría a montar dos volúmenes para no perder la mitad
 * de los datos en un redeploy, y el día que alguien monte uno solo el error se
 * ve recién cuando falta una foto.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'datos');
const FOTOS_DIR = path.join(DATA_DIR, 'fotos');

fs.mkdirSync(FOTOS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'isuwaya.db'));

/*
 * WAL: deja leer mientras se escribe.
 *
 * Sin esto, una importación de Excel —que escribe miles de filas— bloquea el
 * catálogo, y el cliente que estaba armando su pedido ve la página colgada
 * justo cuando alguien actualiza precios.
 */
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS categorias (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE,
  orden   INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS productos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- El SKU Agrupador de STOCKER es lo que junta las variantes en un producto
  -- padre. Es la clave con la que se reimporta, así que una reimportación
  -- actualiza en vez de duplicar.
  sku_agrupador TEXT NOT NULL UNIQUE,
  titulo        TEXT NOT NULL,
  categoria_id  INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
  modelo        TEXT,
  genero        TEXT,
  precio        REAL NOT NULL DEFAULT 0,
  foto          TEXT,
  visible       INTEGER NOT NULL DEFAULT 1,
  orden         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS variantes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  sku         TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '',
  talle       TEXT NOT NULL DEFAULT '',
  orden_talle INTEGER NOT NULL DEFAULT 0,
  -- Precio propio de la variante. NULO = hereda del producto, igual que en
  -- STOCKER: si se guardara el precio heredado como valor, cambiar el del
  -- padre dejaría de afectar a las variantes y nadie entendería por qué.
  precio      REAL
);
CREATE INDEX IF NOT EXISTS idx_variantes_producto ON variantes(producto_id);

CREATE TABLE IF NOT EXISTS fotos_color (
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  color       TEXT NOT NULL,
  ruta        TEXT NOT NULL,
  PRIMARY KEY (producto_id, color)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  numero      TEXT NOT NULL UNIQUE,
  cliente     TEXT NOT NULL,
  items       TEXT NOT NULL,
  total       REAL NOT NULL DEFAULT 0,
  unidades    INTEGER NOT NULL DEFAULT 0,
  estado      TEXT NOT NULL DEFAULT 'nuevo',
  creado_en   TEXT NOT NULL,
  -- Qué pasó con los avisos. Se guarda el resultado y no sólo un booleano:
  -- si el mail salió y el WhatsApp no, hay que poder saber cuál rehacer.
  aviso_mail     TEXT,
  aviso_whatsapp TEXT,
  -- Nulo para los pedidos hechos sin cuenta. No es obligatorio tener cuenta
  -- para comprar: exigirla antes de ver un precio pierde clientes.
  cliente_id     INTEGER REFERENCES clientes(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS colores (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE,
  -- El hex con el que se pinta el cuadrito. Se edita desde el panel con la
  -- muestra al lado: elegir un color a ciegas por su código es adivinar.
  hex     TEXT NOT NULL DEFAULT '#cccccc',
  -- Marca los que todavía nadie confirmó. La pantalla del panel los ordena
  -- primero: son los que hay que mirar.
  provisorio INTEGER NOT NULL DEFAULT 1,
  orden   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS talles (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre  TEXT NOT NULL UNIQUE,
  -- 'adulto' | 'nino'. Un talle 8 de niño y un talle 8 de adulto no son el
  -- mismo talle, y sin separarlos la guía de medidas mezcla los dos.
  grupo   TEXT NOT NULL DEFAULT 'adulto',
  orden   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clientes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  -- Los mismos campos que pide el pedido, para que al entrar se completen
  -- solos. Guardarlos en otra forma obligaría a traducir entre dos formatos
  -- cada vez, y el día que se agregue un campo se agrega en un solo lado.
  nombre        TEXT NOT NULL,
  cuit          TEXT NOT NULL,
  telefono      TEXT NOT NULL,
  provincia     TEXT,
  ciudad        TEXT,
  codigo_postal TEXT,
  direccion     TEXT,
  entre_calles  TEXT,
  forma_envio   TEXT,
  activo        INTEGER NOT NULL DEFAULT 1,
  creado_en     TEXT NOT NULL,
  ultimo_acceso TEXT
);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes(email);

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
`);

/*
 * Columnas que se agregan a tablas que ya existen.
 *
 * `CREATE TABLE IF NOT EXISTS` no toca una tabla que ya está: en un despliegue
 * nuevo la columna nace con la tabla, pero en el que ya venía andando —que es
 * el caso de todos los deploys menos el primero— no aparece nunca, y la
 * consulta falla en producción con un error que en la máquina de desarrollo no
 * pasa. Se revisa en cada arranque y se agrega lo que falte.
 */
function asegurarColumna(tabla, columna, definicion) {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
  if (columnas.includes(columna)) return;
  db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  console.log(`  [base] se agregó ${tabla}.${columna}`);
}

asegurarColumna('pedidos', 'cliente_id', 'INTEGER');
asegurarColumna('variantes', 'color_id', 'INTEGER');
asegurarColumna('variantes', 'talle_id', 'INTEGER');
// Guía de medidas del producto, en JSON. Cambia por producto: un talle M no
// mide lo mismo en una remera que en una campera, y el cliente necesita las
// medidas de ESTE producto, no una tabla general.
asegurarColumna('productos', 'guia_talles', 'TEXT');
asegurarColumna('productos', 'descripcion', 'TEXT');

/*
 * Orden de talles.
 *
 * Ordenar alfabéticamente pone "10" antes que "2" y "XS" después de "XL". En
 * una matriz de talles eso no es un detalle: la persona busca la columna donde
 * espera encontrarla y carga la cantidad en la de al lado.
 *
 * Se resuelve en tres tramos: los numéricos por su valor, los de letras por su
 * secuencia real, y lo que no entra en ninguno al final por alfabético — sin
 * inventarle un orden a algo que no lo tiene.
 */
const ESCALA_LETRAS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL'];

function ordenDeTalle(talle) {
  const t = String(talle || '').trim().toUpperCase();
  if (!t) return 9_000_000;

  const numero = t.match(/^(\d+(?:[.,]\d+)?)$/);
  if (numero) return Math.round(parseFloat(numero[1].replace(',', '.')) * 10);

  const i = ESCALA_LETRAS.indexOf(t);
  if (i >= 0) return 1_000_000 + i;

  // Lo que no es número ni talle de letra conocido: al final, alfabético.
  return 2_000_000 + (t.charCodeAt(0) || 0) * 1000 + (t.charCodeAt(1) || 0);
}

/** Número de pedido legible y ordenable: ISU-000123. */
function proximoNumeroDePedido() {
  const fila = db.prepare('SELECT COALESCE(MAX(id), 0) AS ultimo FROM pedidos').get();
  return `ISU-${String(fila.ultimo + 1).padStart(6, '0')}`;
}

function leerConfig(clave, porDefecto = null) {
  const fila = db.prepare('SELECT valor FROM config WHERE clave = ?').get(clave);
  return fila ? fila.valor : porDefecto;
}

function guardarConfig(clave, valor) {
  db.prepare(`INSERT INTO config (clave, valor) VALUES (?, ?)
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`).run(clave, String(valor));
}

module.exports = { db, DATA_DIR, FOTOS_DIR, ordenDeTalle, proximoNumeroDePedido, leerConfig, guardarConfig };
