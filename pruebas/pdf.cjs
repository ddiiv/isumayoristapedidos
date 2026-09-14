/*
 * Pruebas de los dos papeles: el remito A4 y el rótulo de 10 × 15.
 *
 * No hace falta el servidor: se arman pedidos a mano y se llama directo a
 * `src/pdf.js`. Un PDF que "se genera bien" —empieza con %PDF y pesa unos
 * kilobytes— puede tener el texto encimado o media dirección afuera del papel,
 * así que acá se mide de verdad: se sacan las cajas de cada palabra con
 * `pdftotext -bbox` y se revisa que ninguna se salga de la hoja ni pise a otra.
 *
 * Uso:  node pruebas/pdf.cjs            (deja los PDF en /tmp/isuwaya-pdf)
 *       node pruebas/pdf.cjs --png      (además convierte cada página a PNG)
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { pdfPedido, pdfRotulo } = require('../src/pdf');

const SALIDA = process.env.SALIDA_PDF || '/tmp/isuwaya-pdf';
const CON_PNG = process.argv.includes('--png');

let ok = 0, ko = 0;
const chk = (t, condicion, detalle = '') => {
  if (condicion) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}${detalle ? `\n      ${detalle}` : ''}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

// ── Medición del PDF ya escrito ───────────────────────────────────
/*
 * Se leen las cajas del PDF terminado y no las cuentas que hizo el generador.
 *
 * Es la única forma de que la prueba falle cuando el código de armado se
 * equivoca: si preguntáramos por las mismas medidas que usó para dibujar,
 * confirmaría su propio error.
 */
