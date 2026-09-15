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
/*
 * Dónde se guarda todo: la base y las fotos.
 *
 * DATA_DIR si está puesta; si no, el volumen de Railway —Railway pone sola
 * RAILWAY_VOLUME_MOUNT_PATH con la ruta donde se montó—; y si no hay volumen,
 * ./datos, que es lo de la máquina de desarrollo.
 *
 * Así el deploy no depende de acordarse de DATA_DIR. Ese olvido no da ningún
 * error: con el volumen en /data y la app escribiendo en /app/datos, todo anda
 * perfecto hasta el primer redeploy, que se lleva la base entera.
 */
const DATA_DIR = path.resolve(process.env.DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(__dirname, '..', 'datos'));
const FOTOS_DIR = path.join(DATA_DIR, 'fotos');

const enRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_SERVICE_ID);
const volumen = process.env.RAILWAY_VOLUME_MOUNT_PATH && path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH);
if (enRailway && !volumen) {
  console.warn('\n  ⚠ ATENCIÓN: no hay volumen montado. La base y las fotos se BORRAN en cada deploy.'
    + '\n    Agregá un volumen al servicio con punto de montaje /data.\n');
} else if (volumen && DATA_DIR !== volumen && !DATA_DIR.startsWith(volumen + path.sep)) {
  console.warn(`\n  ⚠ ATENCIÓN: los datos van a ${DATA_DIR}, que NO está dentro del volumen (${volumen}).`
    + '\n    Se pierden en cada deploy. Borrá DATA_DIR de las variables y la app usa el volumen sola.\n');
}

/*
 * Si no se puede escribir en la carpeta de datos, se dice claro y se corta.
 *
 * Desde afuera Railway sólo muestra "Application failed to respond"; el
 * motivo queda en los logs del deploy, y ahí tiene que decir qué hacer y no
 * dejar un stack de sqlite que no explica nada.
 */
try {
  fs.mkdirSync(FOTOS_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`\n  ✖ No puedo escribir en la carpeta de datos: ${DATA_DIR}`
    + `\n    ${e.code || ''} ${e.message}`
    + '\n    Revisá el punto de montaje del volumen. Si la imagen no corre como root,'
    + '\n    agregá la variable RAILWAY_RUN_UID=0.\n');
  process.exit(1);
}

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

/*
 * Las columnas de clientes, en un solo lugar: las usa la base nueva y la
 * migración que rehace la tabla en una base que ya existe.
 */
const COLUMNAS_CLIENTES = `
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Sin contraseña es un cliente "reservado": compró sin crear cuenta. Se lo
  -- reconoce por el CUIT y se le guardan los datos para la próxima compra.
  -- El email no es único acá: dos negocios pueden compartir el del contador.
  -- Lo único que no se repite es el email de una CUENTA (índice más abajo).
  email         TEXT,
  password_hash TEXT,
  -- Los mismos campos que pide el pedido, para que al entrar se completen
  -- solos. Guardarlos en otra forma obligaría a traducir entre dos formatos
  -- cada vez, y el día que se agregue un campo se agrega en un solo lado.
  nombre        TEXT NOT NULL,
  cuit          TEXT NOT NULL,
  -- El CUIT sólo con los números: es con lo que se reconoce al cliente.
  cuit_numero   TEXT,
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
`;

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

CREATE TABLE IF NOT EXISTS fotos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  ruta        TEXT NOT NULL,
  -- Nulo = foto general del producto. Con color, es la foto de ESE color y es
  -- la que se muestra al elegirlo en la matriz.
  color_id    INTEGER REFERENCES colores(id) ON DELETE SET NULL,
  orden       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fotos_producto ON fotos(producto_id, orden);

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

/*
 * Por dónde pasó el pedido, no sólo dónde está.
 *
 * Con una sola columna de estado, el cliente que entra a mirar ve "enviado" y
 * nada más: no sabe cuándo se confirmó, ni que ayer se le cambiaron dos
 * artículos porque no había. Eso termina en un mensaje preguntando lo que la
 * pantalla podría contestar sola. Cada cambio deja su fila y la línea de tiempo
 * se arma leyéndolas en orden.
 */
