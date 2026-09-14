const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, leerConfig, guardarConfig } = require('./db');

/*
 * El aviso de pedidos nuevos al grupo de WhatsApp de los empleados.
 *
 * Conecta un WhatsApp común —como WhatsApp Web, escaneando un QR desde el
 * teléfono— y escribe en un grupo que ya existe. La API oficial de Meta sólo
 * escribe en grupos creados por ella, de hasta ocho personas y con una cuenta
 * verificada; el negocio eligió este camino sabiendo lo que implica:
 *
 *  · No es oficial y va contra las condiciones de WhatsApp: el número puede
 *    quedar bloqueado. Conviene un número aparte, no el principal del negocio.
 *  · La conexión se puede cortar. Por eso nada de esto frena un pedido: si
 *    WhatsApp no está, el pedido entra igual, el mail sale igual, y el panel
 *    anota que el WhatsApp no salió.
 *  · La sesión se guarda en el volumen, así un deploy no obliga a escanear de
 *    nuevo el QR.
 *  · Tiene que correr una sola copia del servidor: dos copias con la misma
 *    sesión se desconectan entre sí.
 *
 * La librería se carga recién cuando se vincula o hay una sesión guardada: son
 * cincuenta megas que un servidor sin WhatsApp no tiene por qué levantar.
 */
const CARPETA = path.join(DATA_DIR, 'whatsapp-sesion');
const hayCredenciales = () => fs.existsSync(path.join(CARPETA, 'creds.json'));

const estado = { conexion: 'apagado', qr: null, numero: null, error: null };
let sock = null;
let reintento = null;
let intentos = 0;
let apagando = false;

const pesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const conEstado = (mensaje, status) => Object.assign(new Error(mensaje), { status });

function grupoElegido() {
  try { return JSON.parse(leerConfig('whatsapp_grupo') || 'null'); } catch { return null; }
}

function borrarSesion() {
  fs.rmSync(CARPETA, { recursive: true, force: true });
}

function fallo(e) {
  estado.conexion = 'error';
  estado.error = String(e?.message || e).slice(0, 200);
}

async function conectar() {
  const {
    makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers,
  } = require('baileys');
  const QRCode = require('qrcode');

  clearTimeout(reintento);
  apagando = false;
  estado.conexion = 'conectando';
  estado.error = null;
  fs.mkdirSync(CARPETA, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CARPETA);
  let version;
  // La versión del protocolo que usa WhatsApp Web hoy; si no se puede averiguar, va la que trae la librería.
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* sigue con la de la librería */ }

  const este = makeWASocket({
    auth: state,
    logger: require('pino')({ level: 'silent' }),
    ...(version ? { version } : {}),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = este;

  este.ev.on('creds.update', saveCreds);
  este.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (este !== sock) return;   // un socket viejo que todavía avisa algo

    if (qr) {
      estado.conexion = 'esperando-qr';
      estado.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
    }
    if (connection === 'open') {
      intentos = 0;
      Object.assign(estado, { conexion: 'conectado', qr: null, error: null });
      estado.numero = String(este.user?.id || '').split(':')[0].split('@')[0] || null;
    }
    if (connection !== 'close') return;

    estado.qr = null;
    if (apagando) { estado.conexion = 'apagado'; return; }
    const codigo = lastDisconnect?.error?.output?.statusCode;

    if (codigo === DisconnectReason.loggedOut) {
      borrarSesion();
      Object.assign(estado, {
        conexion: 'desvinculado', numero: null,
        error: 'Se desvinculó desde el teléfono. Vinculalo de nuevo para seguir mandando los pedidos al grupo.',
      });
      return;
    }
    /*
     * Si nunca se llegó a escanear el QR, no se reintenta: se generarían códigos
     * nuevos para siempre sin que nadie mire. Queda apagado hasta que alguien
     * toque "Vincular" otra vez. El reinicio que pide WhatsApp justo después de
     * escanear sí se hace, y en el acto.
     */
    const vinculado = Boolean(state.creds?.me || state.creds?.registered);
    if (codigo === DisconnectReason.restartRequired) { conectar().catch(fallo); return; }
    if (!vinculado) {
      Object.assign(estado, { conexion: 'apagado', error: 'El QR venció sin escanearse. Tocá "Vincular" para generar otro.' });
      return;
    }
    // Cualquier otro corte con la sesión ya vinculada: se reintenta, cada vez esperando más, hasta un minuto.
    intentos += 1;
    Object.assign(estado, { conexion: 'reconectando', error: lastDisconnect?.error?.message || null });
    reintento = setTimeout(() => conectar().catch(fallo), Math.min(60000, 2000 * 2 ** Math.min(intentos, 5)));
  });
}

function estadoPublico() {
  return {
    conexion: estado.conexion,
    qr: estado.conexion === 'esperando-qr' ? estado.qr : null,
    numero: estado.numero,
    error: estado.error,
    grupo: grupoElegido(),
  };
}

