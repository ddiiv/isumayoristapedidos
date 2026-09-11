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

/*
 * Todo lo que se imprime pasa por acá antes de tocar el papel.
 *
 * Las tipografías que trae el PDF —Helvetica y compañía— sólo saben escribir
 * los caracteres de Windows-1252. Cualquier otro no falla ni se ve vacío:
 * pdfkit le manda el byte que puede y sale otra letra. Una remera titulada
 * «Ñandú edición limitada 🚚 ★ Москва» salía impresa como «Ñandú edición
 * limitada Ø=Þš & AÄ>D:C$0 gqN¬», y en el depósito eso es un renglón que nadie
 * puede leer.
 *
 * Las tildes y las eñes sí entran en esa tabla —son lo que más importa acá— y
 * pasan intactas. Lo que no entra se cambia por su equivalente en letras
 * comunes, y si no lo tiene se cae: un emoji de menos en el nombre de un local
 * deja el nombre legible; el mismo emoji mal codificado se lleva puestos los
 * caracteres de al lado.
 */
const REEMPLAZOS = new Map(Object.entries({
  '≈': '~', '≤': '<=', '≥': '>=', '×': 'x', '→': '->', '←': '<-', '⇒': '=>',
  '★': '*', '☆': '*', '✓': 'OK', '✔': 'OK', '✗': 'X', '➜': '->',
  '‑': '-', '‒': '-', '―': '-', '⁄': '/', '№': 'No.', '℮': '', '∅': '0',
  ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '‍': '', '﻿': '',
}));

// Windows-1252 mete en 0x80–0x9F caracteres que Latin-1 deja vacíos.
const ALTOS_1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

const imprimible = (c) => {
  const cp = c.codePointAt(0);
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || ALTOS_1252.has(c);
};

function texto(valor) {
  const crudo = String(valor ?? '').normalize('NFC');
  let salida = '';
  for (const c of crudo) {
    if (imprimible(c)) { salida += c; continue; }
    if (REEMPLAZOS.has(c)) { salida += REEMPLAZOS.get(c); continue; }
    // Una vocal con tilde rara —una â con acento aparte— se recupera partiéndola
    // en letra y diacrítico y quedándose con la letra.
    const plano = c.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    salida += [...plano].every(imprimible) ? plano : '';
  }
  return salida.replace(/[ \t]{2,}/g, ' ').trim();
}

function aBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    doc.end();
  });
}

/*
 * La fecha y la hora, siempre en hora de acá.
 *
 * El servidor de Railway tiene el reloj en UTC, así que formatear con la zona
 * del sistema pone en el papel una hora tres horas adelantada: un pedido de las
 * seis de la tarde sale rotulado a las nueve de la noche, y el del último
 * momento del día aparece con la fecha del día siguiente.
 *
 * Lo que se imprime es `creado_en` —cuándo se hizo el pedido— y no el reloj del
 * momento de generar el PDF: el remito se reimprime cuando se pierde el papel o
 * cuando el depósito lo pide de nuevo, y ahí tiene que seguir diciendo cuándo
 * lo pidió el cliente.
 */
const ZONA = 'America/Argentina/Buenos_Aires';

