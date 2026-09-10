const PDFDocument = require('pdfkit');

/*
 * Los dos papeles que salen de un pedido.
 *
 * Son documentos distintos porque los usan personas distintas en momentos
 * distintos: el remito lo lee quien arma el pedido en el depósito, y el rótulo
 * lo pega quien cierra la bolsa. Meterlos en la misma hoja obliga a cortar con
 * tijera, y el rótulo termina torcido sobre el paquete.
 */

const AZUL  = '#01317a';
const VERDE = '#027010';
const GRIS  = '#5b6470';

const pesos = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function aBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    doc.end();
  });
}

const fecha = (iso) => new Date(iso).toLocaleString('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// ── 1. Remito del pedido, A4 ──────────────────────────────────────
/**
 * El papel con el que se arma el pedido en el depósito.
 *
 * Se ordena por categoría → producto → color porque ese es el recorrido físico
 * de quien lo junta: las remeras están todas juntas en el mismo estante. Un
 * listado en el orden en que el cliente fue agregando cosas obliga a caminar el
 * depósito de punta a punta por cada renglón.
 */
async function pdfPedido(pedido) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const cliente = pedido.cliente;
  const ancho = doc.page.width - 80;

  doc.rect(40, 40, ancho, 54).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('ISUWAYA MAYORISTA', 54, 56);
  doc.font('Helvetica').fontSize(9).text('Pedido mayorista', 54, 78);
  doc.font('Helvetica-Bold').fontSize(14).text(pedido.numero, 40, 58, { width: ancho - 14, align: 'right' });
  doc.font('Helvetica').fontSize(9).text(fecha(pedido.creado_en), 40, 78, { width: ancho - 14, align: 'right' });

  let y = 112;

  // ── Datos del cliente
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(11).text('CLIENTE', 40, y);
  y += 16;
  doc.strokeColor('#dfe3e8').lineWidth(1).moveTo(40, y).lineTo(40 + ancho, y).stroke();
  y += 8;

  const campos = [
    ['Nombre', cliente.nombre], ['CUIT', cliente.cuit],
    ['Teléfono', cliente.telefono], ['Email', cliente.email || '—'],
    ['Provincia', cliente.provincia], ['Ciudad', cliente.ciudad],
    ['Código Postal', cliente.codigoPostal], ['Dirección', cliente.direccion],
    ['Entre calles', cliente.entreCalles || '—'], ['Forma de envío', cliente.formaEnvio],
  ];
  for (let i = 0; i < campos.length; i += 2) {
    for (const [col, idx] of [[0, i], [1, i + 1]]) {
      if (!campos[idx]) continue;
      const x = 40 + col * (ancho / 2);
      doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(campos[idx][0].toUpperCase(), x, y);
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.5)
        .text(String(campos[idx][1] ?? '—'), x, y + 9, { width: ancho / 2 - 14 });
    }
    y += 30;
  }

  y += 6;
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(11).text('PEDIDO', 40, y);
  y += 16;

  // ── Ítems, agrupados por categoría
  const porCategoria = new Map();
  for (const it of pedido.items) {
    const c = it.categoria || 'Sin categoría';
    if (!porCategoria.has(c)) porCategoria.set(c, []);
    porCategoria.get(c).push(it);
  }

  const saltarSiHaceFalta = (alto) => {
    if (y + alto < doc.page.height - 70) return;
    doc.addPage();
    y = 50;
  };

  for (const [categoria, items] of [...porCategoria.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'))) {
    saltarSiHaceFalta(40);
    doc.rect(40, y, ancho, 17).fill('#eef2f7');
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(9).text(categoria.toUpperCase(), 46, y + 5);
    y += 23;

    for (const it of items.sort((a, b) => a.titulo.localeCompare(b.titulo, 'es'))) {
      saltarSiHaceFalta(34);
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.5).text(it.titulo, 46, y, { width: ancho - 150 });
      doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(it.skuAgrupador || '', 46, y + 12);
      doc.fillColor('#111').font('Helvetica').fontSize(9)
        .text(`${it.unidades} u.`, 40, y, { width: ancho - 90, align: 'right' });
      doc.font('Helvetica-Bold').text(pesos(it.subtotal), 40, y, { width: ancho - 14, align: 'right' });
      y += 24;

      /*
       * El detalle va por color y con los talles en una línea.
       *
       * Una fila por talle sería más "prolijo" y haría que un pedido de diez
       * productos ocupe cinco hojas. Quien arma el pedido necesita ver de un
       * vistazo cuántas unidades de cada talle van en cada color.
       */
      for (const linea of it.detalle) {
        saltarSiHaceFalta(16);
        const talles = linea.talles.map((t) => `${t.talle}: ${t.cantidad}`).join('   ');
        doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(8.5).text(linea.color || 'Único', 60, y, { width: 110 });
        doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(talles, 172, y, { width: ancho - 200 });
        y += Math.max(13, doc.heightOfString(talles, { width: ancho - 200 }) + 3);
      }

      if (it.curvas) {
        saltarSiHaceFalta(14);
        doc.fillColor(VERDE).font('Helvetica-Oblique').fontSize(8)
          .text(`Pedido por curva · ${it.curvas} curva${it.curvas === 1 ? '' : 's'} completa${it.curvas === 1 ? '' : 's'}`, 60, y);
        y += 13;
      }
      y += 5;
    }
  }

  // ── Total
  saltarSiHaceFalta(60);
  y += 6;
  doc.rect(40, y, ancho, 46).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica').fontSize(9).text('TOTAL DEL PEDIDO', 54, y + 10);
  doc.font('Helvetica-Bold').fontSize(9)
    .text(`${pedido.unidades} unidades`, 54, y + 25);
  doc.font('Helvetica-Bold').fontSize(20)
    .text(pesos(pedido.total), 40, y + 13, { width: ancho - 14, align: 'right' });

  doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
    .text('Este documento es el detalle del pedido. No es una factura ni un comprobante fiscal.',
      40, doc.page.height - 55, { width: ancho, align: 'center' });

  return aBuffer(doc);
}

