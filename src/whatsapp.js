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
const TOPE_RENOVACIONES = 5;      // QR nuevos seguidos sin que nadie escanee, antes de dejar de insistir

const estado = { conexion: 'apagado', modo: 'qr', qr: null, codigo: null, numero: null, error: null };
let sock = null;
let reintento = null;
let latido = null;
let vigilante = null;
let intentos = 0;
let sesionesRotas = 0;
let apagando = false;
let cerrojoPropio = false;
let codigoPara = null;   // el número al que hay que pedirle un código de vinculación
let renovaciones = 0;    // QR nuevos que se sacaron sin que nadie escanee

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

/*
 * Cuándo una sesión guardada está vinculada de verdad.
 *
 * No alcanza con que diga de qué número es: al pedir un código de ocho letras,
 * la librería anota el número antes de que nadie lo haya escrito en el
 * teléfono. Lo que sólo aparece cuando WhatsApp aceptó el dispositivo es la
 * identidad firmada —account— o la marca registered del camino del código.
 */
const sesionUsable = (creds) => Boolean(creds && creds.me && (creds.account || creds.registered));
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
function decidirCorte(codigo, { vinculado = true, rotas = 0, modo = 'qr', renovaciones = 0 } = {}) {
  if (codigo === 515) return { accion: 'reiniciar' };   // el reinicio que pide WhatsApp al terminar de vincular
  /*
   * Un corte mientras se espera el escaneo NO es el final.
   *
   * Acá estaba el error que hacía fallar la vinculación siempre: cualquier
   * corte que no fuera el 515 dejaba esto apagado y sin reintentar. El QR
   * seguía en la pantalla del panel hasta el próximo refresco, pero ya no
   * había socket del otro lado esperándolo: quien lo escaneaba en ese rato
   * recibía en el teléfono un "error de conexión" sin ninguna explicación, y
   * del lado del servidor no se veía nada raro. Ahora se saca un QR nuevo, que
   * es lo que hace WhatsApp Web. Con tope, para no quedar insistiéndole a
   * WhatsApp con una pantalla que nadie está mirando.
   */
  if (!vinculado) {
    if (codigo === 401 || codigo === 403 || codigo === 411) {
      return {
        accion: 'desvincular',
        mensaje: 'WhatsApp rechazó la vinculación desde este servidor. Probá con el código de ocho letras;'
          + ' si tampoco entra, el problema está entre WhatsApp y este número.',
      };
    }
    // Con un código pedido no se renueva: saldría otro código distinto mientras lo estás escribiendo.
    if (modo === 'codigo') {
      return { accion: 'esperar', mensaje: 'El código venció sin que nadie lo escribiera en el teléfono. Pedí otro.' };
    }
    if (renovaciones + 1 > TOPE_RENOVACIONES) {
      return { accion: 'esperar', mensaje: 'Se generaron varios QR y ninguno se escaneó. Tocá "Vincular" para volver a empezar.' };
    }
    return { accion: 'renovar' };
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

/*
 * El teléfono llegó hasta acá.
 *
 * Es el dato que faltaba para entender una vinculación que falla: si esto
 * quedó anotado, el escaneo llegó al servidor y lo que se rompió es de acá
 * para adelante; si no, WhatsApp nunca entregó el emparejamiento y el
 * problema está entre el teléfono y WhatsApp —el número, no el portal—.
 */
function anotarEscaneo(modo) {
  try {
    guardarConfig('whatsapp_ultimo_escaneo', JSON.stringify({ cuando: new Date().toISOString(), modo }));
  } catch { /* no vale la pena romper la vinculación por no poder anotar */ }
}

function ultimoEscaneo() {
  try { return JSON.parse(leerConfig('whatsapp_ultimo_escaneo') || 'null'); } catch { return null; }
}

function ultimoCorte() {
  try { return JSON.parse(leerConfig('whatsapp_ultimo_corte') || 'null'); } catch { return null; }
}

// ── Vincular escribiendo un código, sin cámara ────────────────────
/*
 * WhatsApp tiene dos caminos para agregar un dispositivo: escanear el QR o
 * escribir un código de ocho letras. Son dos caminos distintos de punta a
 * punta, y el del código tiene dos ventajas grandes para un servidor:
 *
 *  · No hay que mostrarle una imagen a una cámara. El QR obliga a que el
 *    teléfono y el servidor se encuentren a través de WhatsApp en el momento
 *    justo, y cuando eso no pasa el teléfono sólo dice "error de conexión".
 *  · Cuando falla, falla acá, con motivo: si WhatsApp no quiere dar el código
 *    lo dice en la respuesta, y ese texto se puede mostrar en el panel. Con el
 *    QR el error se lo queda el teléfono y del lado del servidor no se ve nada.
 */
function normalizarNumero(texto) {
  // Sin +, sin espacios, sin guiones y sin el 00 de las llamadas internacionales.
  const digitos = String(texto || '').replace(/\D+/g, '').replace(/^0+/, '');
  return digitos.length >= 10 && digitos.length <= 15 ? digitos : null;
}

/*
 * El código se pide recién cuando WhatsApp manda el primer QR: antes de eso la
 * conexión todavía se está armando y el pedido se pierde.
 */
async function pedirCodigo(socket) {
  const numero = codigoPara;
  codigoPara = null;
  try {
    const codigo = await socket.requestPairingCode(numero);
    Object.assign(estado, {
      conexion: 'esperando-codigo',
      modo: 'codigo',
      qr: null,
      codigo: String(codigo).toUpperCase(),
      error: null,
    });
  } catch (e) {
    const motivo = String(e?.message || e).slice(0, 200);
    anotarCorte(e?.output?.statusCode ?? null, 'codigo-rechazado', motivo);
    Object.assign(estado, {
      conexion: 'error',
      modo: 'codigo',
      qr: null,
      codigo: null,
      error: `WhatsApp no dio el código para ese número: ${motivo}`,
    });
    // Sin cortar, los QR que la librería sigue rotando taparían este error.
    cerrarSocket();
    soltarCerrojo();
  }
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

  /*
   * Sin el catch, un volumen lleno o de sólo lectura tumbaba el servidor
   * entero: la librería avisa por un oyente asíncrono, y una promesa rota en
   * un oyente termina el proceso. Justo en el momento de vincular, además,
   * que es cuando la librería más escribe.
   */
  este.ev.on('creds.update', () => {
    saveCreds()
      .then(respaldarCredenciales)
      .catch((e) => console.error('  whatsapp: no se pudo guardar la sesión:', e.message));
  });

  este.ev.on('connection.update', async (novedad) => {
    try { await alCambiarLaConexion(este, state, novedad); }
    catch (e) { console.error('  whatsapp: error manejando la conexión:', e.message); }
  });
}

async function alCambiarLaConexion(este, state, { connection, lastDisconnect, qr, isNewLogin }) {
  const QRCode = require('qrcode');
  if (este !== sock) return;   // un socket viejo que todavía avisa algo

  // Que el teléfono haya emparejado se anota apenas pasa, aunque después falle.
  if (isNewLogin) anotarEscaneo(estado.modo);

  if (qr) {
    // El primer QR avisa que la conexión ya está abierta: recién acá sirve pedir el código.
    if (codigoPara) await pedirCodigo(este);
    else if (estado.conexion !== 'esperando-codigo') {
      // Con el código pedido, los QR que WhatsApp sigue rotando no se muestran.
      Object.assign(estado, { conexion: 'esperando-qr', modo: 'qr', codigo: null });
      /*
       * El QR se dibuja al doble del tamaño con el que se muestra, y con la
       * zona tranquila que pide la norma —cuatro módulos de blanco alrededor—.
       * Antes salía de 280 px para una caja de 240 y con un módulo de margen:
       * achicar por un número no entero le come los bordes a los cuadraditos y
       * el margen justo deja al lector sin dónde apoyarse. Un QR así se lee a
       * veces sí y a veces no, y desde el teléfono eso parece un error de red.
       */
      estado.qr = await QRCode.toDataURL(qr, { margin: 4, width: 480 });
    }
  }
  if (connection === 'open') {
    intentos = 0;
    sesionesRotas = 0;
    renovaciones = 0;
    codigoPara = null;
    Object.assign(estado, { conexion: 'conectado', qr: null, codigo: null, error: null });
    estado.numero = String(este.user?.id || '').split(':')[0].split('@')[0] || null;
    respaldarCredenciales();
  }
  if (connection !== 'close') return;

  estado.qr = null;
  estado.codigo = null;
  if (apagando) { estado.conexion = 'apagado'; return; }

  const codigo = lastDisconnect?.error?.output?.statusCode;
  const vinculado = sesionUsable(state.creds);
  const { accion, mensaje } = decidirCorte(codigo, {
    vinculado, rotas: sesionesRotas, modo: estado.modo, renovaciones,
  });
  anotarCorte(codigo, accion, lastDisconnect?.error?.message);

  if (accion === 'reiniciar') { arrancar(); return; }

  if (accion === 'renovar') {
    renovaciones += 1;
    Object.assign(estado, { conexion: 'conectando', error: null });
    // Enseguida: del otro lado hay alguien con el teléfono en la mano esperando el QR.
    programarReintento(1500);
    return;
  }

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
    modo: estado.modo,
    qr: estado.conexion === 'esperando-qr' ? estado.qr : null,
    codigo: estado.conexion === 'esperando-codigo' ? estado.codigo : null,
    numero: estado.numero,
    error: estado.error,
    grupo: grupoElegido(),
    ultimoCorte: ultimoCorte(),
    ultimoEscaneo: ultimoEscaneo(),
  };
}

async function vincular(numero) {
  /*
   * Con número se pide un código de ocho letras; sin número, el QR de siempre.
   *
   * El código sólo se puede pedir sobre una sesión nueva, así que lo primero
   * es descartar la que haya quedado a medio hacer. Una sesión que anda no se
   * toca: para cambiar de número hay que desvincular primero, a propósito.
   */
  const pedido = numero ? normalizarNumero(numero) : null;
  if (numero && !pedido) {
    throw conEstado('Escribí el número con el código de país y sin espacios, por ejemplo 5493511234567.', 400);
  }
  if (pedido) {
    if (estado.conexion === 'conectado') {
      throw conEstado('Ya hay un WhatsApp vinculado. Desvinculalo primero si querés usar otro número.', 409);
    }
    apagando = true;
    clearTimeout(reintento);
    cerrarSocket();
    soltarCerrojo();
    borrarSesion();
    apagando = false;
    codigoPara = pedido;
    intentos = 0;
    sesionesRotas = 0;
    renovaciones = 0;
    Object.assign(estado, { conexion: 'conectando', modo: 'codigo', qr: null, codigo: null, numero: null, error: null });
    await arrancar();
    return estadoPublico();
  }

  const enCurso = ['conectado', 'conectando', 'esperando-qr', 'esperando-codigo', 'reconectando'].includes(estado.conexion);
  if (!(enCurso && sock)) {
    intentos = 0;
    sesionesRotas = 0;
    renovaciones = 0;
    codigoPara = null;
    estado.modo = 'qr';
    await arrancar();
  }
  return estadoPublico();
}

async function desvincular() {
  apagando = true;
  codigoPara = null;
  clearTimeout(reintento);
  clearInterval(vigilante); vigilante = null;
  try { await sock?.logout(); } catch { /* ya estaba cortado */ }
  cerrarSocket();
  soltarCerrojo();
  borrarSesion();
  guardarConfig('whatsapp_grupo', '');
  Object.assign(estado, { conexion: 'apagado', modo: 'qr', qr: null, codigo: null, numero: null, error: null });
  return estadoPublico();
}

/** Al apagar el servidor: corta la conexión sin desvincular, para retomarla al volver. */
function apagar() {
  apagando = true;
  codigoPara = null;
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
  decidirCorte, cerrojoDeOtraCopia, respaldarCredenciales, restaurarCredenciales, normalizarNumero,
  CARPETA, INSTANCIA,
};
