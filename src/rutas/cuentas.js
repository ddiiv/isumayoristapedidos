const crypto = require('node:crypto');
const express = require('express');
const { db, ESTADOS, normalizarEstado, historialDePedido } = require('../db');
const auth = require('../auth');
const { validarCliente, cuitValido } = require('../pedidos');

const r = express.Router();

/*
 * Entrar, registrarse y ver la propia cuenta.
 *
 * Una sola puerta: el mismo formulario para el dueño y para los clientes. El
 * servidor mira quién sos y devuelve el rol; la pantalla se acomoda a eso.
 */

const normalizarEmail = (v) => String(v || '').trim().toLowerCase();

const emailDelAdmin = () => normalizarEmail(
  process.env.ADMIN_EMAIL || process.env.PEDIDOS_EMAIL || '',
);

/*
 * Un intento por segundo y por IP.
 *
 * No pretende ser un limitador serio —para eso hay que guardar estado—, pero
 * corta el caso que importa acá: alguien probando un diccionario contra el
 * login desde un script. Una persona nunca lo nota.
 */
const ultimoIntento = new Map();
function demasiadoSeguido(req) {
  const ip = req.ip || 'sin-ip';
  const ahora = Date.now();
  const previo = ultimoIntento.get(ip) || 0;
  ultimoIntento.set(ip, ahora);
  // La lista se limpia sola: sin esto, cada IP que alguna vez entró queda
  // guardada para siempre y el proceso crece sin techo.
  if (ultimoIntento.size > 5000) ultimoIntento.clear();
  return ahora - previo < 1000;
}

/*
 * Un techo por ventana de tiempo, para lo que no es el login.
 *
 * El de arriba —uno por segundo— sirve contra un diccionario probado contra
 * el login. Para el alta de cuentas y el cambio de contraseña no alcanza: un
 * script paciente, a un pedido por segundo, da de alta tres mil seiscientas
 * cuentas por hora. Acá se cuenta cuántas veces en la ventana y se corta al
 * pasar el número, que es holgado para una persona.
 */
function limitePorVentana(cuantos, ms) {
  const visto = new Map();
  return (clave) => {
    const ahora = Date.now();
    if (visto.size > 5000) visto.clear();
    const v = visto.get(clave);
    if (!v || ahora - v.desde > ms) { visto.set(clave, { desde: ahora, n: 1 }); return false; }
    v.n += 1;
    return v.n > cuantos;
  };
}
const demasiadasAltas = limitePorVentana(20, 60 * 60_000);      // por IP
const demasiadosCambiosDeClave = limitePorVentana(5, 10 * 60_000); // por cuenta

/*
 * Un hash de relleno para que "no existe" cueste lo mismo que "existe".
 *
 * Con el email equivocado el login contestaba sin correr scrypt y con uno
 * registrado lo corría: el mensaje era el mismo, pero el reloj no. Medido,
 * 6,9 ms contra 61,5 ms —casi nueve veces—, suficiente para armar la lista de
 * clientes de un mayorista probando emails. Se verifica siempre contra algo,
 * y cuando no hay cuenta, contra esto.
 */
const HASH_DE_RELLENO = auth.hashear(crypto.randomBytes(16).toString('hex'));

// GET /api/sesion — quién soy. La usa la pantalla al cargar.
r.get('/sesion', (req, res) => {
  if (req.sesion?.rol === 'admin') return res.json({ rol: 'admin' });
  if (req.sesion?.rol === 'cliente') {
    return res.json({
      rol: 'cliente',
      cliente: auth.sinPassword(req.sesion.cliente),
      datosDePedido: auth.datosDePedido(req.sesion.cliente),
    });
  }
  res.json({ rol: null, panelConfigurado: auth.panelConfigurado() });
});

/*
 * POST /api/sesion — entrar.
 *
 * Primero se prueba si es el dueño y después si es un cliente. El mensaje de
 * error es el mismo para las dos ramas y para "no existe esa cuenta": si
 * dijera "esa cuenta no existe", el formulario se convierte en una forma de
 * averiguar qué emails están registrados.
 */
