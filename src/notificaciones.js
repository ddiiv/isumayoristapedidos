const nodemailer = require('nodemailer');
const axios = require('axios');
const whatsapp = require('./whatsapp');

/*
 * Los avisos de un pedido nuevo.
 *
 * Ninguno de los dos puede tumbar la confirmación. El pedido ya está guardado
 * cuando esto corre: si el mail no sale, el cliente no tiene por qué ver un
 * error y volver a mandar el mismo pedido. Se registra qué pasó con cada canal
 * y se sigue.
 */

const VERSION_META = process.env.WHATSAPP_META_API_VERSION || 'v22.0';

const pesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });

function transporte() {
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) return null;
  const port = Number(process.env.MAIL_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    /*
     * La contraseña de aplicación de Google se muestra en grupos de cuatro y
     * algunos paneles recortan al pegar. Con los espacios adentro el fallo se
     * ve como "contraseña equivocada", que manda a buscar el problema al lugar
     * equivocado.
     */
    auth: { user: process.env.MAIL_USER, pass: String(process.env.MAIL_PASS).replace(/\s+/g, '') },
    connectionTimeout: 15000,
    // Los de nodemailer por omisión son 30 s y 10 min: un SMTP colgado dejaba el aviso esperando todo eso.
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

function cuerpoDelMail(pedido) {
  const c = pedido.cliente;
  const lineas = pedido.items.map((it) => {
    const detalle = it.detalle
      .map((d) => `      ${d.color || 'Único'}: ${d.talles.map((t) => `${t.talle}×${t.cantidad}`).join('  ')}`)
      .join('\n');
    return `  · ${it.titulo} (${it.categoria}) — ${it.unidades} u. — ${pesos(it.subtotal)}`
      + (it.curvas ? `\n      Por curva: ${it.curvas}` : '') + `\n${detalle}`;
  }).join('\n');

  return `Pedido ${pedido.numero}

CLIENTE
  ${c.nombre} · CUIT ${c.cuit}
  Tel. ${c.telefono}${c.email ? ` · ${c.email}` : ''}

ENVÍO
  ${c.direccion}${c.entreCalles ? ` (entre ${c.entreCalles})` : ''}
  ${c.ciudad} (${c.codigoPostal}), ${c.provincia}
  Forma de envío: ${c.formaEnvio}

PEDIDO
${lineas}

TOTAL: ${pedido.unidades} unidades — ${pesos(pedido.total)}

ESTADO: esperando confirmación de stock. Confirmalo, rearmalo o cancelalo desde el panel → Pedidos.

Adjuntos: el remito A4 para armar el pedido y el rótulo de 10×15 para la bolsa.
`;
}

async function avisarPorMail(pedido, adjuntos) {
  const destino = process.env.PEDIDOS_EMAIL;
  if (!destino) return { ok: false, motivo: 'sin PEDIDOS_EMAIL' };
  const t = transporte();
  if (!t) return { ok: false, motivo: 'sin credenciales de correo' };

  await t.sendMail({
    from: process.env.MAIL_FROM || `ISUWAYA Mayorista <${process.env.MAIL_USER}>`,
    to: destino,
    // El nombre del cliente en el asunto: la bandeja se lee en el celular y
    // así se sabe de quién es sin abrirlo.
    subject: `Pedido ${pedido.numero}${pedido.cambio ? ' (actualizado)' : ''} — ${pedido.cliente.nombre} — ${pesos(pedido.total)}`,
    text: cuerpoDelMail(pedido),
    attachments: [
      { filename: `${pedido.numero}-pedido.pdf`, content: adjuntos.pedido },
      { filename: `${pedido.numero}-rotulo.pdf`, content: adjuntos.rotulo },
    ],
  });
  return { ok: true };
}

/*
 * WhatsApp a los empleados, para que revisen el stock y armen el pedido.
 *
 * Por Meta, la plantilla oficial «mayorista_pedido_para_armar» con el remito en
 * PDF, a cada número de PEDIDOS_WHATSAPP (separados por coma). Fuera de las 24 h
 * Meta sólo entrega plantillas aprobadas: por eso ya no se manda texto libre, que
 * casi nunca llegaba. El PDF se sube una vez a Meta y va por su id (ver
 * subirPdfAMeta), nunca por un enlace público.
 *
 * Si además hay un WhatsApp vinculado desde el panel con un grupo elegido, el
 * aviso también va a ese grupo.
 */
// Meta rechaza un parámetro con saltos de línea, tabulaciones o más de 4 espacios seguidos.
const enUnaLinea = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

async function avisarEmpleadosPorMeta(pedido, pdf) {
  const destinos = [...new Set(String(process.env.PEDIDOS_WHATSAPP || '').split(',').map(aE164).filter(Boolean))];
  const token = process.env.WHATSAPP_META_TOKEN;
  const phoneId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  if (!destinos.length) return { ok: false, motivo: 'sin PEDIDOS_WHATSAPP' };
  if (!token || !phoneId) return { ok: false, motivo: 'sin credenciales de WhatsApp' };
  if (!pdf) return { ok: false, motivo: 'falta el PDF del pedido' };
  const c = pedido.cliente;
  const nombre = `${pedido.numero}-pedido.pdf`;
  let media;
  try {
    media = await subirPdfAMeta(pdf, nombre, token, phoneId);
  } catch (e) {
    return { ok: false, motivo: `error al subir el PDF: ${String(e.message).slice(0, 120)}` };
  }
  const parametros = [
    `${pedido.numero}${pedido.cambio ? ' (actualizado)' : ''}`,
    `${c.nombre} (CUIT ${c.cuit})`,
    `${pedido.unidades} u. por ${pesos(pedido.total)}`,
    `${c.formaEnvio} · ${c.ciudad}, ${c.provincia}`,
  ].map((t) => ({ type: 'text', text: enUnaLinea(t) }));
  const r = await Promise.allSettled(destinos.map((to) => axios.post(`https://graph.facebook.com/${VERSION_META}/${phoneId}/messages`, {
    messaging_product: 'whatsapp', to, type: 'template',
    template: {
      name: 'mayorista_pedido_para_armar',
      language: { code: 'es_AR' },
      components: [
        { type: 'header', parameters: [{ type: 'document', document: { id: media, filename: nombre } }] },
        { type: 'body', parameters: parametros },
      ],
    },
  }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 })));
  const fallas = r.filter((x) => x.status === 'rejected');
  if (!fallas.length) return { ok: true };
  const e = fallas[0].reason?.response?.data?.error;
  // El texto de Meta puede traer el teléfono adentro: no se guarda.
  const por = `${e?.code || ''} ${String(e?.message || fallas[0].reason?.message).replace(/\d{8,}/g, '…')}`.trim().slice(0, 120);
  return { ok: false, motivo: `no salió a ${fallas.length} de ${destinos.length}: ${por}` };
}