CREATE TABLE IF NOT EXISTS pedido_estados (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  estado    TEXT NOT NULL,
  -- Lo que se le explica al cliente: "no había negro en L, va azul".
  nota      TEXT,
  -- El detalle de qué cambió, en JSON, cuando el estado es 'modificado'.
  -- Decir "modificado" sin decir qué obliga a comparar dos remitos a ojo.
  cambios   TEXT,
  fecha     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pedido_estados ON pedido_estados(pedido_id, id);

/*
 * Lo que alguien quiso pedir y no estaba en la grilla.
 *
 * El catálogo no maneja stock: lo que no existe es el cruce de color y talle
 * que el producto no tiene. Sin registrar el intento, ese pedido perdido no
 * deja rastro en ningún lado — y es justo el dato que dice qué conviene
 * producir. Se guarda el cruce y nada de quién lo pidió.
 */
CREATE TABLE IF NOT EXISTS faltantes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  color       TEXT NOT NULL DEFAULT '',
  talle       TEXT NOT NULL DEFAULT '',
  fecha       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faltantes ON faltantes(fecha);

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

CREATE TABLE IF NOT EXISTS clientes (${COLUMNAS_CLIENTES});
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

/*
 * Clientes sin cuenta: la tabla se rehace una sola vez.
 *
 * Exigía email y contraseña, así que quien compraba sin cuenta no quedaba
 * registrado en ningún lado: no había cómo saber cuántas veces compró ni
 * completarle los datos la próxima vez. SQLite no deja sacar un NOT NULL de
 * una columna, así que se copia la tabla a una nueva con las columnas
 * flexibles y se reemplaza, todo o nada en una transacción. Las claves
 * foráneas se apagan mientras tanto: borrar la tabla vieja no puede soltar
 * los pedidos de sus clientes.
 */
(() => {
  const columnas = db.prepare('PRAGMA table_info(clientes)').all();
  const clave = columnas.find((c) => c.name === 'password_hash');
  if (clave && clave.notnull === 0 && columnas.some((c) => c.name === 'cuit_numero')) return;

  const nuevas = COLUMNAS_CLIENTES.split('\n').map((l) => l.trim().match(/^([a-z_]+)\s/)?.[1]).filter(Boolean);
  const comunes = columnas.map((c) => c.name).filter((n) => nuevas.includes(n));
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE clientes_nueva (${COLUMNAS_CLIENTES})`);
      db.exec(`INSERT INTO clientes_nueva (${comunes.join(', ')}) SELECT ${comunes.join(', ')} FROM clientes`);
      db.exec('DROP TABLE clientes');
      db.exec('ALTER TABLE clientes_nueva RENAME TO clientes');
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  console.log('  [base] la tabla de clientes ahora admite clientes sin cuenta');
})();

{
  const poner = db.prepare('UPDATE clientes SET cuit_numero = ? WHERE id = ?');
  for (const c of db.prepare('SELECT id, cuit FROM clientes WHERE cuit_numero IS NULL').all()) {
    poner.run(String(c.cuit || '').replace(/\D/g, ''), c.id);
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes(email);
  CREATE INDEX IF NOT EXISTS idx_clientes_cuit  ON clientes(cuit_numero);
  -- Dos CUENTAS no pueden tener el mismo email: es con lo que se entra.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_email_cuenta ON clientes(email) WHERE password_hash IS NOT NULL;
`);

/*
 * Si el pedido se hizo con la sesión abierta.
 *
 * Todo pedido queda atado a su cliente por CUIT, con cuenta o sin ella. Pero
 * que alguien cree una cuenta con un CUIT no le da derecho a ver lo que otros
 * pidieron con ese CUIT antes: en «Mis pedidos» se ven los hechos con la
 * sesión abierta y los que dejaron el mismo email de la cuenta. Hasta ahora
 * sólo se ataba un pedido cuando había sesión, así que esos son todos con
 * sesión.
 */
{
  const habia = db.prepare('PRAGMA table_info(pedidos)').all().some((c) => c.name === 'con_sesion');
  asegurarColumna('pedidos', 'con_sesion', 'INTEGER NOT NULL DEFAULT 0');
  if (!habia) db.exec('UPDATE pedidos SET con_sesion = 1 WHERE cliente_id IS NOT NULL');
}
// Qué datos del cliente salieron de lo guardado y no del formulario (ver src/clientes.js).
asegurarColumna('pedidos', 'datos_guardados', 'TEXT');
asegurarColumna('variantes', 'color_id', 'INTEGER');
asegurarColumna('variantes', 'talle_id', 'INTEGER');
// Guía de medidas del producto, en JSON. Cambia por producto: un talle M no
// mide lo mismo en una remera que en una campera, y el cliente necesita las
// medidas de ESTE producto, no una tabla general.
asegurarColumna('productos', 'guia_talles', 'TEXT');
asegurarColumna('productos', 'descripcion', 'TEXT');

/*
 * El pedido tal como lo confirmó el cliente, guardado entero antes de tocarlo.
 *
 * Cuando no hay todo para enviar se arreglan otros artículos y otro precio, y
 * ahí el pedido deja de decir lo que el cliente aceptó. Sin la copia, no queda
 * forma de mostrarle qué pidió él y qué se despachó: el reclamo se discute de
 * memoria. Es JSON —items, total y unidades— porque se lee entero o no se lee.
 */
asegurarColumna('pedidos', 'original', 'TEXT');
// El descuento o recargo acordado, en JSON. El importe lo calcula el servidor
// aplicando esto sobre los ítems; acá queda por qué el total no es la suma.
asegurarColumna('pedidos', 'ajuste', 'TEXT');
asegurarColumna('pedidos', 'actualizado_en', 'TEXT');
// Qué pasó con el último aviso al cliente: el panel muestra si se enteró.
asegurarColumna('pedidos', 'aviso_cliente', 'TEXT');
// La versión chica de cada foto, para las miniaturas (ver src/miniaturas.js).
asegurarColumna('fotos', 'miniatura', 'TEXT');
// Y la mediana, para la fila del catálogo en pantallas densas y la foto grande del panel.
asegurarColumna('fotos', 'media', 'TEXT');

/*
 * Correcciones de color hechas en el panel, que la planilla no deshace.
 *
 * El importador vuelve a escribir el color de cada variante con lo que dice
 * STOCKER. Si en el panel se corrigió "Azul" por "Verde" porque la planilla
 * estaba mal, la próxima importación lo devolvería a "Azul" sin avisar. Una
 * variante con el color puesto a mano no se pisa.
 */
asegurarColumna('variantes', 'color_manual', 'INTEGER NOT NULL DEFAULT 0');

/*
 * Las variantes quitadas desde el panel, para que la planilla no las reviva.
 *
 * El importador crea lo que falta: un color quitado a mano volvería en la
 * próxima importación porque STOCKER lo sigue teniendo. Se anota el SKU y el
 * importador lo saltea.
 */
db.exec(`CREATE TABLE IF NOT EXISTS variantes_quitadas (
  sku         TEXT PRIMARY KEY,
  producto_id INTEGER,
  color       TEXT,
  quitada_en  TEXT NOT NULL
)`);

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
/*
 * Los talles de letra, medidos desde el medio.
 *
 * El mismo talle llega escrito de dos formas: "XXL" y "2XL" son el mismo, y
 * "XXXL" y "3XL" también. Con una lista fija de nombres, la forma que no
 * estaba en la lista caía en el cajón de lo desconocido y se iba al final: las
 * columnas del cuadro salían XS S M L XL 4XL 5XL 2XL 3XL, con los dos talles
 * más pedidos al final de todo.
 *
 * Contar cuántas X tiene hacia arriba de L —o hacia abajo de S— resuelve las
 * dos escrituras con la misma cuenta y no hay lista que actualizar cuando
 * aparezca un 6XL.
 */
const CENTRO = { S: -1, M: 0, L: 1 };

function escalonDeLetra(t) {
  if (t in CENTRO) return CENTRO[t];
  let m = t.match(/^(X+)L$/);   if (m) return 1 + m[1].length;   // XL, XXL, XXXL…
  m = t.match(/^(\d+)XL$/);     if (m) return 1 + Number(m[1]);  // 2XL, 3XL, 4XL…
  m = t.match(/^(X+)S$/);       if (m) return -1 - m[1].length;  // XS, XXS…
  m = t.match(/^(\d+)XS$/);     if (m) return -1 - Number(m[1]); // 2XS, 3XS…
  return null;
}

function ordenDeTalle(talle) {
  const t = String(talle || '').trim().toUpperCase();
  if (!t) return 9_000_000;

  const numero = t.match(/^(\d+(?:[.,]\d+)?)$/);
  if (numero) return Math.round(parseFloat(numero[1].replace(',', '.')) * 10);

  const escalon = escalonDeLetra(t);
  if (escalon !== null) return 1_000_000 + 100 + escalon;

  // Lo que no es número ni talle de letra conocido: al final, alfabético.
  return 2_000_000 + (t.charCodeAt(0) || 0) * 1000 + (t.charCodeAt(1) || 0);
}

/*
 * Los talles que quedaron mal ordenados se reacomodan al arrancar.
 *
 * El orden se guarda como número en la fila, así que arreglar la cuenta no
 * alcanza: lo que ya estaba escrito sigue mal hasta que se vuelve a calcular.
 *
 * Se recalcula toda la banda de letras, no sólo lo que no se reconocía: al
 * cambiar la escala cambiaron también los números de XS a 5XL, y dejar los
 * viejos mezclados con los nuevos ordena peor que antes —4XL con el número
 * viejo se pone delante de 2XL con el nuevo—.
 *
 * Un orden puesto a mano desde el panel es un número chico y no entra acá:
 * pisarlo sería deshacer una decisión de quien administra.
 */
(() => {
  const CALCULADO = 1_000_000;   // de acá para arriba lo escribió la máquina
  let tocados = 0;

  const ponerTalle = db.prepare('UPDATE talles SET orden = ? WHERE id = ?');
  for (const t of db.prepare('SELECT id, nombre, orden FROM talles WHERE orden >= ?').all(CALCULADO)) {
    const nuevo = ordenDeTalle(t.nombre);
    if (nuevo !== t.orden) { ponerTalle.run(nuevo, t.id); tocados++; }
  }

  const ponerVariantes = db.prepare('UPDATE variantes SET orden_talle = ? WHERE talle = ? AND orden_talle <> ?');
  for (const { talle } of db.prepare('SELECT DISTINCT talle FROM variantes WHERE orden_talle >= ?').all(CALCULADO)) {
    const nuevo = ordenDeTalle(talle);
    tocados += ponerVariantes.run(nuevo, talle, nuevo).changes;
  }

  if (tocados) console.log(`  talles reordenados: ${tocados}`);
})();

/*
 * ══ El seguimiento del pedido ═══════════════════════════════════════
 *
 * Cinco estados y nada más, porque son los cinco que el negocio usa de verdad:
 * se confirma, a veces se modifica —no hay todo y se arregla otra cosa—, se
 * envía y se entrega; y en cualquier momento antes de la entrega se puede
 * caer.
 *
 * Qué se puede pasar a qué vive acá y no en la pantalla. Esconder el botón
 * alcanza para que nadie se equivoque de clic, no para que un pedido entregado
 * no vuelva a "confirmado" desde una consola abierta a dos líneas de distancia.
 */
const ESTADOS = {
  pendiente:  { etiqueta: 'Esperando stock', descripcion: 'Lo recibimos y estamos revisando que tengamos todo.' },
  confirmado: { etiqueta: 'Confirmado', descripcion: 'Hay stock de todo y está en preparación.' },
  modificado: { etiqueta: 'Modificado', descripcion: 'Cambiaron artículos o el precio acordado.' },
  enviado:    { etiqueta: 'Enviado',    descripcion: 'Salió del depósito.' },
  entregado:  { etiqueta: 'Entregado',  descripcion: 'Llegó a destino.' },
  cancelado:  { etiqueta: 'Cancelado',  descripcion: 'No se despacha.' },
};

/** El camino normal, para dibujar la línea de tiempo. `cancelado` va aparte. */
const CAMINO = ['pendiente', 'confirmado', 'modificado', 'enviado', 'entregado'];

const TRANSICIONES = {
  // A 'modificado' no se llega eligiéndolo de una lista: se llega editando el
  // pedido. Un estado que dice que algo cambió sin que nada haya cambiado es
  // peor que no tenerlo.
  // Un pedido nuevo espera que se revise el stock: si está todo se confirma; si
  // falta algo se rearma y pasa a 'modificado'; si no se puede, se cancela.
  pendiente:  ['confirmado', 'cancelado'],
  confirmado: ['enviado', 'cancelado'],
  modificado: ['enviado', 'cancelado'],
  enviado:    ['entregado', 'cancelado'],
  entregado:  [],
  cancelado:  [],
};

/*
 * Los estados viejos se leen como los nuevos.
 *
 * La base de producción tiene pedidos en 'nuevo' y 'preparando', que es lo que
 * había antes de que esto fuera un seguimiento. Reescribirlos en una migración
 * sería tocar el historial del negocio para acomodar un nombre. Los pedidos
 * de ahora nacen en 'pendiente': 'nuevo' sólo lo tienen los que entraron antes
 * de que hubiera que confirmar el stock, y esos ya se daban por confirmados.
 */
const LEGADOS = { nuevo: 'confirmado', preparando: 'confirmado' };

function normalizarEstado(estado) {
  const e = String(estado || '').trim().toLowerCase();
  return ESTADOS[e] ? e : (LEGADOS[e] || 'confirmado');
}

const puedePasar = (desde, hasta) => (TRANSICIONES[normalizarEstado(desde)] || []).includes(hasta);

/*
 * El primer renglón del historial no se escribe cuando entra el pedido.
 *
 * Lo inserta `src/pedidos.js`, que arma el pedido y no sabe de seguimiento;
 * meterle esto ahí sería que dos archivos tengan que acordarse de lo mismo. Se
 * completa en el primer cambio, con la fecha real de cuando se confirmó, y
 * mientras tanto se muestra derivado del pedido: el resultado es el mismo y no
 * hay filas escritas por una lectura.
 */
/*
 * El primer paso de la línea de tiempo depende de cómo entró el pedido: los de
 * ahora esperan que se confirme el stock; los de antes ya entraban confirmados.
 */
const pasoInicial = (estado) => (normalizarEstado(estado) === 'pendiente'
  ? { estado: 'pendiente', nota: 'Recibimos tu pedido. Estamos revisando que tengamos todo el stock.' }
  : { estado: 'confirmado', nota: 'Recibimos tu pedido.' });

function asentarInicio(pedidoId) {
  const hay = db.prepare('SELECT COUNT(*) n FROM pedido_estados WHERE pedido_id = ?').get(pedidoId).n;
  if (hay) return;
  const p = db.prepare('SELECT creado_en, estado FROM pedidos WHERE id = ?').get(pedidoId);
  if (!p) return;
  // Se llama antes de cambiar el estado: todavía es el estado con el que entró.
  const inicio = pasoInicial(p.estado);
  db.prepare('INSERT INTO pedido_estados (pedido_id, estado, nota, fecha) VALUES (?, ?, ?, ?)')
    .run(pedidoId, inicio.estado, inicio.nota, p.creado_en);
}

/** Deja el pedido en `estado` y anota por qué. Devuelve la fila del historial. */
function registrarEstado(pedidoId, estado, { nota = null, cambios = null } = {}) {
  asentarInicio(pedidoId);
  const fecha = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO pedido_estados (pedido_id, estado, nota, cambios, fecha)
    VALUES (?, ?, ?, ?, ?)`)
    .run(pedidoId, estado, nota || null, cambios ? JSON.stringify(cambios) : null, fecha);
  db.prepare('UPDATE pedidos SET estado = ?, actualizado_en = ? WHERE id = ?').run(estado, fecha, pedidoId);
  return { id: info.lastInsertRowid, estado, nota, fecha };
}

/** La línea de tiempo del pedido, del más viejo al más nuevo. */
function historialDePedido(pedido) {
  const filas = db.prepare(`
    SELECT estado, nota, cambios, fecha FROM pedido_estados
    WHERE pedido_id = ? ORDER BY id`).all(pedido.id);

  if (!filas.length) {
    const actual = normalizarEstado(pedido.estado);
    const inicio = { ...pasoInicial(pedido.estado), cambios: null, fecha: pedido.creado_en };
    if (actual === 'confirmado' || actual === 'pendiente') return [inicio];
    /*
     * Un pedido de antes del seguimiento: se sabe dónde está, no cuándo llegó
     * ahí. Se dice así, sin fecha, en vez de inventarle una que parezca real.
     */
    return [inicio, { estado: actual, nota: null, cambios: null, fecha: pedido.actualizado_en || null }];
  }
  return filas.map((f) => ({ ...f, cambios: f.cambios ? JSON.parse(f.cambios) : null }));
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

module.exports = {
  db, DATA_DIR, FOTOS_DIR, ordenDeTalle, proximoNumeroDePedido, leerConfig, guardarConfig,
  ESTADOS, CAMINO, TRANSICIONES, normalizarEstado, puedePasar,
  registrarEstado, historialDePedido,
};
