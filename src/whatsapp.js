const crypto = require('node:crypto');
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
 *
 * La librería se carga recién cuando se vincula o hay una sesión guardada: son
 * cincuenta megas que un servidor sin WhatsApp no tiene por qué levantar.
 *
 * ── Por qué el número se salía solo ──────────────────────────────────
 *
 * Vinculaba bien y mandaba bien, y al rato aparecía desvinculado. Eran tres
 * cosas, y las tres están cubiertas acá:
 *
 *  1. DOS COPIAS CON LA MISMA SESIÓN. Al desplegar, Railway levanta la copia
 *     nueva ANTES de bajar la vieja, y las dos leen la misma sesión del
 *     volumen. WhatsApp admite una sola conexión por dispositivo: echa a una
 *     (código 440), que acá se reconectaba y echaba a la otra. En esa pelea
 *     WhatsApp termina sacando el dispositivo de la lista del teléfono, y eso
 *     ya no se arregla sin escanear otro QR. Ahora hay un cerrojo con latido en
 *     el volumen: la copia nueva espera a que la vieja suelte la sesión, y un
 *     440 no se pelea, se cede.
 *  2. LA SESIÓN SE ROMPÍA AL APAGAR. La librería guarda las credenciales con
 *     un writeFile común. Si el proceso muere en medio de esa escritura —un
 *     deploy, un reinicio—, el archivo queda cortado; al arrancar no se puede
 *     leer y la librería crea una identidad nueva, en silencio: el servidor
 *     pide QR y en el teléfono queda un dispositivo fantasma. Ahora, de cada
 *     sesión buena queda un respaldo, y si el archivo aparece roto se restaura.
 *  3. UN ERROR AL CONECTAR DEJABA TODO APAGADO. Cualquier falla al levantar la
 *     conexión anotaba el error y no reintentaba nunca más: quedaba caído hasta
 *     que alguien entrara al panel. Ahora se reintenta siempre, esperando cada
 *     vez un poco más, y un vigilante mira que el socket siga vivo.
 */
const CARPETA = path.join(DATA_DIR, 'whatsapp-sesion');
const CREDENCIALES = path.join(CARPETA, 'creds.json');
const RESPALDO = path.join(CARPETA, 'creds-respaldo.json');
const CERROJO = path.join(CARPETA, 'en-uso.json');

const LATIDO = 15_000;            // cada cuánto la copia que usa la sesión dice que sigue viva
const CERROJO_VENCIDO = 45_000;   // sin latido por más de esto, la copia ya no está
const VIGILANCIA = 60_000;        // cada cuánto se mira que el socket siga abierto
const ESPERA_MAXIMA = 60_000;     // tope de la espera entre reintentos
const ESPERA_CEDIENDO = 30_000;   // cuánto esperar cuando otra copia tiene la sesión
const TOPE_SESION_ROTA = 3;       // cortes seguidos por sesión ilegible antes de pedir otro QR

const estado = { conexion: 'apagado', qr: null, numero: null, error: null };
let sock = null;
let reintento = null;
let latido = null;
let vigilante = null;
let intentos = 0;
let sesionesRotas = 0;
let apagando = false;
let cerrojoPropio = false;

/*
 * Quién es esta copia del servidor.
 *
 * No alcanza con el número de proceso: dentro de un contenedor casi siempre es
 * el 1, así que la copia nueva de un deploy y la vieja tendrían el mismo y cada
 * una creería que el cerrojo es suyo — justo lo que este cerrojo evita.
 */
const INSTANCIA = crypto.randomBytes(8).toString('hex');

const pesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });
const conEstado = (mensaje, status) => Object.assign(new Error(mensaje), { status });

function grupoElegido() {
  try { return JSON.parse(leerConfig('whatsapp_grupo') || 'null'); } catch { return null; }
}

// ── La sesión guardada ────────────────────────────────────────────
function leerJSON(ruta) {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return null; }
}

/*
 * Escribir en un temporal y recién ahí renombrar.
 *
 * Renombrar es atómico: o está el archivo viejo entero o el nuevo entero, nunca
 * uno cortado a la mitad. Es justo lo que le falta a la librería y lo que hacía
 * que un apagón en el momento justo dejara la sesión ilegible.
 */
