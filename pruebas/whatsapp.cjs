/*
 * Pruebas del aviso al grupo de WhatsApp, sin un WhatsApp de verdad.
 *
 * Vincular un número necesita un teléfono que escanee el QR, así que eso se
 * prueba a mano. Lo que sí se prueba acá es lo que decide el portal: que el
 * pedido llegue al grupo elegido con el PDF y el resumen, que sin grupo o sin
 * conexión no se mande nada, y que un WhatsApp que no contesta no deje colgada
 * la confirmación del pedido. Se usa un socket de mentira en lugar del real.
 *
 * Arma una base propia en una carpeta temporal: no toca la de datos/.
 *
 * Uso: node pruebas/whatsapp.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isuwaya-whatsapp-'));
const whatsapp = require('../src/whatsapp');

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const PEDIDO = {
  numero: 'ISU-000777', unidades: 18, total: 171000,
  cliente: {
    nombre: 'Boutique Ñandú', cuit: '27-30456789-4', telefono: '11 5555-1234',
    formaEnvio: 'Expreso Cruz del Sur', ciudad: 'Villa Carlos Paz', codigoPostal: '5152', provincia: 'Córdoba',
  },
};
const GRUPO = { id: '120363000000000000@g.us', nombre: 'Pedidos ISUWAYA' };
const socketFalso = () => {
  const enviados = [];
  return { enviados, sendMessage: async (jid, contenido) => { enviados.push({ jid, contenido }); return { key: { id: 'x' } }; } };
};

(async () => {
  tit('1. SIN GRUPO O SIN CONEXIÓN NO SE MANDA NADA');
  const pdf = Buffer.from('%PDF-1.4 pedido');
  const nadie = socketFalso();
  chk('sin grupo elegido', { ok: false, motivo: 'sin grupo de WhatsApp elegido' },
    await whatsapp.avisarGrupo(PEDIDO, pdf, { socket: nadie, grupo: null, conectado: true }));
  chk('desconectado', { ok: false, motivo: 'WhatsApp desconectado' },
    await whatsapp.avisarGrupo(PEDIDO, pdf, { socket: nadie, grupo: GRUPO, conectado: false }));
  chk('y en ninguno de los dos casos salió un mensaje', 0, nadie.enviados.length);
  chk('sin vincular, el aviso de pedidos no pasa por acá', false, whatsapp.configurado());
  chk('y el estado dice que está apagado, sin QR', ['apagado', null],
    [whatsapp.estadoPublico().conexion, whatsapp.estadoPublico().qr]);

  tit('2. EL PEDIDO LLEGA AL GRUPO CON EL PDF');
  const s = socketFalso();
  chk('se manda', { ok: true }, await whatsapp.avisarGrupo(PEDIDO, pdf, { socket: s, grupo: GRUPO, conectado: true }));
  const m = s.enviados[0];
  chk('una sola vez, al grupo elegido', [1, GRUPO.id], [s.enviados.length, m?.jid]);
  chk('como documento PDF, con el número en el nombre', ['application/pdf', 'ISU-000777-pedido.pdf', true],
    [m?.contenido.mimetype, m?.contenido.fileName, m?.contenido.document === pdf]);
  const texto = m?.contenido.caption || '';
  chk('dice qué pedido es y que falta confirmar el stock', true,
    texto.includes('ISU-000777') && texto.includes('esperando confirmación de stock'));
  chk('con el cliente, su teléfono y el total', true,
    texto.includes('Boutique Ñandú') && texto.includes('11 5555-1234') && texto.includes('171.000'));
  chk('y a dónde y cómo va', true, texto.includes('Expreso Cruz del Sur') && texto.includes('(5152)'));

  const soloTexto = socketFalso();
  await whatsapp.avisarGrupo(PEDIDO, null, { socket: soloTexto, grupo: GRUPO, conectado: true });
  chk('sin PDF va el resumen solo', [true, false],
    [typeof soloTexto.enviados[0]?.contenido.text === 'string', 'document' in (soloTexto.enviados[0]?.contenido || {})]);

  tit('3. UN WHATSAPP QUE NO CONTESTA NO CUELGA EL PEDIDO');
  const colgado = { sendMessage: () => new Promise(() => {}) };
  const desde = Date.now();
  let error = null;
  try {
    await whatsapp.avisarGrupo(PEDIDO, pdf, { socket: colgado, grupo: GRUPO, conectado: true, tope: 150 });
  } catch (e) { error = e.message; }
  chk('corta por tiempo', 'WhatsApp no contestó a tiempo', error);
  chk('sin esperar de más', true, Date.now() - desde < 2000);

  tit('4. SIN CONEXIÓN, LO QUE PIDE EL PANEL SE RECHAZA CON MOTIVO');
  for (const [nombre, fn] of [
    ['buscar los grupos', () => whatsapp.grupos()],
    ['elegir un grupo', () => whatsapp.elegirGrupo(GRUPO.id)],
    ['mandar la prueba', () => whatsapp.mandarPrueba()],
  ]) {
    let e = null;
    try { await fn(); } catch (x) { e = x; }
    chk(`${nombre}: 409 con explicación`, [409, true], [e?.status, Boolean(e?.message)]);
  }

  tit('5. CADA CORTE DE WHATSAPP TIENE SU RESPUESTA');
  /*
   * El número se desvinculaba solo. Una de las causas era tratar todos los
   * cortes igual: al corte 440 —otra copia del servidor tomó la sesión— se le
   * respondía reconectando, las dos copias se echaban entre sí y WhatsApp
   * terminaba sacando el dispositivo del teléfono.
   */
  const corte = (codigo, extra) => whatsapp.decidirCorte(codigo, extra).accion;
  chk('el reinicio que pide WhatsApp al vincular se hace en el acto', 'reiniciar', corte(515));
  chk('desvinculado desde el teléfono: hay que escanear de nuevo', 'desvincular', corte(401));
  chk('número bloqueado: no se insiste', 'desvincular', corte(403));
  chk('otra copia tomó la sesión: se le cede, no se pelea', 'ceder', corte(440));
  chk('cortes de red: se reconecta', ['reconectar', 'reconectar', 'reconectar'], [corte(408), corte(428), corte(503)]);
  chk('y sin código también', 'reconectar', corte(undefined));
  chk('sesión ilegible: primero reintenta', 'reconectar', corte(500, { rotas: 0 }));
  chk('y si sigue rota, pide QR nuevo', 'desvincular', corte(500, { rotas: 2 }));
  /*
   * Mientras se espera el escaneo, un corte NO es el final.
   *
   * Tratarlo como el final es lo que hacía fallar la vinculación siempre: el
   * QR quedaba en la pantalla del panel sin ningún socket esperándolo del otro
   * lado, y quien lo escaneaba recibía "error de conexión" en el teléfono.
   */
  const sinEscanear = (codigo, extra) => corte(codigo, { vinculado: false, ...extra });
  chk('un corte de red con el QR en pantalla saca un QR nuevo',
    ['renovar', 'renovar', 'renovar', 'renovar'],
    [sinEscanear(428), sinEscanear(408), sinEscanear(503), sinEscanear(undefined)]);
  chk('y el reinicio de WhatsApp sigue siendo inmediato', 'reiniciar', sinEscanear(515));
  chk('pero si WhatsApp rechaza la vinculación, no se insiste',
    ['desvincular', 'desvincular', 'desvincular'],
    [sinEscanear(401), sinEscanear(403), sinEscanear(411)]);
  chk('después de varios QR que nadie escaneó, se deja de insistir', 'esperar', sinEscanear(428, { renovaciones: 5 }));
  chk('con un código pedido no se renueva: saldría otro distinto', 'esperar', sinEscanear(428, { modo: 'codigo' }));

  tit('6. UNA SOLA COPIA DEL SERVIDOR USA LA SESIÓN');
  /*
   * El cerrojo con latido en el volumen: al desplegar, la copia nueva espera a
   * que la vieja suelte la sesión en vez de disputársela.
   */
  fs.mkdirSync(whatsapp.CARPETA, { recursive: true });
  const cerrojo = path.join(whatsapp.CARPETA, 'en-uso.json');
  const ponerCerrojo = (instancia, hace) => fs.writeFileSync(
    cerrojo, JSON.stringify({ instancia, pid: 1, cuando: Date.now() - hace }),
  );
  ponerCerrojo('otra-copia', 5000);
  chk('una copia que sigue latiendo se respeta', true, Boolean(whatsapp.cerrojoDeOtraCopia()));
  ponerCerrojo('otra-copia', 120000);
  chk('una que dejó de latir no cuenta: la sesión quedó libre', null, whatsapp.cerrojoDeOtraCopia());
  ponerCerrojo(whatsapp.INSTANCIA, 1000);
  chk('y el cerrojo propio no se estorba a sí mismo', null, whatsapp.cerrojoDeOtraCopia());
  /*
   * Dentro de un contenedor el proceso suele ser el 1, así que dos copias
   * distintas comparten número: lo que las distingue es el identificador.
   */
  ponerCerrojo('otra-copia-con-el-mismo-pid', 3000);
  chk('dos copias con el mismo número de proceso se distinguen igual', true,
    Boolean(whatsapp.cerrojoDeOtraCopia()));
  fs.rmSync(cerrojo, { force: true });

  tit('7. LA SESIÓN ROTA SE RESTAURA DEL RESPALDO');
  /*
   * La librería guarda las credenciales con una escritura común: si el proceso
   * muere justo ahí —un deploy, un reinicio—, el archivo queda cortado, y al
   * arrancar la librería crea una identidad nueva en silencio. Desde afuera se
   * ve como que el número "se salió solo" y en el teléfono queda un dispositivo
   * fantasma. De cada sesión buena queda un respaldo.
   */
  const creds = path.join(whatsapp.CARPETA, 'creds.json');
  const respaldo = path.join(whatsapp.CARPETA, 'creds-respaldo.json');
  const sesionBuena = JSON.stringify({
    me: { id: '5493511234567:1@s.whatsapp.net' },
    registered: true,
    noiseKey: { private: { type: 'Buffer', data: [1, 2, 3] } },
  });
  fs.mkdirSync(whatsapp.CARPETA, { recursive: true });
  fs.writeFileSync(creds, sesionBuena);
  whatsapp.respaldarCredenciales();
  chk('de una sesión vinculada queda respaldo', true, fs.existsSync(respaldo));

  fs.writeFileSync(creds, '{"me":{"id":"549351');   // cortada a la mitad, como en un apagón
  chk('una sesión cortada se restaura sola', true, whatsapp.restaurarCredenciales());
  chk('y queda igual a la que andaba', sesionBuena, fs.readFileSync(creds, 'utf8'));
  chk('con la sesión sana no se toca nada', false, whatsapp.restaurarCredenciales());

  fs.rmSync(creds, { force: true });
  chk('si el archivo desapareció, también vuelve', true, whatsapp.restaurarCredenciales());

  fs.writeFileSync(respaldo, JSON.stringify({ registered: false }));
  fs.writeFileSync(creds, 'roto');
  chk('un respaldo sin vincular no pisa nada', false, whatsapp.restaurarCredenciales());
  fs.rmSync(creds, { force: true });
  fs.rmSync(respaldo, { force: true });

  /*
   * Una sesión a la que sólo se le pidió un código todavía no está vinculada:
   * la librería le anota el número antes de que nadie lo haya escrito en el
   * teléfono. Si contara como buena, el servidor la respaldaría y al arrancar
   * intentaría reconectar con una sesión que no existe del otro lado.
   */
  fs.writeFileSync(creds, JSON.stringify({ me: { id: '5493511234567@s.whatsapp.net' }, pairingCode: 'ABCD1234' }));
  fs.rmSync(respaldo, { force: true });
  whatsapp.respaldarCredenciales();
  chk('un código pedido y sin escribir no se respalda', false, fs.existsSync(respaldo));
  fs.writeFileSync(respaldo, JSON.stringify({ me: { id: '5493511234567@s.whatsapp.net' }, pairingCode: 'ABCD1234' }));
  fs.writeFileSync(creds, 'roto');
  chk('ni se restaura como si fuera una sesión buena', false, whatsapp.restaurarCredenciales());
  fs.rmSync(creds, { force: true });
  fs.rmSync(respaldo, { force: true });

  tit('8. EL NÚMERO PARA PEDIR EL CÓDIGO');
  const n = whatsapp.normalizarNumero;
  chk('se le sacan el +, los espacios y los guiones', '5493511234567', n('+54 9 351 123-4567'));
  chk('y el 00 de las llamadas internacionales', '5493511234567', n('005493511234567'));
  chk('un número corto no sirve', null, n('351 4567'));
  chk('un texto cualquiera tampoco', null, n('el de siempre'));
  chk('ni vacío', null, n(''));

  tit('9. EL CÓDIGO QUE VENCE SE EXPLICA COMO CÓDIGO');
  // Por QR el mensaje recién aparece cuando se dejó de renovar; por código, en el primer corte.
  const sinUsar = (modo) => whatsapp.decidirCorte(428, { vinculado: false, modo, renovaciones: 9 }).mensaje;
  chk('por QR habla del QR', true, /QR/.test(sinUsar('qr')));
  chk('por código habla del código', true, /c\u00f3digo/i.test(sinUsar('codigo')) && !/QR/.test(sinUsar('codigo')));

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