async function avisarPorWhatsapp(pedido, adjuntos = {}) {
  const [meta, grupo] = await Promise.all([
    avisarEmpleadosPorMeta(pedido, adjuntos.pedido),
    whatsapp.configurado()
      ? whatsapp.avisarGrupo(pedido, adjuntos.pedido).catch((e) => ({ ok: false, motivo: String(e.message).slice(0, 120) }))
      : null,
  ]);
  if (!grupo) return meta;
  if (meta.ok && grupo.ok) return { ok: true };
  if (meta.motivo === 'sin PEDIDOS_WHATSAPP') return grupo;
  return { ok: false, motivo: `Meta: ${meta.ok ? 'ok' : meta.motivo} · grupo: ${grupo.ok ? 'ok' : grupo.motivo}` };
}

/**
 * Avisa por los dos canales sin dejar que uno tumbe al otro.
 *
 * `allSettled` y no `all`: con `all`, un WhatsApp caído se lleva puesto el
 * aviso por mail que ya había salido bien, y el pedido queda sin avisar por
 * ningún lado.
 */
async function avisarPedido(pedido, adjuntos) {
  const [mail, whatsapp] = await Promise.allSettled([
    avisarPorMail(pedido, adjuntos),
    avisarPorWhatsapp(pedido, adjuntos),
  ]);
  const leer = (r) => (r.status === 'fulfilled'
    ? (r.value.ok ? 'ok' : `omitido: ${r.value.motivo}`)
    : `error: ${String(r.reason?.response?.data?.error?.message || r.reason?.message).slice(0, 200)}`);
  return { mail: leer(mail), whatsapp: leer(whatsapp) };
}

/*
 * Los avisos al cliente.
 *
 * El pedido ya no se da por confirmado al entrar: ISUWAYA revisa primero que
 * tenga todo el stock. El cliente tiene que enterarse de las dos puntas —que lo
 * recibimos, y qué pasó después— sin escribir a preguntar. Va por mail si lo
 * dejó; si no, lo ve en «Mis pedidos» cuando tiene cuenta.
 *
 * Nunca tira error: el pedido o el cambio de estado ya están guardados cuando
 * esto corre, y un mail que no sale no puede deshacerlos. Devuelve qué pasó,
 * para dejarlo anotado en el pedido.
 */