function escribirAtomico(ruta, texto) {
  const temporal = `${ruta}.tmp`;
  fs.writeFileSync(temporal, texto);
  fs.renameSync(temporal, ruta);
}

/** Una sesión sirve si dice de qué número es: recién ahí está vinculada. */
const sesionUsable = (creds) => Boolean(creds && (creds.me || creds.registered));
const hayCredenciales = () => sesionUsable(leerJSON(CREDENCIALES)) || sesionUsable(leerJSON(RESPALDO));

function respaldarCredenciales() {
  const creds = leerJSON(CREDENCIALES);
  if (!sesionUsable(creds)) return;
  // El respaldo es de lujo: si falla, no vale la pena romper la conexión por él.
  try { escribirAtomico(RESPALDO, JSON.stringify(creds)); } catch { /* se intenta en la próxima */ }
}

/** Devuelve true si hubo que recuperar la sesión de un archivo roto o borrado. */
function restaurarCredenciales() {
  if (sesionUsable(leerJSON(CREDENCIALES))) return false;
  const respaldo = leerJSON(RESPALDO);
  if (!sesionUsable(respaldo)) return false;
  try {
    fs.mkdirSync(CARPETA, { recursive: true });
    escribirAtomico(CREDENCIALES, JSON.stringify(respaldo));
    return true;
  } catch { return false; }
}

function borrarSesion() {
  clearInterval(latido); latido = null;
  cerrojoPropio = false;
  fs.rmSync(CARPETA, { recursive: true, force: true });
}

// ── El cerrojo: una sola copia usa la sesión ──────────────────────
/**
 * Qué otra copia está usando la sesión ahora mismo, si hay alguna. Un cerrojo
 * sin latido reciente es de una copia que ya no está y no cuenta.
 */
function cerrojoDeOtraCopia(ahora = Date.now()) {
  const c = leerJSON(CERROJO);
  if (!c || !c.cuando || c.instancia === INSTANCIA) return null;
  return ahora - Number(c.cuando) > CERROJO_VENCIDO ? null : c;
}

function tomarCerrojo() {
  const escribir = () => {
    try {
      escribirAtomico(CERROJO, JSON.stringify({ instancia: INSTANCIA, pid: process.pid, cuando: Date.now() }));
    } catch { /* el volumen dirá */ }
  };
  fs.mkdirSync(CARPETA, { recursive: true });
  escribir();
  cerrojoPropio = true;
  clearInterval(latido);
  latido = setInterval(escribir, LATIDO);
  latido.unref?.();
}

function soltarCerrojo() {
  clearInterval(latido); latido = null;
  if (!cerrojoPropio) return;
  cerrojoPropio = false;
  const c = leerJSON(CERROJO);
  // Sólo se borra el cerrojo propio: el de otra copia no se toca.
  if (!c || c.instancia === INSTANCIA) { try { fs.rmSync(CERROJO, { force: true }); } catch { /* ya no está */ } }
}

// ── Qué hacer con cada corte ──────────────────────────────────────
/*
 * Se decide acá, aparte de la conexión, para poder probarlo: cada código de
 * WhatsApp tiene una respuesta distinta, y confundirlas es lo que desvinculaba
 * el número solo.
 */
function decidirCorte(codigo, { vinculado = true, rotas = 0 } = {}) {
  if (codigo === 515) return { accion: 'reiniciar' };   // el reinicio que pide WhatsApp al terminar de vincular
  if (!vinculado) {
    return { accion: 'esperar', mensaje: 'El QR venció sin escanearse. Tocá "Vincular" para generar otro.' };
  }
  if (codigo === 401) {
    return {
      accion: 'desvincular',
      mensaje: 'Se desvinculó desde el teléfono. Vinculalo de nuevo para seguir mandando los pedidos al grupo.',
    };
  }
  if (codigo === 403) {
    return {
      accion: 'desvincular',
      mensaje: 'WhatsApp bloqueó este número para dispositivos vinculados. Vas a tener que usar otro número.',
    };
  }
  if (codigo === 411) {
    return {
      accion: 'desvincular',
      mensaje: 'El teléfono no quedó en modo multidispositivo. Volvé a vincularlo desde WhatsApp.',
    };
  }
  if (codigo === 440) {
    return {
      accion: 'ceder',
      mensaje: 'Otra copia del servidor tomó esta sesión de WhatsApp. Esta copia no se la disputa: la retoma cuando quede libre.',
    };
  }
  if (codigo === 500) {
    return rotas + 1 >= TOPE_SESION_ROTA
      ? { accion: 'desvincular', mensaje: 'La sesión guardada quedó inservible. Escaneá el QR de nuevo.' }
      : { accion: 'reconectar' };
  }
  return { accion: 'reconectar' };
}