r.post('/sesion', (req, res) => {
  if (demasiadoSeguido(req)) {
    return res.status(429).json({ message: 'Esperá un segundo y probá de nuevo.' });
  }

  const email = normalizarEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ message: 'Escribí tu email y tu contraseña.' });
  }

  // ── ¿Es el dueño?
  const claveAdmin = process.env.ADMIN_PASSWORD;
  if (claveAdmin && email === emailDelAdmin()) {
    // Se paga el mismo scrypt que un cliente: si esta rama contestara más
    // rápido, el email del dueño se reconocería por el tiempo.
    auth.verificar(password, HASH_DE_RELLENO);
    const a = Buffer.from(password);
    const b = Buffer.from(claveAdmin);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) {
      auth.ponerCookie(res, req, { rol: 'admin' });
      return res.json({ rol: 'admin' });
    }
    // Con el email del dueño y la clave equivocada NO se sigue buscando entre
    // los clientes: sería decirle a quien prueba que ese email es especial.
    return res.status(401).json({ message: 'Email o contraseña incorrectos.' });
  }

  // ── ¿Es un cliente?
  const cliente = db.prepare('SELECT * FROM clientes WHERE email = ?').get(email);
  const coincide = auth.verificar(password, cliente ? cliente.password_hash : HASH_DE_RELLENO);
  if (!cliente || !coincide) {
    return res.status(401).json({ message: 'Email o contraseña incorrectos.' });
  }
  if (!cliente.activo) {
    return res.status(403).json({ message: 'Tu cuenta está desactivada. Escribinos para reactivarla.' });
  }

  db.prepare('UPDATE clientes SET ultimo_acceso = ? WHERE id = ?').run(new Date().toISOString(), cliente.id);
  auth.ponerCookie(res, req, { rol: 'cliente', id: cliente.id });
  res.json({
    rol: 'cliente',
    cliente: auth.sinPassword(cliente),
    datosDePedido: auth.datosDePedido(cliente),
  });
});

r.delete('/sesion', (req, res) => {
  auth.borrarCookie(res);
  res.json({ ok: true });
});

/*
 * POST /api/cuenta — registrarse.
 *
 * Se piden los mismos datos que el pedido, para que al comprar ya estén
 * cargados. Es la razón de tener cuenta: quien pide todas las semanas no
 * vuelve a tipear su dirección cada vez.
 */
r.post('/cuenta', (req, res) => {
  if (demasiadasAltas(req.ip || 'sin-ip')) {
    return res.status(429).json({ message: 'Se crearon muchas cuentas desde esta conexión. Probá más tarde.' });
  }
  const email = normalizarEmail(req.body?.email);
  const password = String(req.body?.password || '');

  const { cliente, errores } = validarCliente({ ...req.body, email });
  if (!email) errores.email = 'El email es obligatorio para tener cuenta.';
  if (password.length < 8) errores.password = 'La contraseña tiene que tener al menos 8 caracteres.';
  if (Object.keys(errores).length) {
    return res.status(400).json({ message: 'Revisá los datos.', errores });
  }

  const existe = db.prepare('SELECT id FROM clientes WHERE email = ?').get(email);
  if (existe) {
    return res.status(409).json({
      message: 'Ya hay una cuenta con ese email. Entrá con tu contraseña o escribinos si la olvidaste.',
      errores: { email: 'Ya está registrado.' },
    });
  }
  if (email === emailDelAdmin()) {
    return res.status(409).json({ message: 'Ese email no se puede usar.', errores: { email: 'No disponible.' } });
  }

  const info = db.prepare(`
    INSERT INTO clientes (email, password_hash, nombre, cuit, telefono, provincia, ciudad,
                          codigo_postal, direccion, entre_calles, forma_envio, creado_en)
    VALUES (@email, @hash, @nombre, @cuit, @telefono, @provincia, @ciudad,
            @codigoPostal, @direccion, @entreCalles, @formaEnvio, @creadoEn)`)
    .run({
      email, hash: auth.hashear(password),
      nombre: cliente.nombre, cuit: cliente.cuit, telefono: cliente.telefono,
      provincia: cliente.provincia, ciudad: cliente.ciudad, codigoPostal: cliente.codigoPostal,
      direccion: cliente.direccion, entreCalles: cliente.entreCalles, formaEnvio: cliente.formaEnvio,
      creadoEn: new Date().toISOString(),
    });

  const nuevo = db.prepare('SELECT * FROM clientes WHERE id = ?').get(info.lastInsertRowid);
  auth.ponerCookie(res, req, { rol: 'cliente', id: nuevo.id });
  res.status(201).json({
    rol: 'cliente', cliente: auth.sinPassword(nuevo), datosDePedido: auth.datosDePedido(nuevo),
  });
});