const AL_CLIENTE = {
  pendiente: {
    asunto: (p) => `Recibimos tu pedido ${p.numero}`,
    texto: 'Recibimos tu pedido y te lo adjuntamos.\n\n'
      + 'Antes de prepararlo revisamos que tengamos todo el stock. Te escribimos apenas\n'
      + 'lo confirmemos, y si falta algo te avisamos cómo queda.',
  },
  confirmado: {
    asunto: (p) => `Confirmamos tu pedido ${p.numero}`,
    texto: 'Tenemos el stock de todo lo que pediste y ya estamos preparando tu pedido.\n'
      + 'Te adjuntamos el detalle.',
  },
  'confirmado-con-cambios': {
    asunto: (p) => `Confirmamos tu pedido ${p.numero}, con cambios`,
    texto: 'Revisamos el stock y no teníamos todo lo que pediste. Te adjuntamos el pedido\n'
      + 'como queda: es el que vamos a preparar.',
  },
  modificado: {
    asunto: (p) => `Tu pedido ${p.numero} tiene cambios`,
    texto: 'No teníamos todo lo que pediste y ajustamos tu pedido. Te adjuntamos cómo\n'
      + 'queda: es el que vamos a preparar.',
  },
  cancelado: {
    asunto: (p) => `Tu pedido ${p.numero} fue cancelado`,
    texto: 'Tu pedido fue cancelado y no se va a despachar.',
  },
};

/*
 * Lo que cambió, renglón por renglón.
 *
 * El PDF adjunto dice cómo queda el pedido, pero no qué se sacó: quien pidió
 * cuatro remeras negras en L y recibe un pedido con dos tiene que ponerse a
 * comparar con lo que había mandado. Acá se lo dice derecho.
 */
function textoDeCambios(cambios) {
  const lineas = cambios?.lineas || [];
  if (!lineas.length) return '';
  const renglon = (l) => {
    const que = `${l.titulo} — ${l.color || 'Único'} ${l.talle}`;
    if (!l.antes) return `  · ${que}: agregamos ${l.despues}`;
    if (!l.despues) return `  · ${que}: pediste ${l.antes}, no hay`;
    return `  · ${que}: pediste ${l.antes}, te mandamos ${l.despues}`;
  };
  return `\nLo que cambió respecto de lo que pediste:\n${lineas.map(renglon).join('\n')}\n`
    + (cambios.masLineas ? `  · y ${cambios.masLineas} cambios más: están en el pedido adjunto.\n` : '')
    + (cambios.totalAntes !== undefined && cambios.totalAntes !== cambios.totalDespues
      ? `Total: antes ${pesos(cambios.totalAntes)}, ahora ${pesos(cambios.totalDespues)}.\n` : '');
}

/*
 * El aviso al cliente por WhatsApp, desde el número del asistente.
 *
 * Es el mismo número de Meta que usan el asistente y la tienda minorista, a
 * propósito: el cliente recibe la novedad ahí y, si responde, lo atiende el
 * asistente, que ya sabe pasarle el PDF de su pedido. Un solo WhatsApp para
 * todo, en vez de un número que avisa y otro que contesta.
 *
 * Va con plantilla porque Meta no deja escribirle primero a nadie de otra
 * forma: el texto libre sólo sale dentro de las 24 horas de un mensaje del
 * cliente. Las plantillas se crean y se aprueban en Meta; mientras no estén,
 * esto devuelve el error y el mail sale igual.
 */
const PLANTILLA_CLIENTE = {
  pendiente: 'mayorista_pedido_recibido',
  confirmado: 'mayorista_pedido_confirmado',
  'confirmado-con-cambios': 'mayorista_pedido_modificado',
  modificado: 'mayorista_pedido_modificado',
  cancelado: 'mayorista_pedido_cancelado',
};

/*
 * Confirmado y modificado llevan el PDF adjunto, sin que el cliente lo pida:
 * es el pedido que se va a preparar y lo tiene que tener a mano. Recibido y
 * cancelado no: en uno todavía no está revisado y en el otro no hay nada que
 * preparar.
 */
const CON_PDF = new Set(['mayorista_pedido_confirmado', 'mayorista_pedido_modificado']);

/*
 * El PDF se sube a Meta y se manda por su id, no por un enlace: un enlace
 * público al pedido dejaría los datos del cliente a un clic de cualquiera.
 */