function anotarCorte(codigo, accion, motivo) {
  try {
    guardarConfig('whatsapp_ultimo_corte', JSON.stringify({
      cuando: new Date().toISOString(),
      codigo: codigo ?? null,
      accion,
      motivo: String(motivo || '').slice(0, 160) || null,
    }));
  } catch { /* que no se caiga la reconexión por no poder anotar */ }
}

function ultimoCorte() {
  try { return JSON.parse(leerConfig('whatsapp_ultimo_corte') || 'null'); } catch { return null; }
}

// ── La conexión ───────────────────────────────────────────────────
function fallo(e) {
  estado.conexion = 'error';
  estado.error = String(e?.message || e).slice(0, 200);
}

const esperaDelReintento = () => Math.min(ESPERA_MAXIMA, 2000 * 2 ** Math.min(intentos, 5));

function programarReintento(ms) {
  clearTimeout(reintento);
  reintento = setTimeout(() => { arrancar(); }, ms);
  reintento.unref?.();
}

function cerrarSocket() {
  const viejo = sock;
  sock = null;
  if (!viejo) return;
  // Sin sacarle las escuchas, un socket muerto sigue avisando cosas y puede
  // pisar el estado del que lo reemplazó.
  try { viejo.ev.removeAllListeners(); } catch { /* ya no escucha */ }
  try { viejo.end?.(undefined); } catch { /* ya estaba cortado */ }
}

/*
 * El vigilante.
 *
 * Alguna vez el socket queda muerto sin que llegue el aviso de cierre: el panel
 * dice "conectado" y los pedidos no salen. Mirar si el socket sigue abierto
 * cuesta nada y lo levanta solo.
 */
function vigilar() {
  clearInterval(vigilante);
  vigilante = setInterval(() => {
    if (apagando || estado.conexion !== 'conectado' || !sock) return;
    if (sock.ws?.isOpen !== false) return;
    Object.assign(estado, { conexion: 'reconectando', error: 'La conexión se cortó sin aviso.' });
    anotarCorte(null, 'reconectar', 'el socket estaba cerrado sin avisar');
    arrancar();
  }, VIGILANCIA);
  vigilante.unref?.();
}