/*
 * POST /api/faltantes — alguien quiso un cruce que la grilla no tiene.
 *
 * El catálogo no lleva stock: lo que "no hay" es el color en ese talle, que
 * simplemente no existe como variante. Ese pedido perdido hoy no deja rastro
 * en ningún lado, y es exactamente el dato que dice qué conviene producir.
 *
 * Sin cuenta y sin guardar quién fue: lo que sirve es el cruce, no la persona.
 * Se comprueba contra el catálogo antes de anotar —producto visible y cruce
 * realmente inexistente—, porque un endpoint abierto que escribe lo que le
 * dicen es una tabla de estadísticas que cualquiera puede llenar de mentiras.
 */
const anotados = new Map();
function demasiadosFaltantes(req) {
  const ip = req.ip || 'sin-ip';
  const hora = Math.floor(Date.now() / 3600000);
  const previo = anotados.get(ip);
  if (!previo || previo.hora !== hora) { anotados.set(ip, { hora, n: 1 }); return false; }
  if (anotados.size > 5000) anotados.clear();
  previo.n += 1;
  return previo.n > 120;
}

r.post('/faltantes', (req, res) => {
  const sku = String(req.body?.sku || '').trim();
  const color = String(req.body?.color || '').trim().slice(0, 60);
  const talle = String(req.body?.talle || '').trim().slice(0, 30);
  if (!sku || !talle) return res.json({ ok: true, registrado: false });
  if (demasiadosFaltantes(req)) return res.json({ ok: true, registrado: false });

  const producto = db.prepare('SELECT id FROM productos WHERE sku_agrupador = ? AND visible = 1').get(sku);
  if (!producto) return res.json({ ok: true, registrado: false });

  const existe = db.prepare(`
    SELECT 1 FROM variantes v
    LEFT JOIN colores c ON c.id = v.color_id
    LEFT JOIN talles  t ON t.id = v.talle_id
    WHERE v.producto_id = ?
      AND COALESCE(c.nombre, v.color) = ?
      AND COALESCE(t.nombre, v.talle) = ?`).get(producto.id, color, talle);
  if (existe) return res.json({ ok: true, registrado: false });

  db.prepare('INSERT INTO faltantes (producto_id, color, talle, fecha) VALUES (?,?,?,?)')
    .run(producto.id, color, talle, new Date().toISOString());
  res.json({ ok: true, registrado: true });
});

// ── De acá para abajo hay que ser cliente ─────────────────────────
r.use('/cuenta', auth.exigirCliente);

// PUT /api/cuenta — editar mis datos
r.put('/cuenta', (req, res) => {
  const actual = req.sesion.cliente;
  const { cliente, errores } = validarCliente({ ...auth.datosDePedido(actual), ...req.body });
  if (Object.keys(errores).length) {
    return res.status(400).json({ message: 'Revisá los datos.', errores });
  }

  db.prepare(`
    UPDATE clientes SET nombre=@nombre, cuit=@cuit, telefono=@telefono, provincia=@provincia,
      ciudad=@ciudad, codigo_postal=@codigoPostal, direccion=@direccion,
      entre_calles=@entreCalles, forma_envio=@formaEnvio
    WHERE id=@id`)
    .run({ ...cliente, codigoPostal: cliente.codigoPostal, id: actual.id });

  const nuevo = db.prepare('SELECT * FROM clientes WHERE id = ?').get(actual.id);
  res.json({ cliente: auth.sinPassword(nuevo), datosDePedido: auth.datosDePedido(nuevo) });
});

