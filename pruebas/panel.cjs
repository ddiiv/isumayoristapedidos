/*
 * Pruebas del seguimiento de pedidos y de las estadísticas del panel.
 *
 * Como las de `correr.cjs`, corren contra el servidor levantado y las que más
 * importan son las adversarias: qué pasa cuando alguien manda por la API lo
 * que la pantalla no deja mandar. Acá eso son dos cosas concretas —un pedido
 * entregado que quiere volver atrás, y un total escrito por el navegador— y
 * las dos tienen que rebotar en el servidor, no en el botón.
 *
 * Escribe pedidos: conviene apuntarla a un servidor con una copia de la base.
 *
 * Uso:  API=http://localhost:8091 node pruebas/panel.cjs
 */

// Las credenciales salen del .env, nunca de acá: ver la nota en correr.cjs.
require('../src/entorno').cargarEnv();

const API = process.env.API || 'http://localhost:8090';
const CLAVE_ADMIN = process.env.ADMIN_PASSWORD;
const EMAIL_ADMIN = process.env.ADMIN_EMAIL;

if (!CLAVE_ADMIN || !EMAIL_ADMIN) {
  console.error('\n  Faltan ADMIN_EMAIL y ADMIN_PASSWORD en el .env.\n');
  process.exit(1);
}

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

/*
 * Dos cookies a la vez: el dueño y un cliente.
 *
 * Buena parte de lo que hay que probar es justamente que lo del cliente no se
 * mezcle con lo del otro —el pedido ajeno, el panel—, y con una sola cookie
 * habría que entrar y salir entre cada llamada.
 */
const cookies = { admin: '', cliente: '' };
/*
 * Cada pedido de prueba sale con una IP distinta.
 *
 * El servidor frena más de diez pedidos por minuto desde una misma IP, y esta
 * suite hace más que eso en segundos: sin esto mediría el limitador y no lo
 * que dice que mide. Localmente la IP se toma de esta cabecera; en Railway la
 * pone su proxy y no se puede falsear desde afuera.
 */