function fecha(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // hourCycle 'h23' y no el de la locale: es-AR imprime "06:47 p. m.", que
  // ocupa el doble de ancho y se lee peor de reojo que "18:47".
  return d.toLocaleString('es-AR', {
    timeZone: ZONA, hourCycle: 'h23',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace(', ', ' ');
}

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
  /*
   * `bufferPages` deja volver a las hojas ya escritas.
   *
   * El pie dice "Página 3 de 13" y cuántas hojas son se sabe recién cuando se
   * terminó de escribir la última. Sin buffer habría que medir todo el pedido
   * dos veces —una para contar y otra para dibujar— y las dos cuentas se
   * despegan al primer cambio de tipografía.
   */
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  const cliente = pedido.cliente || {};
  const ancho = doc.page.width - 80;
  const PISO = doc.page.height - 70;   // de acá para abajo es el pie
  const TECHO = 50;                    // arranque del contenido en una hoja nueva

  doc.rect(40, 40, ancho, 54).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('ISUWAYA MAYORISTA', 54, 56);
  doc.font('Helvetica').fontSize(9).text('Pedido mayorista', 54, 78);
  doc.font('Helvetica-Bold').fontSize(14).text(texto(pedido.numero), 40, 58, { width: ancho - 14, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(fecha(pedido.creado_en), 40, 78, { width: ancho - 14, align: 'right' });

  let y = 112;

  /*
   * Qué categoría se está listando, para poder repetirla arriba de la hoja
   * siguiente cuando el corte cae en el medio.
   */
  let categoriaActual = null;

  const encabezadoDeCategoria = (nombre, continua) => {
    doc.rect(40, y, ancho, 17).fill('#eef2f7');
    doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(9)
      .text(texto(nombre).toUpperCase() + (continua ? ' (continúa)' : ''), 46, y + 5, { width: ancho - 12, lineBreak: false });
    y += 23;
  };

  const saltarSiHaceFalta = (alto) => {
    if (y + alto < PISO) return false;
    doc.addPage();
    y = TECHO;
    if (categoriaActual !== null) encabezadoDeCategoria(categoriaActual, true);
    return true;
  };

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

  /*
   * Cada fila del cuadro crece con lo que tiene adentro.
   *
   * Con un alto fijo de 30 puntos alcanzaba un nombre de razón social entero
   * para que la segunda línea se metiera abajo del rótulo TELÉFONO: en el papel
   * quedaba "Anónima Comercial e Industrial" escrito arriba de la palabra
   * TELÉFONO, y no se leía ninguno de los dos.
   */
  const anchoValor = ancho / 2 - 14;
  const valorDe = (v) => texto(v) || '—';

  for (let i = 0; i < campos.length; i += 2) {
    const fila = [campos[i], campos[i + 1]].filter(Boolean);
    doc.font('Helvetica-Bold').fontSize(9.5);
    const altoValor = Math.max(...fila.map(([, v]) => doc.heightOfString(valorDe(v), { width: anchoValor })));

    saltarSiHaceFalta(9 + altoValor + 8);
    fila.forEach(([etiqueta, valor], col) => {
      const x = 40 + col * (ancho / 2);
      doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(etiqueta.toUpperCase(), x, y);
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.5)
        .text(valorDe(valor), x, y + 9, { width: anchoValor });
    });
    y += 9 + altoValor + 8;
  }

  y += 6;
  saltarSiHaceFalta(40);
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(11).text('PEDIDO', 40, y);
  y += 16;

  // ── Ítems, agrupados por categoría
  const porCategoria = new Map();
  for (const it of pedido.items || []) {
    const c = it.categoria || 'Sin categoría';
    if (!porCategoria.has(c)) porCategoria.set(c, []);
    porCategoria.get(c).push(it);
  }

  const ANCHO_TITULO = ancho - 150;
  const ANCHO_TALLES = ancho - 200;
  const ANCHO_COLOR = 106;

  const tallesDe = (linea) => (linea.talles || [])
    .map((t) => `${texto(t.talle) || '—'}: ${Number(t.cantidad) || 0}`).join('   ');

  /*
   * Un renglón de color puede ocupar dos líneas por cualquiera de sus dos
   * columnas —un color de nombre largo o una curva de ocho talles—, así que el
   * alto es el del más alto de los dos.
   */
  const altoDeLinea = (linea) => {
    doc.font('Helvetica-Bold').fontSize(8.5);
    const alcolor = doc.heightOfString(texto(linea.color) || 'Único', { width: ANCHO_COLOR });
    doc.font('Helvetica').fontSize(8.5);
    const altalles = doc.heightOfString(tallesDe(linea), { width: ANCHO_TALLES });
    return Math.max(13, Math.max(alcolor, altalles) + 3);
  };

  const altoDeCabecera = (it) => {
    doc.font('Helvetica-Bold').fontSize(9.5);
    let alto = doc.heightOfString(texto(it.titulo) || '—', { width: ANCHO_TITULO });
    if (texto(it.skuAgrupador)) {
      doc.font('Helvetica').fontSize(8);
      alto += doc.heightOfString(texto(it.skuAgrupador), { width: ANCHO_TITULO });
    }
    return alto + 6;
  };

  const altoDelItem = (it) => {
    let alto = altoDeCabecera(it);
    for (const linea of it.detalle || []) alto += altoDeLinea(linea);
    if (it.curvas) alto += 13;
    return alto + 5;
  };

  for (const [categoria, items] of [...porCategoria.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'))) {
    /*
     * El salto que abre una categoría nueva no tiene que repetir el título de
     * la anterior: la hoja arrancaría con el encabezado de algo que ya terminó.
     */
    categoriaActual = null;
    saltarSiHaceFalta(40);
    categoriaActual = categoria;
    encabezadoDeCategoria(categoria, false);

    for (const it of items.sort((a, b) => String(a.titulo || '').localeCompare(String(b.titulo || ''), 'es'))) {
      /*
       * El producto no se parte: o entra entero en lo que queda de hoja o
       * empieza en la siguiente. Un título solo al pie de la página, con sus
       * colores y cantidades en la hoja de atrás, es exactamente el renglón que
       * se arma mal en el depósito.
       *
       * Un producto de treinta colores no entra en ninguna hoja: ese sí se
       * parte, pero recién después de arrancar arriba de todo.
       */
      const alto = altoDelItem(it);
      saltarSiHaceFalta(Math.min(alto, PISO - TECHO - 1));

      const titulo = texto(it.titulo) || '—';
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(9.5).text(titulo, 46, y, { width: ANCHO_TITULO });
      let alturaCabecera = doc.heightOfString(titulo, { width: ANCHO_TITULO });

      // Las cantidades se alinean con la primera línea del título, que es donde
      // las busca el ojo aunque el nombre del producto ocupe tres renglones.
      doc.fillColor('#111').font('Helvetica').fontSize(9)
        .text(`${it.unidades ?? 0} u.`, 40, y, { width: ancho - 90, align: 'right', lineBreak: false });
      doc.font('Helvetica-Bold').text(pesos(it.subtotal), 40, y, { width: ancho - 14, align: 'right', lineBreak: false });

      const sku = texto(it.skuAgrupador);
      if (sku) {
        doc.fillColor(GRIS).font('Helvetica').fontSize(8).text(sku, 46, y + alturaCabecera, { width: ANCHO_TITULO });
        alturaCabecera += doc.heightOfString(sku, { width: ANCHO_TITULO });
      }
      y += alturaCabecera + 6;

      /*
       * El detalle va por color y con los talles en una línea.
       *
       * Una fila por talle sería más "prolijo" y haría que un pedido de diez
       * productos ocupe cinco hojas. Quien arma el pedido necesita ver de un
       * vistazo cuántas unidades de cada talle van en cada color.
       */
      for (const linea of it.detalle || []) {
        const altoLinea = altoDeLinea(linea);
        saltarSiHaceFalta(altoLinea);
        doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(8.5).text(texto(linea.color) || 'Único', 60, y, { width: ANCHO_COLOR });
        doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(tallesDe(linea), 172, y, { width: ANCHO_TALLES });
        y += altoLinea;
      }

      if (it.curvas) {
        saltarSiHaceFalta(14);
        doc.fillColor(VERDE).font('Helvetica-Oblique').fontSize(8)
          .text(`Pedido por curva · ${it.curvas} curva${it.curvas === 1 ? '' : 's'} completa${it.curvas === 1 ? '' : 's'}`, 60, y, { lineBreak: false });
        y += 13;
      }
      y += 5;
    }
  }

  // ── Total
  categoriaActual = null;   // el total no va abajo del encabezado de una categoría
  saltarSiHaceFalta(60);
  y += 6;
  doc.rect(40, y, ancho, 46).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica').fontSize(9).text('TOTAL DEL PEDIDO', 54, y + 10, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9)
    .text(`${pedido.unidades ?? 0} unidades`, 54, y + 25, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(20)
    .text(pesos(pedido.total), 40, y + 13, { width: ancho - 14, align: 'right', lineBreak: false });

  /*
   * El pie se escribe al final, hoja por hoja.
   *
   * Con quince hojas sueltas sobre la mesa del depósito, una sin numerar es una
   * hoja que nadie sabe si falta. Y la aclaración de que no es un comprobante
   * fiscal tiene que estar en todas, no sólo en la última: son papeles que se
   * separan.
   */
  const hojas = doc.bufferedPageRange();
  for (let i = 0; i < hojas.count; i++) {
    doc.switchToPage(hojas.start + i);
    /*
     * El pie cae abajo del margen inferior, y pdfkit contra el margen abre una
     * hoja nueva sola: escribir el pie de la última hoja creaba una hoja más,
     * que a su vez pedía su pie, y el remito de una carilla salía de tres.
     */
    const margenAbajo = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5)
      .text('Este documento es el detalle del pedido. No es una factura ni un comprobante fiscal.',
        40, doc.page.height - 56, { width: ancho, align: 'center', lineBreak: false });
    doc.text(texto(pedido.numero), 40, doc.page.height - 44, { width: ancho, align: 'left', lineBreak: false });
    doc.text(`Página ${i + 1} de ${hojas.count}`, 40, doc.page.height - 44, { width: ancho, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margenAbajo;
  }

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
  const cliente = pedido.cliente || {};
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
  /*
   * La localidad se arma con lo que haya.
   *
   * Interpolando ciudad y postal derecho, un pedido viejo al que le falta el
   * dato salía rotulado "undefined (undefined)": el renglón nunca queda vacío,
   * así que el filtro de líneas sin valor no lo sacaba nunca.
   */
  const localidad = [texto(cliente.ciudad), texto(cliente.codigoPostal) && `(${texto(cliente.codigoPostal)})`]
    .filter(Boolean).join(' ');

  const lineas = [
    { et: 'Destinatario', valor: texto(cliente.nombre), peso: 1.35 },
    { et: 'CUIT', valor: texto(cliente.cuit), peso: 1 },
    { et: 'Dirección', valor: texto(cliente.direccion), peso: 1.1 },
    ...(texto(cliente.entreCalles) ? [{ et: 'Entre calles', valor: texto(cliente.entreCalles), peso: 0.9 }] : []),
    { et: 'Localidad', valor: localidad, peso: 1.15 },
    { et: 'Provincia', valor: texto(cliente.provincia), peso: 1 },
  ].filter((l) => l.valor !== '');

  const altoCon = (base) => lineas.reduce((total, l) => {
    const cuerpo = base * l.peso;
    doc.font('Helvetica-Bold').fontSize(cuerpo);
    return total + 7 + doc.heightOfString(l.valor, { width: ancho }) + 7;
  }, 0);

  let base = 15;
  while (base > 7 && altoCon(base) > disponible) base -= 0.5;

  /*
   * Si ni en el cuerpo más chico entra, se recorta con puntos suspensivos.
   *
   * Es el mal menor y no pasa nunca con una dirección real: pasa cuando alguien
   * pega media carta en el campo "entre calles". Sin el recorte, ese texto se
   * escribe encima del recuadro de la forma de envío y se pierde el dato con el
   * que el paquete viaja.
   */
  const recortar = altoCon(base) > disponible;

  doc.rect(0, 0, 10 * CM, 1.5 * CM).fill(AZUL);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13).text('ISUWAYA', M, 0.35 * CM, { lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).text('MAYORISTA', M, 0.85 * CM, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10)
    .text(texto(pedido.numero), 0, 0.42 * CM, { width: 10 * CM - M, align: 'right', lineBreak: false });
  /*
   * La fecha del pedido, abajo del número y en la misma esquina.
   *
   * Es el dato con el que se resuelve un reclamo por teléfono —"el del jueves a
   * la tarde"— y el que ordena la pila de paquetes que esperan al transporte.
   * Va chica a propósito: no compite con la dirección, que es lo que el rótulo
   * tiene que gritar.
   */
  doc.font('Helvetica').fontSize(7.5)
    .text(fecha(pedido.creado_en), 0, 0.92 * CM, { width: 10 * CM - M, align: 'right', lineBreak: false });

  let y = yInicio;
  for (const l of lineas) {
    const cuerpo = base * l.peso;
    doc.fillColor(GRIS).font('Helvetica').fontSize(6.8).text(l.et.toUpperCase(), M, y, { lineBreak: false });
    y += 7;
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(cuerpo);
    const opciones = recortar
      ? { width: ancho, height: Math.max(cuerpo * 2.4, (disponible / lineas.length) - 14), ellipsis: true }
      : { width: ancho };
    doc.text(l.valor, M, y, opciones);
    // `heightOfString` mide el texto entero y no lo que entró en el recorte, así
    // que el avance se topea en el alto que se le dio: si no, el renglón
    // siguiente arranca más abajo de donde terminó éste.
    y += Math.min(doc.heightOfString(l.valor, { width: ancho }), opciones.height ?? Infinity) + 7;
  }

  doc.rect(M, yEnvio, ancho, ALTO_ENVIO).lineWidth(1.3).strokeColor(VERDE).stroke();
  doc.fillColor(GRIS).font('Helvetica').fontSize(6.8).text('FORMA DE ENVÍO', M + 9, yEnvio + 8, { lineBreak: false });

  /*
   * La forma de envío también se mide antes de escribirla.
   *
   * "Andreani a sucursal" entra en un renglón; "Retiro en sucursal de Correo
   * Argentino" ocupa dos y se salía por debajo del recuadro, con la última
   * línea cortada por el borde. El texto se achica hasta entrar: un rótulo con
   * el transporte a medio leer es un paquete que vuelve.
   */
  const textoEnvio = texto(cliente.formaEnvio) || '—';
  const anchoEnvio = ancho - 18;
  const altoEnvioDisponible = ALTO_ENVIO - 24;
  let cuerpoEnvio = 13;
  doc.font('Helvetica-Bold');
  while (cuerpoEnvio > 6) {
    doc.fontSize(cuerpoEnvio);
    if (doc.heightOfString(textoEnvio, { width: anchoEnvio }) <= altoEnvioDisponible) break;
    cuerpoEnvio -= 0.5;
  }
  doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(cuerpoEnvio)
    .text(textoEnvio, M + 9, yEnvio + 20, { width: anchoEnvio, height: altoEnvioDisponible, ellipsis: true });

  doc.fillColor(GRIS).font('Helvetica').fontSize(6.5)
    .text(`Tel. ${texto(cliente.telefono) || '—'}`, M, 15 * CM - 0.38 * CM, { width: ancho, align: 'right', lineBreak: false });

  return aBuffer(doc);
}

module.exports = { pdfPedido, pdfRotulo };