// PUT /api/cuenta/password — cambiar la contraseña
r.put('/cuenta/password', (req, res) => {
  /*
   * Por cuenta y no por IP: quien tiene una sesión robada podría usar este
   * formulario para adivinar la contraseña actual sin pasar por el límite
   * del login, y cambiar de conexión no le serviría de nada.
   */
  if (demasiadosCambiosDeClave(req.sesion.cliente.id)) {
    return res.status(429).json({ message: 'Demasiados intentos. Esperá unos minutos.' });
  }
  const actual = String(req.body?.actual || '');
  const nueva = String(req.body?.nueva || '');
  if (!auth.verificar(actual, req.sesion.cliente.password_hash)) {
    return res.status(400).json({ message: 'La contraseña actual no es correcta.' });
  }
  if (nueva.length < 8) {
    return res.status(400).json({ message: 'La contraseña nueva tiene que tener al menos 8 caracteres.' });
  }
  db.prepare('UPDATE clientes SET password_hash = ? WHERE id = ?')
    .run(auth.hashear(nueva), req.sesion.cliente.id);
  res.json({ ok: true });
});

/*
 * GET /api/cuenta/pedidos — mis pedidos, con el seguimiento adentro.
 *
 * La línea de tiempo viene en la misma respuesta y no en cien pedidos aparte:
 * son tres o cuatro renglones por pedido, y traerlos de a uno al desplegar
 * cada tarjeta hace que la pantalla parpadee en cada clic por ahorrar bytes
 * que no pesan.
 */
r.get('/cuenta/pedidos', (req, res) => {
  const filas = db.prepare(`
    SELECT id, numero, total, unidades, estado, creado_en, actualizado_en, ajuste,
           original IS NOT NULL AS fueModificado
    FROM pedidos WHERE cliente_id = ? ORDER BY id DESC LIMIT 100`).all(req.sesion.cliente.id);

  res.json({
    estados: ESTADOS,
    pedidos: filas.map((f) => ({
      numero: f.numero,
      total: f.total,
      unidades: f.unidades,
      creado_en: f.creado_en,
      actualizado_en: f.actualizado_en,
      estado: normalizarEstado(f.estado),
      fueModificado: Boolean(f.fueModificado),
      ajuste: f.ajuste ? JSON.parse(f.ajuste) : null,
      historial: historialDePedido(f),
    })),
  });
});

/*
 * GET /api/cuenta/pedidos/:numero — el detalle de UN pedido mío.
 *
 * Con el pedido original al lado cuando se lo modificó. Que el cliente vea qué
 * confirmó él y qué se le va a despachar es la mitad de lo que pidió el dueño:
 * la otra mitad, la línea de tiempo, ya viene en la lista.
 */
r.get('/cuenta/pedidos/:numero', (req, res) => {
  const fila = db.prepare('SELECT * FROM pedidos WHERE numero = ? AND cliente_id = ?')
    .get(String(req.params.numero), req.sesion.cliente.id);
  // Mismo 404 que si no existiera: un 403 acá le diría a quien prueba números
  // cuáles pedidos son de otro.
  if (!fila) return res.status(404).json({ message: 'No existe ese pedido.' });

  res.json({
    pedido: {
      numero: fila.numero,
      total: fila.total,
      unidades: fila.unidades,
      creado_en: fila.creado_en,
      actualizado_en: fila.actualizado_en,
      estado: normalizarEstado(fila.estado),
      items: JSON.parse(fila.items),
      ajuste: fila.ajuste ? JSON.parse(fila.ajuste) : null,
      original: fila.original ? JSON.parse(fila.original) : null,
      historial: historialDePedido(fila),
    },
  });
});

module.exports = { rutas: r, cuitValido };
