const { db } = require('./db');

/*
 * Los clientes, reconocidos por su CUIT.
 *
 * Todo el que confirma un pedido queda registrado, con cuenta o sin ella: sin
 * cuenta es un cliente "reservado", con sus datos guardados para la próxima
 * compra y sus pedidos contados. Si después crea una cuenta con ese CUIT, la
 * cuenta ocupa ese mismo lugar y no se empieza de cero.
 *
 * La dirección de envío no identifica a nadie —el mismo cliente manda cada
 * pedido a otro lado—; lo que se repite es el CUIT.
 */
const texto = (v) => String(v ?? '').trim();
const cuitNumero = (cuit) => String(cuit ?? '').replace(/\D/g, '');
const normalizarEmail = (e) => texto(e).toLowerCase();

/** El cliente de un CUIT. Si hubiera más de uno, gana la cuenta, y entre iguales el más viejo. */
function buscarPorCuit(cuit) {
  const n = cuitNumero(cuit);
  if (n.length !== 11) return null;
  return db.prepare(`
    SELECT * FROM clientes WHERE cuit_numero = ?
    ORDER BY (password_hash IS NULL), id LIMIT 1`).get(n) || null;
}

/*
 * Registra la compra y devuelve a qué cliente queda atado el pedido.
 *
 * Con la sesión abierta, a la cuenta, sin tocarle nada: sus datos los cambia
 * el dueño desde «Mi cuenta». Sin sesión, al cliente de ese CUIT; si es un
 * reservado, se le guardan los datos de esta compra, que son los más nuevos.
 * Una cuenta no se modifica desde un pedido sin sesión: cualquiera que sepa un
 * CUIT podría cambiarle el teléfono o el email al dueño.
 */
function registrarCompra(cliente, { cuentaId = null } = {}) {
  if (cuentaId) return cuentaId;
  const datos = {
    nombre: texto(cliente.nombre), cuit: texto(cliente.cuit), cuitNumero: cuitNumero(cliente.cuit),
    telefono: texto(cliente.telefono), email: normalizarEmail(cliente.email) || null,
    provincia: texto(cliente.provincia), ciudad: texto(cliente.ciudad), codigoPostal: texto(cliente.codigoPostal),
    direccion: texto(cliente.direccion), entreCalles: texto(cliente.entreCalles), formaEnvio: texto(cliente.formaEnvio),
  };
  const existente = buscarPorCuit(datos.cuit);
  if (existente) {
    if (!existente.password_hash) {
      db.prepare(`
        UPDATE clientes SET nombre = @nombre, cuit = @cuit, telefono = @telefono,
          email = COALESCE(@email, email), provincia = @provincia, ciudad = @ciudad,
          codigo_postal = @codigoPostal, direccion = @direccion, entre_calles = @entreCalles,
          forma_envio = @formaEnvio
        WHERE id = @id`).run({ ...datos, id: existente.id });
    }
    return existente.id;
  }
  return Number(db.prepare(`
    INSERT INTO clientes (email, password_hash, nombre, cuit, cuit_numero, telefono, provincia, ciudad,
                          codigo_postal, direccion, entre_calles, forma_envio, creado_en)
    VALUES (@email, NULL, @nombre, @cuit, @cuitNumero, @telefono, @provincia, @ciudad,
            @codigoPostal, @direccion, @entreCalles, @formaEnvio, @creadoEn)`)
    .run({ ...datos, creadoEn: new Date().toISOString() }).lastInsertRowid);
}

// ── Completar los datos por CUIT, sin mostrarlos ────────────────────
/*
 * Al escribir el CUIT el formulario se completa con lo que ya se sabe de ese
 * cliente. Pero la página es pública: devolver el teléfono y el email de
 * cualquier CUIT es regalar la lista de clientes del mayorista, con sus
 * contactos, a quien pruebe números. Así que el nombre viaja completo —es lo
 * que el cliente reconoce, y el de un CUIT es público— y el teléfono y el
 * email viajan tapados: "•• ••••-1234", "ma•••@gmail.com".
 *
 * Si el cliente deja los datos tapados tal cual, el servidor pone los reales
 * al guardar el pedido. Si escribe otros, se usan los que escribió.
 */
function mascaraTelefono(t) {
  const s = texto(t);
  const digitos = s.replace(/\D/g, '').length;
  if (!s) return '';
  if (digitos < 6) return '••••';
  let tapar = digitos - 4;
  return s.replace(/\d/g, (d) => (tapar-- > 0 ? '•' : d));
}