const ipDePrueba = () => `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

async function pedir(ruta, { metodo = 'GET', cuerpo, como = null } = {}) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(como && cookies[como] ? { Cookie: cookies[como] } : {}),
      'X-Forwarded-For': ipDePrueba(),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length && como) cookies[como] = set.map((c) => c.split(';')[0]).join('; ');
  let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
  return { status: r.status, json };
}

const sello = Date.now().toString(36);

/*
 * Un CUIT válido distinto en cada corrida: el CUIT identifica al cliente, y con
 * uno fijo la segunda corrida contra la misma base choca con la cuenta de la
 * primera.
 */
function cuitAlAzar(prefijo = '20') {
  for (;;) {
    const cuerpo = prefijo + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const suma = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((t, peso, i) => t + peso * Number(cuerpo[i]), 0);
    const v = 11 - (suma % 11);
    if (v === 10) continue;
    return `${cuerpo.slice(0, 2)}-${cuerpo.slice(2)}-${v === 11 ? 0 : v}`;
  }
}
const CLIENTE = {
  nombre: 'Seguimiento QA', cuit: cuitAlAzar(), telefono: '11 5555-7777',
  email: `seguimiento.${sello}@prueba.test`, provincia: 'Córdoba', ciudad: 'Río Cuarto',
  codigoPostal: '5800', direccion: 'Sobremonte 340', entreCalles: '',
  formaEnvio: 'Andreani a sucursal',
};

/** Un pedido nuevo del cliente de prueba, para no pisar los de nadie. */
async function pedidoNuevo(producto, cantidades, como = 'cliente') {
  const r = await pedir('/api/pedidos', {
    metodo: 'POST', como,
    cuerpo: { cliente: CLIENTE, carrito: [{ skuAgrupador: producto.sku, curvas: 0, cantidades }] },
  });
  if (r.status !== 201) throw new Error(`no se pudo crear el pedido de prueba: ${r.json?.message}`);
  return r.json.numero;
}

const mover = (numero, estado, nota) => pedir(
  `/api/admin/pedidos/${numero}/estado`, { metodo: 'PUT', como: 'admin', cuerpo: { estado, nota } },
);

(async () => {
  tit('0. LAS DOS PUERTAS');
  const cuenta = await pedir('/api/cuenta', {
    metodo: 'POST', como: 'cliente', cuerpo: { ...CLIENTE, password: 'seguimiento-qa-1' },
  });
  chk('se crea la cuenta de prueba', 201, cuenta.status);

  // El limitador del login deja un intento por segundo: se espera para no medirlo a él.
  await new Promise((r) => setTimeout(r, 1100));
  const entra = await pedir('/api/sesion', {
    metodo: 'POST', como: 'admin', cuerpo: { email: EMAIL_ADMIN, password: CLAVE_ADMIN },
  });
  chk('entra el administrador', 'admin', entra.json?.rol);

  const cat = await pedir('/api/catalogo');
  const producto = cat.json.productos.find((p) => p.combinaciones.length > 4);
  chk('hay un producto con grilla para trabajar', true, Boolean(producto));
  const [a, b, c] = producto.combinaciones;

  tit('1. EL PEDIDO NUEVO ESPERA LA CONFIRMACIÓN DEL STOCK');
  /*
   * Un pedido ya no se da por confirmado al entrar: ISUWAYA revisa primero que
   * tenga todo el stock. La línea de tiempo arranca en ese paso, con la fecha en
   * que entró el pedido.
   */
  const numero = await pedidoNuevo(producto, { [a.sku]: 4, [b.sku]: 2 });
  const recien = await pedir(`/api/admin/pedidos/${numero}`, { como: 'admin' });
  chk('entra esperando que se confirme el stock', 'pendiente', recien.json.pedido.estado);
  chk('la línea de tiempo arranca con un paso', 1, recien.json.pedido.historial.length);
  chk('y ese paso es la recepción', 'pendiente', recien.json.pedido.historial[0].estado);
  chk('con la fecha en que entró el pedido',
    recien.json.pedido.creado_en, recien.json.pedido.historial[0].fecha);
  chk('todavía no hay nada guardado del pedido original', null, recien.json.pedido.original);

  tit('2. LOS PASOS QUE NO EXISTEN LOS RECHAZA EL SERVIDOR');
  /*
   * La prueba que justifica tener una máquina de estados y no un `<select>`
   * con cinco opciones. Esconder el botón alcanza para que nadie se equivoque
   * de clic; no alcanza para que un pedido entregado no vuelva a confirmado
   * desde la consola del navegador, que es donde queda el historial mintiendo.
   */
  chk('sin confirmar el stock no salta directo a entregado', 409, (await mover(numero, 'entregado')).status);
  chk('un estado inventado no entra', 400, (await mover(numero, 'volando')).status);
  chk('a modificado no se llega eligiéndolo', 409, (await mover(numero, 'modificado')).status);
  chk('y no se puede quedar en el que ya está', 409, (await mover(numero, 'pendiente')).status);

  const sinSesion = await pedir(`/api/admin/pedidos/${numero}/estado`, {
    metodo: 'PUT', cuerpo: { estado: 'enviado' },
  });
  chk('sin ser administrador no se mueve nada', 401, sinSesion.status);

  tit('3. MODIFICAR: EL TOTAL LO CALCULA EL SERVIDOR');
  /*
   * La regla dura del proyecto, otra vez y ahora del lado del panel. Se manda
   * basura a propósito en `total` y `subtotal`: el servidor tiene que
   * valorizar con los precios del catálogo y no mirar nada de eso.
   */
  const editor = await pedir(`/api/admin/pedidos/${numero}/editor`, { como: 'admin' });
  chk('el editor traduce lo pedido a SKU con su cantidad', 4,
    editor.json.lineas[0].combinaciones.find((x) => x.sku === a.sku)?.cantidad);
  chk('y ofrece la grilla entera, no sólo lo pedido', true,
    editor.json.lineas[0].combinaciones.length >= producto.combinaciones.length);

  const mentira = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: {
      carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 3 } }],
      total: 1, subtotal: 1, unidades: 999,
      nota: 'No había el segundo color.',
    },
  });
  chk('se modifica', 200, mentira.status);
  chk('el total es el del catálogo, no el que mandó el navegador',
    Math.round(a.precio * 3), mentira.json.pedido.total);
  chk('las unidades también las cuenta el servidor', 3, mentira.json.pedido.unidades);
  chk('y el pedido queda modificado', 'modificado', mentira.json.pedido.estado);

  tit('4. QUEDA EL DETALLE ANTERIOR Y QUÉ CAMBIÓ');
  const trasModificar = mentira.json.pedido;
  chk('se guardó el pedido original', Math.round(a.precio * 4 + b.precio * 2), trasModificar.original.total);
  chk('con sus unidades', 6, trasModificar.original.unidades);
  chk('y con su detalle entero', true, Array.isArray(trasModificar.original.items));

  const paso = trasModificar.historial.at(-1);
  chk('el último paso del historial es la modificación', 'modificado', paso.estado);
  chk('con la nota que ve el cliente', 'No había el segundo color.', paso.nota);
  chk('y con el antes y después del total',
    [Math.round(a.precio * 4 + b.precio * 2), Math.round(a.precio * 3)],
    [paso.cambios.totalAntes, paso.cambios.totalDespues]);
  chk('el detalle dice qué cruce cambió', true,
    paso.cambios.lineas.some((l) => l.talle === a.talle && l.antes === 4 && l.despues === 3));
  chk('y cuál se sacó', true,
    paso.cambios.lineas.some((l) => l.talle === b.talle && l.despues === 0));

  tit('5. EL PRECIO ACORDADO ENTRA COMO INSTRUCCIÓN, NO COMO RESULTADO');
  const conDescuento = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: {
      carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 3, [c.sku]: 2 } }],
      ajuste: { tipo: 'porcentaje', valor: -10, motivo: 'Arreglamos por el faltante' },
    },
  });
  const base = Math.round(a.precio * 3 + c.precio * 2);
  chk('el descuento lo aplica el servidor sobre su propia suma',
    Math.round(base * 0.9), conDescuento.json.pedido.total);
  chk('y queda escrito cuánto fue', Math.round(base * 0.9) - base, conDescuento.json.pedido.ajuste.importe);
  chk('con el motivo', 'Arreglamos por el faltante', conDescuento.json.pedido.ajuste.motivo);

  const imposible = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: {
      carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 1 } }],
      ajuste: { tipo: 'monto', valor: -99999999 },
    },
  });
  chk('un descuento que deja el pedido en negativo se rechaza', 400, imposible.status);

  const porcentajeAbsurdo = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: {
      carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 1 } }],
      ajuste: { tipo: 'porcentaje', valor: -900 },
    },
  });
  chk('un porcentaje fuera de escala también', 400, porcentajeAbsurdo.status);

  const vacio = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin', cuerpo: { carrito: [] },
  });
  chk('un pedido modificado no puede quedar vacío', 400, vacio.status);

  tit('6. LO QUE SALIÓ DEL DEPÓSITO YA NO SE TOCA');
  chk('se puede enviar', 200, (await mover(numero, 'enviado', 'Salió por Andreani.')).status);
  const editarEnviado = await pedir(`/api/admin/pedidos/${numero}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: { carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 99 } }] },
  });
  chk('pero un pedido enviado ya no se edita', 409, editarEnviado.status);
  chk('y no se puede volver a confirmado', 409, (await mover(numero, 'confirmado')).status);

  chk('se puede entregar', 200, (await mover(numero, 'entregado', 'Firmado en destino.')).status);
  chk('un pedido entregado no se cancela', 409, (await mover(numero, 'cancelado')).status);
  chk('ni se manda de nuevo', 409, (await mover(numero, 'enviado')).status);

  const entregado = (await pedir(`/api/admin/pedidos/${numero}`, { como: 'admin' })).json.pedido;
  chk('la línea de tiempo guardó los cinco pasos', 5, entregado.historial.length);
  chk('en orden', ['pendiente', 'modificado', 'modificado', 'enviado', 'entregado'],
    entregado.historial.map((h) => h.estado));
  chk('y cada uno con su fecha', true, entregado.historial.every((h) => !Number.isNaN(Date.parse(h.fecha))));

  tit('7. CANCELAR SE PUEDE HASTA ANTES DE ENTREGAR');
  const paraCancelar = await pedidoNuevo(producto, { [a.sku]: 1 });
  chk('un pedido esperando stock se cancela', 200, (await mover(paraCancelar, 'cancelado', 'Lo dio de baja.')).status);
  chk('pero después ya no se mueve', 409, (await mover(paraCancelar, 'enviado')).status);
  const editarCancelado = await pedir(`/api/admin/pedidos/${paraCancelar}/items`, {
    metodo: 'PUT', como: 'admin',
    cuerpo: { carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 5 } }] },
  });
  chk('ni se edita', 409, editarCancelado.status);

  tit('7b. EL CIRCUITO DE COMPRA: CONFIRMAR EL STOCK Y AVISAR');
  {
    /*
     * El pedido entra esperando stock. Al negocio le llega con los dos papeles
     * y al cliente una copia que avisa que falta confirmar. Cuando el panel lo
     * confirma, lo rearma o lo cancela, el cliente se entera por mail.
     *
     * Necesita el correo de prueba (pruebas/correo-de-prueba.cjs): CORREOS es la
     * carpeta donde guarda los mails y PEDIDOS_EMAIL el correo del negocio, los
     * dos iguales a los del servidor.
     */
    const CORREOS = process.env.CORREOS;
    const NEGOCIO = process.env.PEDIDOS_EMAIL;
    if (!CORREOS || !NEGOCIO) {
      console.log('  (sin CORREOS y PEDIDOS_EMAIL: se saltean las pruebas de los avisos por mail)');
    } else {
      const fs = require('node:fs');
      const path = require('node:path');
      const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
      // El cuerpo viaja en quoted-printable y el asunto en encoded-word: se decodifican para leerlos.
      const qp = (t) => Buffer.from(t.replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
      const asuntoDe = (crudo) => {
        const m = crudo.match(/^Subject: (.*(?:\r\n[ \t].*)*)/m);
        if (!m) return '';
        return m[1].replace(/\r\n[ \t]/g, ' ').replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, tipo, x) => (tipo.toUpperCase() === 'B'
          ? Buffer.from(x, 'base64').toString('utf8')
          : Buffer.from(x.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))).trim();
      };
      const leidos = new Set(fs.readdirSync(CORREOS));
      const nuevos = async (cuantos) => {
        for (let i = 0; i < 50 && fs.readdirSync(CORREOS).filter((x) => !leidos.has(x)).length < cuantos; i += 1) await esperar(100);
        const archivos = fs.readdirSync(CORREOS).filter((x) => !leidos.has(x)).sort();
        archivos.forEach((x) => leidos.add(x));
        return archivos.map((x) => JSON.parse(fs.readFileSync(path.join(CORREOS, x), 'utf8'))).map((m) => ({
          para: m.para, crudo: m.crudo, texto: qp(m.crudo), asunto: asuntoDe(m.crudo),
          adjuntos: [...m.crudo.matchAll(/filename="?([^"\r\n;]+)/g)].map((x) => x[1]).filter((v, i, a) => a.indexOf(v) === i),
        }));
      };

      const numeroCircuito = await pedidoNuevo(producto, { [a.sku]: 2 });
      const alEntrar = await nuevos(2);
      const alNegocio = alEntrar.find((m) => m.para.includes(NEGOCIO));
      const alCliente = alEntrar.find((m) => m.para.includes(CLIENTE.email));
      chk('al negocio le llega el pedido nuevo', true, Boolean(alNegocio));
      chk('con el remito y el rótulo', [`${numeroCircuito}-pedido.pdf`, `${numeroCircuito}-rotulo.pdf`], alNegocio?.adjuntos);
      chk('y le avisa que falta confirmar el stock', true, /esperando confirmación de stock/i.test(alNegocio?.texto || ''));
      chk('al cliente le llega la copia', `Recibimos tu pedido ${numeroCircuito}`, alCliente?.asunto);
      chk('sólo con el remito: el rótulo es del depósito', [`${numeroCircuito}-pedido.pdf`], alCliente?.adjuntos);
      chk('le dice que todavía falta confirmar el stock', true, /revisamos que tengamos todo el stock/.test(alCliente?.texto || ''));
      chk('y si responde, le escribe al negocio', true, alCliente?.crudo.includes(`Reply-To: ${NEGOCIO}`));
      chk('el panel anota que el cliente se enteró', 'ok',
        (await pedir(`/api/admin/pedidos/${numeroCircuito}`, { como: 'admin' })).json.pedido.aviso_cliente);

      const confirmar = await mover(numeroCircuito, 'confirmado', 'Está todo.');
      chk('se confirma el stock', [200, 'confirmado'], [confirmar.status, confirmar.json?.pedido?.estado]);
      chk('y el aviso al cliente sale', 'ok', confirmar.json?.avisoCliente);
      const alConfirmar = await nuevos(1);
      chk('le llega la confirmación', `Confirmamos tu pedido ${numeroCircuito}`, alConfirmar[0]?.asunto);
      chk('con el pedido y la nota del panel', [true, true],
        [alConfirmar[0]?.adjuntos.includes(`${numeroCircuito}-pedido.pdf`), /Está todo\./.test(alConfirmar[0]?.texto || '')]);
      chk('un confirmado no vuelve a esperar stock', 409, (await mover(numeroCircuito, 'pendiente')).status);

      const numeroSinStock = await pedidoNuevo(producto, { [a.sku]: 4, [b.sku]: 2 });
      await nuevos(2);
      const rearmado = await pedir(`/api/admin/pedidos/${numeroSinStock}/items`, {
        metodo: 'PUT', como: 'admin',
        cuerpo: { carrito: [{ skuAgrupador: producto.sku, cantidades: { [a.sku]: 4 } }], nota: 'No quedaba el segundo.' },
      });
      chk('sin stock de todo se rearma desde que entra', [200, 'modificado'], [rearmado.status, rearmado.json?.pedido?.estado]);
      const alRearmar = await nuevos(1);
      chk('rearmar un pedido que esperaba stock lo confirma con cambios', `Confirmamos tu pedido ${numeroSinStock}, con cambios`, alRearmar[0]?.asunto);
      chk('con el pedido rearmado y la nota', [true, true],
        [alRearmar[0]?.adjuntos.includes(`${numeroSinStock}-pedido.pdf`), /No quedaba el segundo\./.test(alRearmar[0]?.texto || '')]);

      await mover(numeroSinStock, 'cancelado', 'Nos quedamos sin stock.');
      const alCancelar = await nuevos(1);
      chk('al cancelar también se entera', `Tu pedido ${numeroSinStock} fue cancelado`, alCancelar[0]?.asunto);
      chk('sin adjunto: no hay nada que preparar', [], alCancelar[0]?.adjuntos);

      const sinMail = await pedir('/api/pedidos', {
        metodo: 'POST',
        cuerpo: { cliente: { ...CLIENTE, email: '' }, carrito: [{ skuAgrupador: producto.sku, curvas: 0, cantidades: { [a.sku]: 1 } }] },
      });
      chk('sin mail del cliente el pedido entra igual', 201, sinMail.status);
      chk('y queda dicho por qué el cliente no recibió nada', 'omitido: el cliente no dejó mail', sinMail.json?.avisos?.cliente);
      chk('al negocio le llega igual', true, (await nuevos(1)).some((m) => m.para.includes(NEGOCIO)));

      const est = (await pedir('/api/admin/estadisticas', { como: 'admin' })).json;
      chk('las estadísticas cuentan los que esperan stock', true, (est.porEstado || []).some((e) => e.estado === 'pendiente'));

      const conFaltante = await pedidoNuevo(producto, { [a.sku]: 4, [b.sku]: 2 });
      await nuevos(2);
      const revision = await pedir(`/api/admin/pedidos/${conFaltante}/confirmar-stock`, {
        metodo: 'PUT', como: 'admin', cuerpo: { disponibles: { [a.sku]: 2, [b.sku]: 0 }, nota: 'Lo que falta entra el lunes.' },
      });
      chk('la revisión de stock con faltantes avisa al cliente', 'ok', revision.json?.avisoCliente);
      const alRevisar = await nuevos(1);
      chk('le llega la confirmación con cambios', `Confirmamos tu pedido ${conFaltante}, con cambios`, alRevisar[0]?.asunto);
      chk('con el pedido como queda', true, Boolean(alRevisar[0]?.adjuntos.includes(`${conFaltante}-pedido.pdf`)));
      chk('y lo que cambió, renglón por renglón', [true, true],
        [/pediste 4, te mandamos 2/.test(alRevisar[0]?.texto || ''), /pediste 2, no hay/.test(alRevisar[0]?.texto || '')]);
      chk('con el total de antes y el de ahora', true, /Total: antes .+, ahora /.test(alRevisar[0]?.texto || ''));
      chk('y la nota', true, /Lo que falta entra el lunes\./.test(alRevisar[0]?.texto || ''));
    }
  }

  tit('7c. LA REVISIÓN DEL STOCK, RENGLÓN POR RENGLÓN');
  {
    const stock = (numero, cuerpo, como = 'admin') => pedir(`/api/admin/pedidos/${numero}/confirmar-stock`, { metodo: 'PUT', como, cuerpo });
    const completo = await pedidoNuevo(producto, { [a.sku]: 3, [b.sku]: 2 });
    chk('sin ser administrador no se revisa', 401, (await stock(completo, {}, null)).status);
    chk('un cruce que no se pidió rebota', 400, (await stock(completo, { disponibles: { [c.sku]: 1 } })).status);
    chk('más de lo pedido rebota', 400, (await stock(completo, { disponibles: { [a.sku]: 4 } })).status);
    chk('una cantidad que no es entera rebota', 400, (await stock(completo, { disponibles: { [a.sku]: 1.5 } })).status);
    chk('sin nada de nada no se confirma', 400, (await stock(completo, { disponibles: { [a.sku]: 0, [b.sku]: 0 } })).status);
    const todo = await stock(completo, { disponibles: { [a.sku]: 3, [b.sku]: 2 } });
    chk('con todo, queda confirmado tal cual', [200, 'confirmado', false], [todo.status, todo.json?.pedido?.estado, todo.json?.conCambios]);
    chk('sin tocar el total', Math.round(a.precio * 3 + b.precio * 2), todo.json?.pedido?.total);
    chk('y sin guardar un "original": no cambió nada', null, todo.json?.pedido?.original);
    chk('un pedido ya confirmado no se vuelve a revisar', 409, (await stock(completo, { disponibles: {} })).status);

    const parcial = await pedidoNuevo(producto, { [a.sku]: 4, [b.sku]: 2 });
    const r = await stock(parcial, { disponibles: { [a.sku]: 2, [b.sku]: 0 }, nota: 'El resto entra el lunes.' });
    chk('si falta algo, se confirma con los cambios', [200, 'modificado', true], [r.status, r.json?.pedido?.estado, r.json?.conCambios]);
    chk('el total lo recalcula el servidor con lo que hay', Math.round(a.precio * 2), r.json?.pedido?.total);
    chk('se guarda lo que había pedido', Math.round(a.precio * 4 + b.precio * 2), r.json?.pedido?.original?.total);
    chk('y queda dicho qué cambió', [true, true], [
      Boolean(r.json?.cambios?.lineas?.some((l) => l.color === a.color && l.talle === a.talle && l.antes === 4 && l.despues === 2)),
      Boolean(r.json?.cambios?.lineas?.some((l) => l.color === b.color && l.talle === b.talle && l.despues === 0)),
    ]);
    chk('con la nota en la línea de tiempo', 'El resto entra el lunes.', r.json?.pedido?.historial?.at(-1)?.nota);
    chk('la lista de pedidos dice cuántos esperan stock', 'number', typeof (await pedir('/api/admin/pedidos', { como: 'admin' })).json?.pendientes);
  }

  tit('7d. CADA COMPRA QUEDA EN CLIENTES, POR CUIT');
  {
    const cuit = cuitAlAzar('30');
    const soloNumeros = cuit.replace(/\D/g, '');
    const email = `reservado.${sello}@prueba.test`;
    const datosReservado = { ...CLIENTE, cuit, email, nombre: 'Reservado QA', telefono: '351 555-9876' };
    const carrito = [{ skuAgrupador: producto.sku, curvas: 0, cantidades: { [a.sku]: 1 } }];
    const comprar = (cliente) => pedir('/api/pedidos', { metodo: 'POST', cuerpo: { cliente, carrito } });
    const porCuit = (valor) => pedir('/api/clientes/por-cuit', { metodo: 'POST', cuerpo: { cuit: valor } });
    const deEste = async () => (await pedir('/api/admin/clientes', { como: 'admin' })).json.clientes
      .filter((x) => x.cuit.replace(/\D/g, '') === soloNumeros);

    chk('un CUIT que nunca compró no trae nada', { encontrado: false }, (await porCuit(cuit)).json);
    chk('un CUIT inválido rebota', 400, (await porCuit('20-11111111-1')).status);

    chk('la primera compra sin cuenta entra', 201, (await comprar(datosReservado)).status);
    let registro = await deEste();
    chk('y deja al cliente registrado, sin cuenta', [1, false, 1], [registro.length, registro[0]?.tieneCuenta, registro[0]?.pedidos]);

    chk('la segunda, con el CUIT escrito sin guiones y a otro lugar', 201, (await comprar({
      ...datosReservado, cuit: soloNumeros, direccion: 'Belgrano 900', ciudad: 'Córdoba', codigoPostal: '5000', formaEnvio: 'Vía Cargo',
    })).status);
    registro = await deEste();
    chk('suma al mismo cliente, no crea otro', [1, 2], [registro.length, registro[0]?.pedidos]);
    chk('la ficha junta los dos lugares a los que mandó', 2,
      (await pedir(`/api/admin/clientes/${registro[0].id}`, { como: 'admin' })).json.direcciones?.length);

    const busqueda = (await porCuit(cuit)).json;
    chk('al escribir el CUIT vuelve el nombre', [true, 'Reservado QA'], [busqueda.encontrado, busqueda.nombre]);
    chk('el teléfono vuelve tapado', [true, false], [Boolean(busqueda.telefono?.endsWith('9876')), Boolean(busqueda.telefono?.includes('555'))]);
    chk('y el email también', [true, false], [Boolean(busqueda.email?.includes('•')), busqueda.email === email]);

    const tapado = { ...datosReservado, direccion: 'Colón 1', telefono: busqueda.telefono, email: busqueda.email };
    const previa = await pedir('/api/pedidos/previsualizar', { metodo: 'POST', cuerpo: { cliente: tapado, carrito } });
    chk('dejando los datos tapados, el resumen no los destapa', [undefined, busqueda.telefono, busqueda.email],
      [previa.json?.erroresCliente?.telefono, previa.json?.cliente?.telefono, previa.json?.cliente?.email]);
    const conTapados = await comprar(tapado);
    chk('y el pedido entra', 201, conTapados.status);
    const guardado = (await pedir(`/api/admin/pedidos/${conTapados.json?.numero}`, { como: 'admin' })).json?.pedido;
    chk('con los datos reales guardados', ['351 555-9876', email], [guardado?.cliente?.telefono, guardado?.cliente?.email]);
    const conOtroCuit = await pedir('/api/pedidos/previsualizar', { metodo: 'POST', cuerpo: { cliente: { ...tapado, cuit: cuitAlAzar('27') }, carrito } });
    chk('lo tapado con otro CUIT no pasa', true, Boolean(conOtroCuit.json?.erroresCliente?.telefono));

    const ajeno = await comprar({ ...datosReservado, email: `otro.${sello}@prueba.test`, telefono: '11 4444-0000' });
    chk('otra persona compra con ese CUIT y otro email', 201, ajeno.status);

    await new Promise((listo) => setTimeout(listo, 1100));
    chk('con el email de un cliente sin cuenta no se entra', 401,
      (await pedir('/api/sesion', { metodo: 'POST', cuerpo: { email: `otro.${sello}@prueba.test`, password: 'cualquier-cosa-123' } })).status);

    cookies.reservado = '';
    const nueva = await pedir('/api/cuenta', { metodo: 'POST', como: 'reservado', cuerpo: { ...datosReservado, password: 'reservado-qa-123' } });
    chk('crear la cuenta con ese CUIT', 201, nueva.status);
    registro = await deEste();
    chk('ocupa el mismo lugar y conserva las compras', [1, true, 4], [registro.length, registro[0]?.tieneCuenta, registro[0]?.pedidos]);
    const mios = ((await pedir('/api/cuenta/pedidos', { como: 'reservado' })).json?.pedidos || []).map((x) => x.numero);
    chk('en «Mis pedidos» ve las compras que dejaron su email', 3, mios.length);
    chk('y no la que otro hizo con su CUIT', false, mios.includes(ajeno.json?.numero));
    chk('tampoco la abre por número', 404, (await pedir(`/api/cuenta/pedidos/${ajeno.json?.numero}`, { como: 'reservado' })).status);
    chk('otra cuenta con el mismo CUIT no se crea', 409, (await pedir('/api/cuenta', {
      metodo: 'POST', cuerpo: { ...datosReservado, email: `duplicada.${sello}@prueba.test`, password: 'otra-clave-123' },
    })).status);

    const id = registro[0].id;
    chk('el panel corrige un teléfono', 200,
      (await pedir(`/api/admin/clientes/${id}`, { metodo: 'PUT', como: 'admin', cuerpo: { telefono: '351 555-0000' } })).status);
    chk('pero no el email de una cuenta', 400,
      (await pedir(`/api/admin/clientes/${id}`, { metodo: 'PUT', como: 'admin', cuerpo: { email: 'x@y.zz' } })).status);
    chk('la ficha de un cliente pide administrador', 401, (await pedir(`/api/admin/clientes/${id}`)).status);
  }

  tit('8. EL CLIENTE VE LO SUYO Y NADA MÁS');
  const mios = await pedir('/api/cuenta/pedidos', { como: 'cliente' });
  chk('la lista responde', 200, mios.status);
  chk('trae los pedidos de esta cuenta', true, mios.json.pedidos.some((p) => p.numero === numero));
  const enLista = mios.json.pedidos.find((p) => p.numero === numero);
  chk('con el estado en castellano y no el de la base', 'entregado', enLista.estado);
  chk('con la línea de tiempo adentro', 5, enLista.historial.length);
  chk('y marcado como modificado, para avisarle', true, enLista.fueModificado);

  const detalle = await pedir(`/api/cuenta/pedidos/${numero}`, { como: 'cliente' });
  chk('el detalle de un pedido propio se ve', 200, detalle.status);
  chk('con lo que va a salir', true, Array.isArray(detalle.json.pedido.items));
  chk('y con lo que había pedido', true, Boolean(detalle.json.pedido.original));
  chk('las notas del panel llegan al cliente', true,
    detalle.json.pedido.historial.some((h) => h.nota === 'Salió por Andreani.'));

  /*
   * Los números son correlativos: sin la comprobación de dueño, ISU-000001 en
   * la barra de direcciones muestra el pedido de otro con su detalle.
   */
  const ajeno = await pedir('/api/cuenta/pedidos/ISU-000001', { como: 'cliente' });
  chk('el pedido de otro contesta 404', 404, ajeno.status);
  const inexistente = await pedir('/api/cuenta/pedidos/ISU-999999', { como: 'cliente' });
  chk('y uno que no existe contesta lo mismo', ajeno.status, inexistente.status);
  chk('sin sesión no se ve ninguno', 401, (await pedir(`/api/cuenta/pedidos/${numero}`)).status);

  tit('9. LOS PEDIDOS VIEJOS SE LEEN COMO LOS NUEVOS');
  /*
   * La base de producción tiene pedidos en 'nuevo' y 'preparando', de antes de
   * que esto fuera un seguimiento. Ninguna pantalla puede mostrar esas
   * palabras, y el filtro más usado del panel —"confirmado"— tiene que
   * traerlos igual: si no, devuelve vacío sobre datos que están ahí.
   */
  const todos = await pedir('/api/admin/pedidos?limite=1000', { como: 'admin' });
  const CONOCIDOS = ['pendiente', 'confirmado', 'modificado', 'enviado', 'entregado', 'cancelado'];
  chk('ningún pedido se sirve con un estado de los viejos', [],
    [...new Set(todos.json.pedidos.map((p) => p.estado))].filter((e) => !CONOCIDOS.includes(e)));

  const filtrados = await pedir('/api/admin/pedidos?estado=confirmado&limite=1000', { como: 'admin' });
  chk('filtrar por confirmado no devuelve otra cosa', true,
    filtrados.json.pedidos.every((p) => p.estado === 'confirmado'));
  chk('y alcanza a los viejos', true, filtrados.json.pedidos.length > 0);

  tit('9b. SUMAR UN PRODUCTO AL PEDIDO QUE SE REARMA');
  /*
   * El editor ofrece sumar un producto que el cliente no había pedido —el
   * caso de todos los días: no había negro y se manda azul—, y para eso pide
   * la grilla del producto suelto. Esta ruta no tenía prueba: si se rompía, la
   * pantalla se quedaba sin poder agregar y nada lo marcaba.
   */
  const paraSumar = (await pedir('/api/catalogo')).json.productos[0];
  const grilla = await pedir(`/api/admin/grilla/${encodeURIComponent(paraSumar.sku)}`, { como: 'admin' });
  chk('la grilla de un producto suelto responde', 200, grilla.status);
  chk('con sus cruces y el SKU de cada uno', true,
    (grilla.json?.linea?.combinaciones || []).length > 0
      && grilla.json.linea.combinaciones.every((c) => c.sku));
  chk('y todo en cero: sumarlo no agrega nada hasta que se cargue', true,
    grilla.json?.linea?.combinaciones?.every((c) => c.cantidad === 0));
  chk('un producto que no existe da 404', 404,
    (await pedir('/api/admin/grilla/NO-EXISTE-123', { como: 'admin' })).status);
  chk('y sin sesión de administrador no se ve', true,
    [401, 403].includes((await pedir(`/api/admin/grilla/${encodeURIComponent(paraSumar.sku)}`)).status));

  tit('9c. LOS COLORES DE UN PRODUCTO SE CORRIGEN ENTEROS');
  {   // en su propio bloque: sus nombres no chocan con los del resto de la suite
    /*
     * Un color mal cargado se corrige con todos sus talles de una vez, y la
     * corrección tiene que sobrevivir a la próxima importación de la planilla:
     * STOCKER sigue diciendo lo que decía. Cambia la base de datos: correr contra
     * una copia.
     */
    const API9 = process.env.API || 'http://localhost:8090';
    const reimportar = async () => {
      const fd = new FormData();
      fd.append('planilla', new Blob([require('node:fs').readFileSync(require('node:path').join(__dirname, 'catalogo-isuwaya.xlsx'))]), 'catalogo.xlsx');
      return (await fetch(`${API9}/api/admin/importar`, { method: 'POST', headers: { Cookie: cookies.admin }, body: fd })).status;
    };
    const catalogoDe = async (sku) => (await pedir('/api/catalogo')).json.productos.find((x) => x.sku === sku);
    const cuantosColores = (x) => new Set(x.combinaciones.map((c) => c.color)).size;
    const elProducto = (await pedir('/api/catalogo')).json.productos.reduce((a, b) => (cuantosColores(b) > cuantosColores(a) ? b : a));
    const rutaProd = `/api/admin/productos/${encodeURIComponent(elProducto.sku)}`;
    const det9 = (await pedir(rutaProd, { como: 'admin' })).json;
    const paleta = (await pedir('/api/admin/colores', { como: 'admin' })).json.colores;
    const suyos = new Set(det9.colores.map((c) => c.id));
    const ajeno = paleta.find((c) => !suyos.has(c.id));
    const origen = det9.colores.find((c) => det9.fotos.some((f) => f.color_id === c.id)) || det9.colores[0];
    const tallesOrigen = det9.variantes.filter((v) => v.color_id === origen.id).length;
    const fotosOrigen = det9.fotos.filter((f) => f.color_id === origen.id).length;
    const de = (prod, nombre) => prod.combinaciones.filter((c) => c.color === nombre).length;

    const cambio = await pedir(`${rutaProd}/colores/${origen.id}`, { metodo: 'PUT', cuerpo: { nuevoColorId: ajeno.id }, como: 'admin' });
    chk('cambiar un color responde', 200, cambio.status);
    chk('y se lleva todos sus talles', tallesOrigen, cambio.json?.variantes);
    const cambiado = await catalogoDe(elProducto.sku);
    chk('el cliente ya no ve el color viejo', 0, de(cambiado, origen.nombre));
    chk('y ve el nuevo en los mismos talles', tallesOrigen, de(cambiado, ajeno.nombre));
    chk('las fotos del color van con él', Math.min(fotosOrigen, 5), (cambiado.fotos || []).filter((f) => f.color === ajeno.nombre).length);

    const [uno, otro] = det9.colores.filter((c) => c.id !== origen.id);
    const choque = await pedir(`${rutaProd}/colores/${uno.id}`, { metodo: 'PUT', cuerpo: { nuevoColorId: otro.id }, como: 'admin' });
    chk('pasar un color a otro que ya tiene esos talles rebota', 409, choque.status);

    chk('se vuelve a importar la planilla', 200, await reimportar());
    const trasImportar = await catalogoDe(elProducto.sku);
    chk('y el color corregido a mano sigue corregido', [0, tallesOrigen], [de(trasImportar, origen.nombre), de(trasImportar, ajeno.nombre)]);

    const generalesAntes = (trasImportar.fotos || []).filter((f) => !f.color).length;
    const quitar = await pedir(`${rutaProd}/colores/${ajeno.id}`, { metodo: 'DELETE', como: 'admin' });
    chk('quitar un color responde', 200, quitar.status);
    chk('y se lleva todas sus variantes', tallesOrigen, quitar.json?.variantes);
    const sinEl = await catalogoDe(elProducto.sku);
    chk('el cliente ya no lo ve', 0, de(sinEl, ajeno.nombre));
    chk('y sus fotos pasan a generales, no se pierden', Math.min(fotosOrigen, 5), (sinEl.fotos || []).filter((f) => !f.color).length - generalesAntes);
    chk('se vuelve a importar', 200, await reimportar());
    const trasOtra = await catalogoDe(elProducto.sku);
    chk('y lo quitado a mano no vuelve con la planilla', [0, 0], [de(trasOtra, origen.nombre), de(trasOtra, ajeno.nombre)]);

    const agregar = await pedir(`${rutaProd}/colores`, { metodo: 'POST', cuerpo: { colorId: origen.id }, como: 'admin' });
    chk('agregar un color responde', 201, agregar.status);
    const conNuevo = await catalogoDe(elProducto.sku);
    const tallesDelProducto = new Set(conNuevo.combinaciones.map((c) => c.talle)).size;
    chk('aparece en todos los talles del producto', tallesDelProducto, de(conNuevo, origen.nombre));
    chk('con el precio que cada talle ya tenía', true, conNuevo.combinaciones.filter((c) => c.color === origen.nombre)
      .every((c) => conNuevo.combinaciones.some((o) => o.color !== origen.nombre && o.talle === c.talle && o.precio === c.precio)));
    chk('agregar un color que ya está rebota', 409,
      (await pedir(`${rutaProd}/colores`, { metodo: 'POST', cuerpo: { colorId: origen.id }, como: 'admin' })).status);
    chk('otra importación más', 200, await reimportar());
    chk('y lo agregado a mano sigue ahí', tallesDelProducto, de(await catalogoDe(elProducto.sku), origen.nombre));

    const deUnColor = (await pedir('/api/catalogo')).json.productos.find((x) => cuantosColores(x) === 1);
    if (deUnColor) {
      const detUno = (await pedir(`/api/admin/productos/${encodeURIComponent(deUnColor.sku)}`, { como: 'admin' })).json;
      chk('el único color de un producto no se quita', 409,
        (await pedir(`/api/admin/productos/${encodeURIComponent(deUnColor.sku)}/colores/${detUno.colores[0].id}`, { metodo: 'DELETE', como: 'admin' })).status);
    }
  }

  tit('9d. LOS AVISOS SE VEN DESDE EL PANEL');
  {
    /*
     * La solapa "Avisos" dice si el mail está configurado y cómo está el
     * WhatsApp del grupo. Acá no se vincula nada de verdad —eso necesita un
     * teléfono que escanee el QR—: se prueba que las rutas pidan administrador
     * y que, sin WhatsApp conectado, lo que depende de él se rechace con motivo.
     */
    chk('sin ser administrador no se ven', 401, (await pedir('/api/admin/avisos')).status);
    const avisos = await pedir('/api/admin/avisos', { como: 'admin' });
    chk('responde', 200, avisos.status);
    chk('dice si el mail está configurado', 'boolean', typeof avisos.json?.mail?.configurado);
    chk('y cómo está el WhatsApp', 'string', typeof avisos.json?.whatsapp?.conexion);
    chk('el QR sólo viaja mientras se está vinculando', true,
      avisos.json?.whatsapp?.conexion === 'esperando-qr' || avisos.json?.whatsapp?.qr === null);
    if (avisos.json?.whatsapp?.conexion !== 'conectado') {
      const grupo = await pedir('/api/admin/whatsapp/grupo', { metodo: 'PUT', como: 'admin', cuerpo: { id: 'inventado@g.us' } });
      chk('sin WhatsApp conectado no se elige grupo', 409, grupo.status);
      chk('y dice por qué', true, /no está conectado/i.test(grupo.json?.message || ''));
      chk('tampoco se manda la prueba', 409, (await pedir('/api/admin/whatsapp/prueba', { metodo: 'POST', como: 'admin' })).status);
    }
    chk('vincular pide administrador', 401, (await pedir('/api/admin/whatsapp/vincular', { metodo: 'POST' })).status);
    chk('desvincular también', 401, (await pedir('/api/admin/whatsapp/desvincular', { metodo: 'POST' })).status);
  }

  tit('10. LAS ESTADÍSTICAS CIERRAN');
  const est = (await pedir('/api/admin/estadisticas', { como: 'admin' })).json;
  chk('responde con período', true, Boolean(est.periodo?.desde && est.periodo?.hasta));

  const porEstado = Object.fromEntries(est.porEstado.map((e) => [e.estado, e]));
  const vivos = est.porEstado.filter((e) => e.estado !== 'cancelado');
  chk('los pedidos del resumen son los no cancelados',
    vivos.reduce((t, e) => t + e.pedidos, 0), est.resumen.pedidos);
  chk('lo facturado es la suma de los no cancelados',
    vivos.reduce((t, e) => t + e.importe, 0), est.resumen.facturado);
  /*
   * Acá no hay estados de pago: "cobrado" es lo entregado, que es lo único que
   * el sistema sabe con certeza. Si algún día se lleva el pago aparte, esta
   * prueba es la que avisa que la cuenta cambió de significado.
   */
  chk('lo cobrado es exactamente lo entregado', porEstado.entregado.importe, est.resumen.cobrado);
  chk('y lo que falta cobrar es el resto', est.resumen.facturado - est.resumen.cobrado, est.resumen.porCobrar);
  chk('el ticket promedio es facturado sobre pedidos',
    Math.round(est.resumen.facturado / est.resumen.pedidos), est.resumen.ticket);

  chk('la evolución viene ordenada en el tiempo', true,
    est.evolucion.puntos.every((p, i, todos) => i === 0 || todos[i - 1].clave <= p.clave));
  chk('y suma lo mismo que el resumen',
    est.resumen.facturado, est.evolucion.puntos.reduce((t, p) => t + p.importe, 0));

  chk('hay ranking de productos', true, est.ranking.productos.length > 0);
  chk('ordenado por plata', true,
    est.ranking.productos.every((p, i, t) => i === 0 || t[i - 1].importe >= p.importe));
  chk('de colores, en unidades', true,
    est.ranking.colores.length > 0 && est.ranking.colores.every((c) => c.unidades > 0));
  chk('de talles también', true, est.ranking.talles.length > 0);
  chk('y de categorías, con plata', true, est.ranking.categorias.every((c) => 'importe' in c));

  const futuro = await pedir('/api/admin/estadisticas?desde=2099-01-01', { como: 'admin' });
  chk('un período sin pedidos da cero y no rompe', 0, futuro.json.resumen.pedidos);
  chk('sin dividir por cero en el ticket', 0, futuro.json.resumen.ticket);

  chk('las estadísticas piden sesión', 401, (await pedir('/api/admin/estadisticas')).status);

  tit('11. CUÁNTOS PIDEN Y NO HAY');
  const f = est.faltantes;
  chk('cuenta los cruces posibles de la grilla', true, f.crucesPosibles > 0);
  chk('y cuántos no existen', true, f.crucesQueFaltan >= 0 && f.crucesQueFaltan <= f.crucesPosibles);
  chk('los productos con huecos vienen ordenados por demanda vecina', true,
    f.productos.every((p, i, t) => i === 0 || t[i - 1].vecina >= p.vecina));
  chk('y ninguno aparece con la grilla completa', true, f.productos.every((p) => p.faltan > 0));

  /*
   * El registro de intentos es un endpoint abierto: cualquiera puede llamarlo.
   * Por eso se comprueba contra el catálogo antes de anotar — si no, la
   * estadística que dice qué producir la escribe quien quiera.
   */
  const conHuecos = f.productos[0];
  if (conHuecos) {
    const hueco = conHuecos.huecos[0];
    const anotado = await pedir('/api/faltantes', {
      metodo: 'POST', cuerpo: { sku: conHuecos.sku, color: hueco.color, talle: hueco.talle },
    });
    chk('un cruce que no existe se anota', true, anotado.json.registrado);
  }

  const existente = await pedir('/api/faltantes', {
    metodo: 'POST', cuerpo: { sku: producto.sku, color: a.color, talle: a.talle },
  });
  chk('un cruce que SÍ existe no se anota', false, existente.json.registrado);
  const inventado = await pedir('/api/faltantes', {
    metodo: 'POST', cuerpo: { sku: 'NO-EXISTE', color: 'Fucsia', talle: 'M' },
  });
  chk('un producto inventado tampoco', false, inventado.json.registrado);
  const sinNada = await pedir('/api/faltantes', { metodo: 'POST', cuerpo: {} });
  chk('y un cuerpo vacío no rompe nada', 200, sinNada.status);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