async function vincular() {
  const enCurso = ['conectado', 'conectando', 'esperando-qr', 'reconectando'].includes(estado.conexion);
  if (!(enCurso && sock)) await conectar();
  return estadoPublico();
}

async function desvincular() {
  apagando = true;
  clearTimeout(reintento);
  try { await sock?.logout(); } catch { /* ya estaba cortado */ }
  try { sock?.end?.(undefined); } catch { /* idem */ }
  sock = null;
  borrarSesion();
  guardarConfig('whatsapp_grupo', '');
  Object.assign(estado, { conexion: 'apagado', qr: null, numero: null, error: null });
  return estadoPublico();
}

/** Al apagar el servidor: corta la conexión sin desvincular, para retomarla al volver. */
function apagar() {
  apagando = true;
  clearTimeout(reintento);
  try { sock?.end?.(undefined); } catch { /* ya estaba cortado */ }
}

/** Al arrancar: si ya había una sesión vinculada, se reconecta sola. */
function arrancarSiHaySesion() {
  if (hayCredenciales()) conectar().catch(fallo);
}

async function grupos() {
  if (estado.conexion !== 'conectado' || !sock) throw conEstado('WhatsApp no está conectado.', 409);
  const todos = await sock.groupFetchAllParticipating();
  return Object.values(todos)
    .map((g) => ({ id: g.id, nombre: g.subject || '(sin nombre)', integrantes: g.participants?.length || 0 }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

async function elegirGrupo(id) {
  const g = (await grupos()).find((x) => x.id === id);
  if (!g) throw conEstado('Ese grupo no está entre los grupos de este WhatsApp.', 400);
  guardarConfig('whatsapp_grupo', JSON.stringify({ id: g.id, nombre: g.nombre }));
  return g;
}

/** Hay grupo elegido: el aviso de pedidos va por acá y no por la API de Meta. */
const configurado = () => Boolean(grupoElegido()?.id);

function resumenDelPedido(p) {
  const c = p.cliente || {};
  return [
    `*Pedido ${p.numero}* — esperando confirmación de stock`,
    `${c.nombre || ''}${c.cuit ? ` (CUIT ${c.cuit})` : ''}${c.telefono ? ` · Tel. ${c.telefono}` : ''}`,
    `${p.unidades} u. — ${pesos(p.total)}`,
    `Envío: ${c.formaEnvio || '—'} · ${c.ciudad || ''} (${c.codigoPostal || ''}), ${c.provincia || ''}`,
    'Confirmalo, rearmalo o cancelalo desde el panel → Pedidos.',
  ].join('\n');
}

/*
 * El pedido al grupo: el PDF con el resumen como texto del mensaje.
 *
 * A diferencia de la API de Meta, que pide el documento por una dirección
 * pública, acá el PDF se manda directo, sin publicar los datos del cliente en
 * ningún lado.
 *
 * El socket, el grupo y el tope de espera se pueden pasar de afuera: así se
 * prueba sin un WhatsApp de verdad y sin esperar veinte segundos.
 */
async function avisarGrupo(pedido, pdf, {
  socket = sock, grupo = grupoElegido(), conectado = estado.conexion === 'conectado', tope = 20000,
} = {}) {
  if (!grupo?.id) return { ok: false, motivo: 'sin grupo de WhatsApp elegido' };
  if (!socket || !conectado) return { ok: false, motivo: 'WhatsApp desconectado' };
  const envio = pdf
    ? socket.sendMessage(grupo.id, {
      document: pdf, mimetype: 'application/pdf', fileName: `${pedido.numero}-pedido.pdf`, caption: resumenDelPedido(pedido),
    })
    : socket.sendMessage(grupo.id, { text: resumenDelPedido(pedido) });
  // Un envío que no contesta no puede dejar colgada la confirmación del pedido.
  let espera;
  const limite = new Promise((_, no) => {
    espera = setTimeout(() => no(new Error('WhatsApp no contestó a tiempo')), tope);
  });
  try { await Promise.race([envio, limite]); } finally { clearTimeout(espera); }
  return { ok: true };
}

async function mandarPrueba() {
  const grupo = grupoElegido();
  if (!grupo?.id) throw conEstado('Elegí primero el grupo.', 409);
  if (estado.conexion !== 'conectado' || !sock) throw conEstado('WhatsApp no está conectado.', 409);
  await sock.sendMessage(grupo.id, {
    text: 'Prueba del portal ISUWAYA Mayorista: los pedidos nuevos van a llegar a este grupo, con el PDF.',
  });
  return { ok: true, grupo };
}

module.exports = {
  vincular, desvincular, apagar, arrancarSiHaySesion, grupos, elegirGrupo, configurado,
  avisarGrupo, mandarPrueba, estadoPublico, resumenDelPedido,
};