async function conectar() {
  const {
    makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers,
  } = require('baileys');
  const QRCode = require('qrcode');

  clearTimeout(reintento);
  apagando = false;
  fs.mkdirSync(CARPETA, { recursive: true });
  if (restaurarCredenciales()) console.log('  whatsapp: la sesión estaba rota y se restauró del respaldo');

  /*
   * Si otra copia del servidor está usando la sesión, esta espera su turno en
   * vez de disputársela: disputarla es lo que terminaba sacando el dispositivo
   * de la lista del teléfono.
   */
  const otra = cerrojoDeOtraCopia();
  if (otra) {
    Object.assign(estado, {
      conexion: 'esperando-lugar',
      qr: null,
      error: 'Hay otra copia del servidor usando esta sesión de WhatsApp. Esta la toma sola en cuanto la suelte.',
    });
    programarReintento(ESPERA_CEDIENDO);
    return;
  }
  tomarCerrojo();
  cerrarSocket();

  estado.conexion = 'conectando';
  estado.error = null;

  const { state, saveCreds } = await useMultiFileAuthState(CARPETA);
  let version;
  // La versión del protocolo que usa WhatsApp Web hoy; si no se puede averiguar, va la que trae la librería.
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* sigue con la de la librería */ }

  const este = makeWASocket({
    auth: state,
    logger: require('pino')({ level: 'silent' }),
    ...(version ? { version } : {}),
    browser: Browsers.ubuntu('Chrome'),
    // Marcarse en línea manda las notificaciones acá y se las saca al teléfono.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Un poco más de aire que por omisión: en Railway, 20 segundos para conectar
    // se quedan cortos cuando la red del contenedor recién arranca.
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    retryRequestDelayMs: 500,
  });
  sock = este;
  vigilar();

  este.ev.on('creds.update', async () => {
    await saveCreds();
    respaldarCredenciales();
  });

  este.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (este !== sock) return;   // un socket viejo que todavía avisa algo

    if (qr) {
      estado.conexion = 'esperando-qr';
      estado.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
    }
    if (connection === 'open') {
      intentos = 0;
      sesionesRotas = 0;
      Object.assign(estado, { conexion: 'conectado', qr: null, error: null });
      estado.numero = String(este.user?.id || '').split(':')[0].split('@')[0] || null;
      respaldarCredenciales();
    }
    if (connection !== 'close') return;

    estado.qr = null;
    if (apagando) { estado.conexion = 'apagado'; return; }

    const codigo = lastDisconnect?.error?.output?.statusCode;
    const vinculado = sesionUsable(state.creds);
    const { accion, mensaje } = decidirCorte(codigo, { vinculado, rotas: sesionesRotas });
    anotarCorte(codigo, accion, lastDisconnect?.error?.message);

    if (accion === 'reiniciar') { arrancar(); return; }

    if (accion === 'esperar') {
      soltarCerrojo();
      Object.assign(estado, { conexion: 'apagado', error: mensaje });
      return;
    }
    if (accion === 'desvincular') {
      borrarSesion();
      Object.assign(estado, { conexion: 'desvinculado', numero: null, error: mensaje });
      return;
    }
    if (accion === 'ceder') {
      soltarCerrojo();
      Object.assign(estado, { conexion: 'esperando-lugar', error: mensaje });
      programarReintento(ESPERA_CEDIENDO);
      return;
    }

    sesionesRotas = codigo === 500 ? sesionesRotas + 1 : 0;
    intentos += 1;
    Object.assign(estado, { conexion: 'reconectando', error: lastDisconnect?.error?.message || null });
    programarReintento(esperaDelReintento());
  });
}

/*
 * Conectar, y si falla volver a intentar.
 *
 * Antes, una falla acá —la red del contenedor recién levantada, el volumen
 * todavía montándose— dejaba el WhatsApp apagado hasta que alguien entrara al
 * panel a tocar "Vincular". Ahora se reintenta mientras haya sesión guardada.
 */
async function arrancar() {
  if (apagando) return;
  try {
    await conectar();
  } catch (e) {
    fallo(e);
    if (hayCredenciales()) {
      intentos += 1;
      programarReintento(esperaDelReintento());
    }
  }
}

function estadoPublico() {
  return {
    conexion: estado.conexion,
    qr: estado.conexion === 'esperando-qr' ? estado.qr : null,
    numero: estado.numero,
    error: estado.error,
    grupo: grupoElegido(),
    ultimoCorte: ultimoCorte(),
  };
}

async function vincular() {
  const enCurso = ['conectado', 'conectando', 'esperando-qr', 'reconectando'].includes(estado.conexion);
  if (!(enCurso && sock)) {
    intentos = 0;
    sesionesRotas = 0;
    await arrancar();
  }
  return estadoPublico();
}

async function desvincular() {
  apagando = true;
  clearTimeout(reintento);
  clearInterval(vigilante); vigilante = null;
  try { await sock?.logout(); } catch { /* ya estaba cortado */ }
  cerrarSocket();
  soltarCerrojo();
  borrarSesion();
  guardarConfig('whatsapp_grupo', '');
  Object.assign(estado, { conexion: 'apagado', qr: null, numero: null, error: null });
  return estadoPublico();
}

/** Al apagar el servidor: corta la conexión sin desvincular, para retomarla al volver. */
function apagar() {
  apagando = true;
  clearTimeout(reintento);
  clearInterval(vigilante); vigilante = null;
  cerrarSocket();
  // Soltar el cerrojo apenas se apaga es lo que deja que la copia nueva de un
  // deploy tome la sesión enseguida, en vez de esperar a que venza el latido.
  soltarCerrojo();
}

/** Al arrancar: si ya había una sesión vinculada, se reconecta sola. */
function arrancarSiHaySesion() {
  if (hayCredenciales()) arrancar();
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
  // Para las pruebas: decisiones y archivos, sin levantar ninguna conexión.
  decidirCorte, cerrojoDeOtraCopia, respaldarCredenciales, restaurarCredenciales, CARPETA, INSTANCIA,
};