function mascaraEmail(e) {
  const s = texto(e);
  const i = s.indexOf('@');
  if (!s) return '';
  if (i < 1) return '•••';
  return `${s.slice(0, Math.min(2, i))}•••${s.slice(i)}`;
}

const MASCARAS = { telefono: mascaraTelefono, email: mascaraEmail };

function datosParaAutocompletar(cuit) {
  const c = buscarPorCuit(cuit);
  if (!c) return { encontrado: false };
  return { encontrado: true, nombre: c.nombre, telefono: mascaraTelefono(c.telefono), email: mascaraEmail(c.email) };
}

/** Pone los datos reales donde el formulario trajo los tapados. Dice cuáles fueron. */
function completarConGuardados(datos = {}) {
  const guardado = buscarPorCuit(datos.cuit);
  const resultado = { ...datos };
  const ocultos = [];
  if (guardado) {
    for (const [campo, mascara] of Object.entries(MASCARAS)) {
      const valor = texto(datos[campo]);
      const real = texto(guardado[campo]);
      if (valor && real && valor === mascara(real)) {
        resultado[campo] = real;
        ocultos.push(campo);
      }
    }
  }
  return { datos: resultado, ocultos };
}

/** Vuelve a tapar lo que salió de lo guardado, para mostrárselo a quien no tiene por qué verlo. */
function enmascarar(cliente, ocultos = []) {
  const copia = { ...cliente };
  for (const campo of ocultos) if (MASCARAS[campo]) copia[campo] = MASCARAS[campo](copia[campo]);
  return copia;
}

// ── Qué pedidos ve una cuenta ───────────────────────────────────────
/*
 * Crear una cuenta con un CUIT no da derecho a ver lo que otros pidieron antes
 * con ese CUIT: el CUIT de un negocio no es un secreto. En «Mis pedidos» se ven
 * los hechos con la sesión abierta y los que dejaron el mismo email de la
 * cuenta —ese sí lo tuvo que confirmar quien la creó—.
 */
const FILTRO_VISIBLE_SQL = "(con_sesion = 1 OR lower(json_extract(cliente, '$.email')) = lower(?))";

function visibleEnCuenta(fila, cuenta) {
  if (!fila || !cuenta || Number(fila.cliente_id) !== Number(cuenta.id)) return false;
  if (fila.con_sesion) return true;
  let c = fila.cliente;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
  return Boolean(cuenta.email) && normalizarEmail(c?.email) === normalizarEmail(cuenta.email);
}

/** Si el cliente de este pedido lo puede seguir desde su cuenta. */
function seVeEnCuenta(pedido) {
  if (!pedido?.cliente_id) return false;
  const cuenta = db.prepare('SELECT id, email, password_hash FROM clientes WHERE id = ?').get(pedido.cliente_id);
  return Boolean(cuenta?.password_hash) && visibleEnCuenta(pedido, cuenta);
}

/*
 * Los pedidos de antes, atados a su cliente.
 *
 * Hasta ahora un pedido sin sesión no quedaba atado a nadie. Al arrancar se
 * atan por CUIT, del más viejo al más nuevo —así los datos que quedan
 * guardados son los de la última compra—. Los siguientes arranques no
 * encuentran nada que hacer.
 */
function completarClientesDePedidos() {
  const sueltos = db.prepare('SELECT id, cliente FROM pedidos WHERE cliente_id IS NULL ORDER BY id').all();
  if (!sueltos.length) return 0;
  let atados = 0;
  const poner = db.prepare('UPDATE pedidos SET cliente_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const p of sueltos) {
      let c;
      try { c = JSON.parse(p.cliente); } catch { continue; }
      if (cuitNumero(c?.cuit).length !== 11) continue;
      poner.run(registrarCompra(c), p.id);
      atados += 1;
    }
  })();
  if (atados) console.log(`  clientes: ${atados} pedidos atados a su cliente por CUIT`);
  return atados;
}

module.exports = {
  cuitNumero, buscarPorCuit, registrarCompra,
  mascaraTelefono, mascaraEmail, datosParaAutocompletar, completarConGuardados, enmascarar,
  FILTRO_VISIBLE_SQL, visibleEnCuenta, seVeEnCuenta, completarClientesDePedidos,
};
