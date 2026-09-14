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

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