function palabras(archivo) {
  const xml = execFileSync('pdftotext', ['-bbox', archivo, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const paginas = [];
  const rePagina = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const rePalabra = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;
  let p;
  while ((p = rePagina.exec(xml))) {
    const items = [];
    let w;
    while ((w = rePalabra.exec(p[3]))) {
      items.push({
        x0: +w[1], y0: +w[2], x1: +w[3], y1: +w[4],
        texto: w[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      });
    }
    paginas.push({ ancho: +p[1], alto: +p[2], palabras: items });
  }
  return paginas;
}

/** Palabras que se salen del papel (o que quedan pegadas al borde). */
function afuera(pagina, margen = 2) {
  return pagina.palabras.filter((w) =>
    w.x0 < margen || w.y0 < margen || w.x1 > pagina.ancho - margen || w.y1 > pagina.alto - margen);
}

/*
 * Dos palabras encimadas.
 *
 * Se comparan por área compartida y no por "están en la misma altura": las
 * tildes y los rabos de las letras hacen que renglones seguidos se rocen unos
 * décimos de punto, y con un criterio de contacto toda página daría error.
 */
function encimadas(pagina, tolerancia = 0.3) {
  const orden = [...pagina.palabras].sort((a, b) => a.y0 - b.y0);
  const choques = [];
  for (let i = 0; i < orden.length; i++) {
    const a = orden[i];
    for (let j = i + 1; j < orden.length && orden[j].y0 < a.y1; j++) {
      const b = orden[j];
      const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (dx <= 0 || dy <= 0) continue;
      const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
      const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (dx * dy > tolerancia * Math.min(areaA, areaB)) choques.push([a.texto, b.texto]);
    }
  }
  return choques;
}

const textoDe = (paginas) => paginas.map((p) => p.palabras.map((w) => w.texto).join(' ')).join(' \n ');

async function revisar(nombre, buffer, { paginasEsperadas } = {}) {
  const archivo = path.join(SALIDA, `${nombre}.pdf`);
  fs.writeFileSync(archivo, buffer);

  chk(`${nombre}: es un PDF`, buffer.subarray(0, 5).toString() === '%PDF-');
  const paginas = palabras(archivo);
  chk(`${nombre}: tiene páginas`, paginas.length > 0, `páginas: ${paginas.length}`);
  if (paginasEsperadas) {
    chk(`${nombre}: ${paginasEsperadas} página(s)`, paginas.length === paginasEsperadas,
      `obtuvo ${paginas.length}`);
  }

  let fuera = 0, choques = [];
  for (const pagina of paginas) {
    fuera += afuera(pagina).length;
    choques = choques.concat(encimadas(pagina));
  }
  chk(`${nombre}: nada se sale del papel`, fuera === 0, `${fuera} palabra(s) fuera de la hoja`);
  chk(`${nombre}: nada queda encimado`, choques.length === 0,
    choques.slice(0, 4).map(([a, b]) => `"${a}" pisa "${b}"`).join(' · ') + (choques.length > 4 ? ` … y ${choques.length - 4} más` : ''));

  if (CON_PNG) {
    execFileSync('pdftoppm', ['-png', '-r', '110', archivo, path.join(SALIDA, nombre)]);
  }
  return { paginas, texto: textoDe(paginas) };
}

// ── Pedidos de mentira ────────────────────────────────────────────
const CLIENTE = {
  nombre: 'Comercializadora Ñandú S.R.L.',
  cuit: '30-71234567-8',
  telefono: '11 4567-8900',
  email: 'compras@nandu.com.ar',
  provincia: 'Córdoba',
  ciudad: 'Villa Carlos Paz',
  codigoPostal: '5152',
  direccion: 'Av. San Martín 1847, piso 3 "B"',
  entreCalles: 'Belgrano y Rivadavia',
  formaEnvio: 'Andreani a sucursal',
};

const item = (n, extra = {}) => ({
  skuAgrupador: `SKU-${String(n).padStart(4, '0')}`,
  titulo: `Remera algodón peinado modelo ${n}`,
  categoria: 'Remeras',
  precio: 8500,
  curvas: 0,
  unidades: 12,
  subtotal: 102000,
  detalle: [
    { color: 'Negro', talles: [{ talle: 'S', cantidad: 2 }, { talle: 'M', cantidad: 4 }, { talle: 'L', cantidad: 3 }, { talle: 'XL', cantidad: 3 }] },
  ],
  ...extra,
});

const pedidoBase = (extra = {}) => ({
  numero: 'ISU-000123',
  creado_en: '2026-03-14T18:47:05.000Z',   // 15:47 en Buenos Aires
  cliente: CLIENTE,
  items: [item(1)],
  total: 102000,
  unidades: 12,
  ...extra,
});

// Un pedido de verdad grande: 150 renglones repartidos en varias categorías.
const CATEGORIAS = ['Remeras', 'Buzos', 'Camperas', 'Pantalones', 'Accesorios', 'Calzado'];
const COLORES = ['Negro', 'Blanco', 'Azul marino', 'Verde militar', 'Bordó'];
const pedidoGrande = () => {
  const items = Array.from({ length: 150 }, (_, i) => item(i + 1, {
    categoria: CATEGORIAS[i % CATEGORIAS.length],
    titulo: `Producto ${i + 1} — ${['básico', 'oversize', 'entallado', 'clásico'][i % 4]}`,
    detalle: Array.from({ length: (i % 3) + 1 }, (_, c) => ({
      color: COLORES[(i + c) % COLORES.length],
      talles: [{ talle: 'S', cantidad: 2 }, { talle: 'M', cantidad: 5 }, { talle: 'L', cantidad: 5 }, { talle: 'XL', cantidad: 3 }, { talle: 'XXL', cantidad: 2 }],
    })),
    curvas: i % 5 === 0 ? 2 : 0,
  }));
  return pedidoBase({
    items,
    unidades: items.reduce((t, x) => t + x.unidades, 0),
    total: items.reduce((t, x) => t + x.subtotal, 0),
  });
};

const LARGO = 'Distribuidora Mayorista de Indumentaria y Marroquinería del Litoral Argentino Sociedad Anónima Comercial e Industrial';
const pedidoLargos = () => pedidoBase({
  numero: 'ISU-000999',
  cliente: {
    ...CLIENTE,
    nombre: LARGO,
    direccion: 'Avenida Presidente General Don Juan Domingo Perón 12345, torre 2, piso 14, departamento "D", barrio privado Los Álamos del Oeste',
    entreCalles: 'Entre Avenida de los Constituyentes y Calle Doctor Nicolás Avellaneda, a la vuelta del supermercado grande',
    ciudad: 'San Miguel de Tucumán del Norte Grande',
    provincia: 'Santiago del Estero',
    formaEnvio: 'Retiro en sucursal de Correo Argentino con seguro y acuse de recibo',
    email: 'departamento.de.compras.mayoristas@distribuidoradelitoral.com.ar',
  },
  items: [item(1, { titulo: `Conjunto deportivo ${LARGO}`, categoria: 'Indumentaria deportiva de alta competición para mayoristas' })],
});

const pedidoRaros = () => pedidoBase({
  numero: 'ISU-00Ñ01',
  cliente: {
    ...CLIENTE,
    nombre: 'Ñoño Peñaloza & Hijos «El Águila» ¿S.A.?',
    direccion: 'Calle Iguazú 1.234 – piso 2º «A» — timbre nº 7',
    entreCalles: 'Güemes y Ñuñorco · ¡ojo con el portón!',
    ciudad: 'Río Cuarto',
    formaEnvio: 'Vía Cargo — «a domicilio»',
  },
  items: [item(1, {
    titulo: 'Remera «Ñandú» edición limitada 🚚 ★ Москва 東京',
    categoria: 'Ediciones especiales · ½ temporada',
    detalle: [{ color: 'Verde ≈ oliva', talles: [{ talle: 'Único', cantidad: 12 }] }],
  })],
});

const pedidoUnaLinea = () => pedidoBase({
  numero: 'ISU-000007',
  items: [item(1, { unidades: 1, subtotal: 8500, detalle: [{ color: '', talles: [{ talle: 'Único', cantidad: 1 }] }] })],
  unidades: 1,
  total: 8500,
});

const pedidoVacios = () => pedidoBase({
  numero: 'ISU-000008',
  cliente: { ...CLIENTE, email: '', entreCalles: '' },
});

// Un pegote sin espacios: no hay dónde cortar el renglón.
const pedidoSinEspacios = () => pedidoBase({
  numero: 'ISU-000009',
  cliente: {
    ...CLIENTE,
    nombre: 'DistribuidoraMayoristaDeIndumentariaYMarroquineriaDelLitoralArgentinoSA',
    direccion: 'AvenidaPresidenteGeneralDonJuanDomingoPeron12345TorreDosPisoCatorceDepartamentoD',
    entreCalles: 'CalleMuyLargaSinEspaciosNiGuionesQueNoSePuedeCortarEnNingunLado',
    formaEnvio: 'RetiroEnSucursalDeCorreoArgentinoConSeguroYAcuseDeRecibo',
  },
  items: [item(1, { titulo: 'RemeraDeAlgodonPeinadoVeinticuatroUnoConCuelloRedondoYPuñoElastizado' })],
});

/*
 * Un rótulo con todo al máximo: no hay cuerpo de letra con el que esto entre.
 * El bloque tiene que recortarse antes que escribir arriba del recuadro del
 * transporte, que es el dato con el que el paquete viaja.
 */
const pedidoRotuloImposible = () => pedidoBase({
  numero: 'ISU-000011',
  cliente: {
    ...CLIENTE,
    nombre: LARGO + ' ' + LARGO,
    direccion: ('Avenida Presidente General Don Juan Domingo Perón 12345 ').repeat(20),
    entreCalles: ('Entre la calle de los mil nombres y la otra que tampoco se acaba ').repeat(20),
    ciudad: 'San Miguel del Monte de los Álamos de la Sierra Chica del Norte Grande',
    provincia: 'Santiago del Estero del Norte Argentino',
  },
});

// Un producto con más colores de los que entran en una hoja: el corte cae
// adentro del ítem y no hay forma de evitarlo, pero no tiene que romper nada.
const pedidoItemGigante = () => pedidoBase({
  numero: 'ISU-000012',
  items: [item(1, {
    titulo: 'Remera básica — todos los colores del catálogo',
    detalle: Array.from({ length: 60 }, (_, c) => ({
      color: `${COLORES[c % COLORES.length]} tono ${c + 1}`,
      talles: [{ talle: 'S', cantidad: 2 }, { talle: 'M', cantidad: 5 }, { talle: 'L', cantidad: 5 }, { talle: 'XL', cantidad: 3 }],
    })),
  })],
});

// ── A correr ──────────────────────────────────────────────────────
(async () => {
  fs.rmSync(SALIDA, { recursive: true, force: true });
  fs.mkdirSync(SALIDA, { recursive: true });

  tit('1. UN PEDIDO NORMAL');
  const normal = await revisar('pedido-normal', await pdfPedido(pedidoBase()), { paginasEsperadas: 1 });
  await revisar('rotulo-normal', await pdfRotulo(pedidoBase()), { paginasEsperadas: 1 });

  tit('2. FECHA Y HORA DEL PEDIDO, EN HORA DE ARGENTINA');
  /*
   * El pedido se hizo a las 18:47 UTC, que acá son las 15:47. El servidor de
   * Railway tiene el reloj en UTC: si la fecha se formatea sin fijar la zona,
   * el papel dice una hora que no es la nuestra.
   */
  chk('el remito dice la hora de Buenos Aires', /15:47/.test(normal.texto), normal.texto.slice(0, 220));
  chk('el remito dice la fecha del pedido', /14\/03\/2026/.test(normal.texto), normal.texto.slice(0, 220));

  const rotulo = await revisar('rotulo-fecha', await pdfRotulo(pedidoBase()), { paginasEsperadas: 1 });
  chk('el rótulo dice la hora de Buenos Aires', /15:47/.test(rotulo.texto), rotulo.texto.slice(0, 220));
  chk('el rótulo dice la fecha del pedido', /14\/03\/2026/.test(rotulo.texto), rotulo.texto.slice(0, 220));

  /*
   * La fecha es la del pedido, no la del día que se imprime: un remito que se
   * reimprime tres días después tiene que seguir diciendo cuándo se pidió.
   */
  const viejo = pedidoBase({ creado_en: '2024-01-02T03:04:05.000Z' });   // 2/1/2024 00:04 acá
  const reimpreso = await revisar('pedido-reimpreso', await pdfPedido(viejo));
  chk('reimprimir no cambia la fecha del pedido', /02\/01\/2024/.test(reimpreso.texto), reimpreso.texto.slice(0, 220));
  const rotuloViejo = await revisar('rotulo-reimpreso', await pdfRotulo(viejo));
  chk('el rótulo reimpreso tampoco', /02\/01\/2024/.test(rotuloViejo.texto), rotuloViejo.texto.slice(0, 220));

  tit('3. UN PEDIDO DE 150 RENGLONES');
  const grande = await revisar('pedido-150', await pdfPedido(pedidoGrande()));
  chk('ocupa varias páginas', grande.paginas.length > 3, `páginas: ${grande.paginas.length}`);
  /*
   * El encabezado de la categoría se repite al pasar de página: sin eso, la
   * segunda hoja arranca con una lista de productos sin decir de qué son.
   */
  const conts = (grande.texto.match(/continúa/gi) || []).length;
  chk('la categoría cortada se repite en la hoja siguiente', conts > 0, `encabezados repetidos: ${conts}`);
  chk('todas las páginas están numeradas',
    grande.paginas.every((p) => p.palabras.some((w) => /^Página$/i.test(w.texto))),
    grande.paginas.map((p, i) => `${i + 1}:${p.palabras.some((w) => /^Página$/i.test(w.texto))}`).join(' '));
  chk('están los 150 renglones', grande.texto.includes('Producto 150'), '');

  tit('4. NOMBRES Y DIRECCIONES LARGUÍSIMOS');
  const largos = await revisar('pedido-largos', await pdfPedido(pedidoLargos()));
  await revisar('rotulo-largos', await pdfRotulo(pedidoLargos()), { paginasEsperadas: 1 });

  tit('5. ACENTOS, EÑES Y CARACTERES RAROS');
  const raros = await revisar('pedido-raros', await pdfPedido(pedidoRaros()));
  chk('las eñes y tildes llegan enteras', /Peñaloza/.test(raros.texto), raros.texto.slice(0, 200));
  await revisar('rotulo-raros', await pdfRotulo(pedidoRaros()), { paginasEsperadas: 1 });

  tit('6. UN PEDIDO DE UNA SOLA LÍNEA');
  await revisar('pedido-una-linea', await pdfPedido(pedidoUnaLinea()), { paginasEsperadas: 1 });
  await revisar('rotulo-una-linea', await pdfRotulo(pedidoUnaLinea()), { paginasEsperadas: 1 });

  tit('7. CAMPOS OPCIONALES VACÍOS');
  await revisar('pedido-vacios', await pdfPedido(pedidoVacios()), { paginasEsperadas: 1 });
  await revisar('rotulo-vacios', await pdfRotulo(pedidoVacios()), { paginasEsperadas: 1 });

  tit('8. TEXTO SIN ESPACIOS DONDE CORTAR');
  await revisar('pedido-sin-espacios', await pdfPedido(pedidoSinEspacios()), { paginasEsperadas: 1 });
  await revisar('rotulo-sin-espacios', await pdfRotulo(pedidoSinEspacios()), { paginasEsperadas: 1 });

  tit('9. UN ROTULO QUE NO ENTRA NI ACHICADO');
  const imposible = await revisar('rotulo-imposible', await pdfRotulo(pedidoRotuloImposible()), { paginasEsperadas: 1 });
  /*
   * El recuadro de la forma de envío arranca 8 puntos arriba de su rótulo. Si
   * alguna palabra del bloque del destinatario baja de esa línea, está escrita
   * sobre el borde o adentro de la caja del transporte.
   */
  const etiquetaEnvio = imposible.paginas[0].palabras.find((w) => w.texto === 'FORMA');
  chk('el rótulo imposible tiene su recuadro de envío', !!etiquetaEnvio);
  if (etiquetaEnvio) {
    const invasoras = imposible.paginas[0].palabras.filter((w) => w.y1 > etiquetaEnvio.y0 - 8 && w.y1 < etiquetaEnvio.y0 + 4);
    chk('el destinatario no se mete en el recuadro de la forma de envío',
      invasoras.length === 0, invasoras.map((w) => `"${w.texto}"`).join(' '));
  }
  chk('lo recortado se marca con puntos suspensivos', /…/.test(imposible.texto), imposible.texto.slice(-160));

  tit('10. UN PRODUCTO MÁS ALTO QUE LA HOJA');
  const gigante = await revisar('pedido-item-gigante', await pdfPedido(pedidoItemGigante()));
  chk('el producto que no entra se parte en varias hojas', gigante.paginas.length >= 2, `páginas: ${gigante.paginas.length}`);
  chk('están los 60 colores', /tono 60/.test(gigante.texto));

  tit('11. LA ZONA HORARIA NO DEPENDE DEL RELOJ DEL SERVIDOR');
  /*
   * Railway corre en UTC y una máquina de desarrollo puede estar en cualquier
   * lado. La hora del papel es siempre la de Buenos Aires, la ponga quien la
   * ponga: si esto falla, el rótulo miente por tres horas y el remito del final
   * del día sale con la fecha del día siguiente.
   */
  const tzOriginal = process.env.TZ;
  for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    const conTz = await revisar(`pedido-tz-${tz.replace(/\//g, '-')}`, await pdfPedido(pedidoBase()));
    const rotTz = await revisar(`rotulo-tz-${tz.replace(/\//g, '-')}`, await pdfRotulo(pedidoBase()));
    chk(`con TZ=${tz} el remito sigue diciendo 14/03/2026 15:47`,
      /14\/03\/2026/.test(conTz.texto) && /15:47/.test(conTz.texto), conTz.texto.slice(0, 120));
    chk(`con TZ=${tz} el rótulo sigue diciendo 14/03/2026 15:47`,
      /14\/03\/2026/.test(rotTz.texto) && /15:47/.test(rotTz.texto), rotTz.texto.slice(0, 120));
  }
  if (tzOriginal === undefined) delete process.env.TZ; else process.env.TZ = tzOriginal;

  tit('12. CARACTERES QUE LA TIPOGRAFÍA DEL PDF NO SABE ESCRIBIR');
  /*
   * Helvetica sólo escribe Windows-1252. Un emoji o una palabra en cirílico no
   * salen vacíos: salen como otras letras, y se llevan puesto el renglón entero.
   * Lo que no se puede escribir se cae; lo que sí —tildes, eñes, comillas
   * latinas— tiene que llegar intacto.
   */
  const exotico = await revisar('pedido-exotico', await pdfPedido(pedidoBase({
    cliente: { ...CLIENTE, nombre: 'Textiles 🚚 Río Negro ★ S.R.L.', direccion: 'Calle 東京 nº 7 — piso 2º' },
    items: [item(1, { titulo: 'Buzo ≈ oversize 🧵 Москва', categoria: 'Ropa 👕 de abrigo' })],
  })));
  chk('lo que la tipografía no sabe escribir no ensucia el renglón',
    !/Ø=|Þ|gqN|AÄ>/.test(exotico.texto), exotico.texto.slice(0, 260));
  chk('el nombre queda legible sin el emoji', /Textiles Río Negro \* S\.R\.L\./.test(exotico.texto), exotico.texto.slice(0, 260));
  chk('las tildes y la ñ sobreviven', /Río/.test(exotico.texto) && /nº/.test(exotico.texto), exotico.texto.slice(0, 260));

  tit('13. UN ROTULO SIN CIUDAD NI CÓDIGO POSTAL');
  /*
   * Un pedido viejo puede no tener el dato. El renglón se saca; lo que no puede
   * pasar es que el rótulo salga diciendo "undefined (undefined)" al lado de la
   * palabra LOCALIDAD.
   */
  const sinLocalidad = await revisar('rotulo-sin-localidad', await pdfRotulo(pedidoBase({
    cliente: { ...CLIENTE, ciudad: '', codigoPostal: '' },
  })), { paginasEsperadas: 1 });
  chk('no aparece "undefined" en el rótulo', !/undefined/i.test(sinLocalidad.texto), sinLocalidad.texto.slice(0, 200));
  chk('el renglón de localidad desaparece entero', !/LOCALIDAD/.test(sinLocalidad.texto), sinLocalidad.texto.slice(0, 200));

  /*
   * El teléfono del cliente va en el rótulo, y el código postal en su propio
   * recuadro: pegado a la ciudad, "(5152)", había que buscarlo adentro del
   * renglón.
   */
  const conTodo = await revisar('rotulo-cp-y-telefono', await pdfRotulo(pedidoBase({ cliente: { ...CLIENTE } })));
  chk('el rótulo lleva el teléfono del cliente', conTodo.texto.includes(CLIENTE.telefono), conTodo.texto.slice(0, 300));
  chk('con su título, como el resto de los datos', /TEL[EÉ]FONO/.test(conTodo.texto), conTodo.texto.slice(0, 300));
  chk('el código postal tiene su recuadro', /C[OÓ]DIGO POSTAL/.test(conTodo.texto), conTodo.texto.slice(0, 300));
  chk('y ya no va entre paréntesis pegado a la ciudad', !conTodo.texto.includes(`(${CLIENTE.codigoPostal})`), conTodo.texto.slice(0, 300));

  tit('14. NADA REVIENTA CON DATOS INCOMPLETOS');
  /*
   * Un pedido viejo o a medio guardar no puede tumbar la descarga del remito:
   * quien lo abre necesita el papel, aunque le falte un campo.
   */
  const flaco = { numero: 'ISU-000010', creado_en: null, cliente: { nombre: 'Sin datos' }, items: [], total: 0, unidades: 0 };
  let sobrevive = true;
  let flacoTexto = '';
  try {
    flacoTexto = (await revisar('pedido-flaco', await pdfPedido(flaco))).texto;
    flacoTexto += ' ' + (await revisar('rotulo-flaco', await pdfRotulo(flaco))).texto;
  } catch (e) { sobrevive = false; console.log(`      ${e.message}`); }
  chk('un pedido incompleto igual sale impreso', sobrevive);
  chk('sin fecha guardada no se inventa una', !/1969|1970/.test(flacoTexto), flacoTexto.slice(0, 200));
  chk('no aparece "undefined" ni "NaN" en ningún papel', !/undefined|NaN|Invalid/i.test(flacoTexto), flacoTexto.slice(0, 240));

  /*
   * El otro extremo: campos que no son texto. El panel guarda lo que viene del
   * navegador, y un JSON a medio armar puede traer un número donde va un nombre.
   */
  let aguanta = true;
  try {
    await revisar('pedido-tipos-raros', await pdfPedido({
      numero: 12345, creado_en: 'no es una fecha',
      cliente: { nombre: 42, cuit: null, telefono: undefined, direccion: { calle: 'x' }, ciudad: [], provincia: true, codigoPostal: 0, formaEnvio: '' },
      items: [{ titulo: null, categoria: undefined, unidades: '3', subtotal: '1200', detalle: [{ color: null, talles: [{ talle: null, cantidad: null }] }] }],
      total: '1200', unidades: null,
    }));
    await revisar('rotulo-tipos-raros', await pdfRotulo({ numero: 12345, creado_en: 'no es una fecha', cliente: { nombre: 42 } }), { paginasEsperadas: 1 });
  } catch (e) { aguanta = false; console.log(`      ${e.message}`); }
  chk('con campos de otro tipo tampoco revienta', aguanta);

  console.log(`\n${ko ? '\x1b[31m' : '\x1b[32m'}${ok} bien · ${ko} mal\x1b[0m`);
  console.log(`PDFs en ${SALIDA}`);
  process.exit(ko ? 1 : 0);
})();