// ── 2. Rótulo de envío, 10 × 15 cm ────────────────────────────────
/*
 * Diez por quince centímetros: la medida de las etiquetadoras térmicas y de
 * media A5. Entra en una bolsa de correo sin doblarse y se lee de lejos, que es
 * lo que hace falta cuando el paquete está en una pila.
 *
 * Las medidas van en puntos, que es la unidad de PDF: 1 cm = 28.35 pt.
 */
const CM = 28.3465;

async function pdfRotulo(pedido) {
  const doc = new PDFDocument({ size: [10 * CM, 15 * CM], margin: 0 });
  const cliente = pedido.cliente;
  const M = 0.6 * CM;
  const ancho = 10 * CM - M * 2;

  const ALTO_ENVIO = 1.6 * CM;
  const yEnvio = 15 * CM - ALTO_ENVIO - 0.55 * CM;
  const yInicio = 1.5 * CM + 0.5 * CM;
  const disponible = yEnvio - yInicio - 0.3 * CM;

  /*
   * El bloque del destinatario se agranda hasta llenar la etiqueta.
   *
   * Con tipografía chica quedaba un hueco muerto de cinco centímetros y una
   * dirección que hay que acercarse a leer. Un rótulo se lee de parado, con el
   * paquete en una pila y a un brazo de distancia.
   *
   * Se mide antes de dibujar y se elige la escala más grande que entra: si el
   * nombre o la dirección son largos, baja sola en vez de escribir encima de la
   * caja de la forma de envío.
   */
  const lineas = [
    { et: 'Destinatario', valor: cliente.nombre, peso: 1.35 },
    { et: 'CUIT', valor: cliente.cuit, peso: 1 },
    { et: 'Dirección', valor: cliente.direccion, peso: 1.1 },
    ...(cliente.entreCalles ? [{ et: 'Entre calles', valor: cliente.entreCalles, peso: 0.9 }] : []),
    { et: 'Localidad', valor: `${cliente.ciudad} (${cliente.codigoPostal})`, peso: 1.15 },
    { et: 'Provincia', valor: cliente.provincia, peso: 1 },
  ].filter((l) => l.valor !== undefined && l.valor !== null && String(l.valor) !== '');

  const altoCon = (base) => lineas.reduce((total, l) => {
    const cuerpo = base * l.peso;
    doc.font('Helvetica-Bold').fontSize(cuerpo);
    return total + 7 + doc.heightOfString(String(l.valor), { width: ancho }) + 7;
  }, 0);

  let base = 15;
  while (base > 8 && altoCon(base) > disponible) base -= 0.5;

  doc.rect(0, 0, 10 * CM, 1.5 * CM).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text('ISUWAYA', M, 0.35 * CM);
  doc.font('Helvetica').fontSize(7.5).text('MAYORISTA', M, 0.85 * CM);
  doc.font('Helvetica-Bold').fontSize(10)
    .text(pedido.numero, 0, 0.55 * CM, { width: 10 * CM - M, align: 'right' });

  let y = yInicio;
  for (const l of lineas) {
    const cuerpo = base * l.peso;
    doc.fillColor(GRIS).font('Helvetica').fontSize(6.8).text(l.et.toUpperCase(), M, y);
    y += 7;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(cuerpo)
      .text(String(l.valor), M, y, { width: ancho });
    y += doc.heightOfString(String(l.valor), { width: ancho }) + 7;
  }

  doc.rect(M, yEnvio, ancho, ALTO_ENVIO).lineWidth(1.3).strokeColor(VERDE).stroke();
  doc.fillColor(GRIS).font('Helvetica').fontSize(6.8).text('FORMA DE ENVÍO', M + 9, yEnvio + 8);

  /*
   * La forma de envío también se mide antes de escribirla.
   *
   * "Andreani a sucursal" entra en un renglón; "Retiro en sucursal de Correo
   * Argentino" ocupa dos y se salía por debajo del recuadro, con la última
   * línea cortada por el borde. El texto se achica hasta entrar: un rótulo con
   * el transporte a medio leer es un paquete que vuelve.
   */
  const textoEnvio = String(cliente.formaEnvio || '—');
  const anchoEnvio = ancho - 18;
  const altoEnvioDisponible = ALTO_ENVIO - 24;
  let cuerpoEnvio = 13;
  doc.font('Helvetica-Bold');
  while (cuerpoEnvio > 7) {
    doc.fontSize(cuerpoEnvio);
    if (doc.heightOfString(textoEnvio, { width: anchoEnvio }) <= altoEnvioDisponible) break;
    cuerpoEnvio -= 0.5;
  }
  doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(cuerpoEnvio)
    .text(textoEnvio, M + 9, yEnvio + 20, { width: anchoEnvio });

  doc.fillColor(GRIS).font('Helvetica').fontSize(6.5)
    .text(`Tel. ${cliente.telefono || '—'}`, M, 15 * CM - 0.38 * CM, { width: ancho, align: 'right' });

  return aBuffer(doc);
}

module.exports = { pdfPedido, pdfRotulo };