async function subirPdfAMeta(pdf, nombre, token, phoneId) {
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', 'application/pdf');
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), nombre);
  const r = await fetch(`https://graph.facebook.com/${VERSION_META}/${phoneId}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) {
    throw Object.assign(new Error(j.error?.message || `Meta no aceptó el PDF (${r.status})`), { response: { data: j } });
  }
  return j.id;
}

// La misma regla que Stocker (normalizeToE164): es la que ya manda en producción.
function aE164(crudo) {
  const s = String(crudo || '');
  const limpio = s.replace(/\D/g, '');
  if (limpio.length < 8) return null;
  if (s.trim().startsWith('+')) return limpio;
  if (limpio.startsWith('0')) return `54${limpio.replace(/^0+/, '')}`;
  return limpio.length >= 11 ? limpio : `54${limpio}`;
}

/** Null = Meta sin configurar: el aviso queda como era, sólo por mail. */
async function whatsappAlCliente(pedido, estado, pdf = null) {
  const token = process.env.WHATSAPP_META_TOKEN;
  const phoneId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  if (!token || !phoneId) return null;
  const to = aE164(pedido?.cliente?.telefono);
  if (!to) return 'omitido: el teléfono no sirve para WhatsApp';
  const plantilla = PLANTILLA_CLIENTE[estado];
  // La plantilla con documento no sale sin documento: Meta la rechaza entera.
  if (CON_PDF.has(plantilla) && !pdf) return 'error: falta el PDF del pedido';
  try {
    const cabecera = CON_PDF.has(plantilla) ? [{
      type: 'header',
      parameters: [{
        type: 'document',
        document: { id: await subirPdfAMeta(pdf, `${pedido.numero}-pedido.pdf`, token, phoneId), filename: `${pedido.numero}-pedido.pdf` },
      }],
    }] : [];
    await axios.post(`https://graph.facebook.com/${VERSION_META}/${phoneId}/messages`, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: plantilla,
        language: { code: 'es_AR' },
        components: [...cabecera, {
          type: 'body',
          parameters: [
            { type: 'text', text: String(pedido.cliente.nombre || 'cliente').slice(0, 60) },
            { type: 'text', text: pedido.numero },
          ],
        }],
      },
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    return 'ok';
  } catch (e) {
    const err = e.response?.data?.error;
    // El texto de Meta trae el teléfono del cliente adentro: no se guarda.
    return `error: ${err?.code || ''} ${String(err?.message || e.message).replace(/\d{8,}/g, '…').slice(0, 120)}`.trim();
  }
}

async function avisarCliente(pedido, estado, opciones = {}) {
  if (!AL_CLIENTE[estado]) return null;
  const [mail, wa] = await Promise.all([
    mailAlCliente(pedido, estado, opciones),
    whatsappAlCliente(pedido, estado, opciones.pdf),
  ]);
  // Sin Meta configurado, el resultado es el de siempre, palabra por palabra.
  return wa === null ? mail : `${mail} · WhatsApp: ${wa}`;
}

async function mailAlCliente(pedido, estado, { pdf = null, nota = null, cambios = null } = {}) {
  const modelo = AL_CLIENTE[estado];
  if (!modelo) return null;
  const destino = String(pedido?.cliente?.email || '').trim();
  if (!destino) return 'omitido: el cliente no dejó mail';
  const t = transporte();
  if (!t) return 'omitido: sin credenciales de correo';

  const c = pedido.cliente;
  const cuerpo = `Hola${c.nombre ? ` ${c.nombre}` : ''}:\n\n${modelo.texto}\n`
    + (nota ? `\nNota de ISUWAYA: ${nota}\n` : '')
    + textoDeCambios(cambios)
    + `\nPedido ${pedido.numero} — ${pedido.unidades} unidades — ${pesos(pedido.total)}\n`
    + `Envío: ${c.formaEnvio} · ${c.ciudad} (${c.codigoPostal}), ${c.provincia}\n`
    + (pedido.seVeEnCuenta ? '\nLo podés seguir en «Mis pedidos», entrando a tu cuenta.\n' : '')
    + '\nSi tenés alguna duda, respondé este mail.\n\nISUWAYA Mayorista\n';
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || `ISUWAYA Mayorista <${process.env.MAIL_USER}>`,
      to: destino,
      // Si el cliente responde, que le llegue a quien gestiona los pedidos y no a la casilla que manda.
      replyTo: process.env.PEDIDOS_EMAIL || undefined,
      subject: modelo.asunto(pedido),
      text: cuerpo,
      attachments: pdf ? [{ filename: `${pedido.numero}-pedido.pdf`, content: pdf }] : [],
    });
    return 'ok';
  } catch (e) {
    return `error: ${String(e?.message || e).slice(0, 200)}`;
  }
}

module.exports = { avisarPedido, avisarCliente, avisarPorWhatsapp, cuerpoDelMail, aE164, PLANTILLA_CLIENTE, AL_CLIENTE, CON_PDF };
