const nodemailer = require('nodemailer');
const axios = require('axios');

/*
 * Los avisos de un pedido nuevo.
 *
 * Ninguno de los dos puede tumbar la confirmación. El pedido ya está guardado
 * cuando esto corre: si el mail no sale, el cliente no tiene por qué ver un
 * error y volver a mandar el mismo pedido. Se registra qué pasó con cada canal
 * y se sigue.
 */

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
    subject: `Pedido ${pedido.numero} — ${pedido.cliente.nombre} — ${pesos(pedido.total)}`,
    text: cuerpoDelMail(pedido),
    attachments: [
      { filename: `${pedido.numero}-pedido.pdf`, content: adjuntos.pedido },
      { filename: `${pedido.numero}-rotulo.pdf`, content: adjuntos.rotulo },
    ],
  });
  return { ok: true };
}

/*
 * WhatsApp: avisa, no adjunta.
 *
 * La API de Meta manda documentos sólo por URL pública, y publicar los datos de
 * un cliente en una dirección adivinable para que WhatsApp la baje es peor que
 * no mandar el adjunto. El mensaje avisa y lleva el resumen; los PDF están en
 * el mail y en el panel.
 *
 * Fuera de la ventana de 24 h Meta sólo entrega PLANTILLAS aprobadas. Si
 * WHATSAPP_TEMPLATE_NAME está cargado se usa esa; si no, se manda texto libre,
 * que funciona mientras haya conversación abierta.
 */
async function avisarPorWhatsapp(pedido) {
  const destino = String(process.env.PEDIDOS_WHATSAPP || '').replace(/\D/g, '');
  const token = process.env.WHATSAPP_META_TOKEN;
  const phoneId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  if (!destino) return { ok: false, motivo: 'sin PEDIDOS_WHATSAPP' };
  if (!token || !phoneId) return { ok: false, motivo: 'sin credenciales de WhatsApp' };

  const c = pedido.cliente;
  const resumen = `Pedido ${pedido.numero}\n${c.nombre} (CUIT ${c.cuit})\n`
    + `${pedido.unidades} u. — ${pesos(pedido.total)}\n`
    + `Envío: ${c.formaEnvio} · ${c.ciudad}, ${c.provincia}`;

  const plantilla = process.env.WHATSAPP_TEMPLATE_NAME;
  const cuerpo = plantilla
    ? {
      messaging_product: 'whatsapp', to: destino, type: 'template',
      template: {
        name: plantilla,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'es_AR' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: pedido.numero },
            { type: 'text', text: c.nombre },
            { type: 'text', text: `${pedido.unidades} u. ${pesos(pedido.total)}` },
          ],
        }],
      },
    }
    : { messaging_product: 'whatsapp', to: destino, type: 'text', text: { body: resumen } };

  const { data } = await axios.post(
    `https://graph.facebook.com/v20.0/${phoneId}/messages`, cuerpo,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
  );
  return { ok: true, id: data?.messages?.[0]?.id || null };
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
    avisarPorWhatsapp(pedido),
  ]);
  const leer = (r) => (r.status === 'fulfilled'
    ? (r.value.ok ? 'ok' : `omitido: ${r.value.motivo}`)
    : `error: ${String(r.reason?.response?.data?.error?.message || r.reason?.message).slice(0, 200)}`);
  return { mail: leer(mail), whatsapp: leer(whatsapp) };
}

module.exports = { avisarPedido, cuerpoDelMail };
