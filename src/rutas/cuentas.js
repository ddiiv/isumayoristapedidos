const crypto = require('node:crypto');
const express = require('express');
const { db } = require('../db');
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
  res.json({ rol: null, panelConfigurado: Boolean(auth.secretoDelServidor()) });
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
  if (!cliente || !auth.verificar(password, cliente.password_hash)) {
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

// GET /api/cuenta/pedidos — mis pedidos
r.get('/cuenta/pedidos', (req, res) => {
  const filas = db.prepare(`
    SELECT numero, total, unidades, estado, creado_en
    FROM pedidos WHERE cliente_id = ? ORDER BY id DESC LIMIT 100`).all(req.sesion.cliente.id);
  res.json({ pedidos: filas });
});

module.exports = { rutas: r, cuitValido };
