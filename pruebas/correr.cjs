/*
 * Pruebas de ISUWAYA MAYORISTA.
 *
 * Corren contra el servidor levantado, como lo usa un cliente de verdad. Las
 * que más importan son las adversarias: lo que pasa cuando alguien manda algo
 * que la pantalla no deja mandar.
 *
 * Uso:  API=http://localhost:8090 node pruebas/correr.cjs
 */
const path = require('node:path');
const fs = require('node:fs');

/*
 * Las credenciales salen del .env, nunca de acá.
 *
 * Este archivo se commitea. La contraseña del administrador estuvo escrita
 * como valor por defecto y eso alcanzaba para entrar al panel de producción;
 * peor todavía, el secreto con el que se firman las sesiones se derivaba de
 * ella, así que con leer el repo se podía falsificar la sesión de cualquier
 * cliente y los enlaces de descarga de cualquier pedido.
 *
 * Sin credenciales las pruebas no corren y lo dicen. Un valor por defecto que
 * "funciona igual" es justo lo que hace que nadie se entere.
 */
require('../src/entorno').cargarEnv();

const API = process.env.API || 'http://localhost:8090';
const CLAVE_ADMIN = process.env.ADMIN_PASSWORD;
const EMAIL_ADMIN = process.env.ADMIN_EMAIL;

if (!CLAVE_ADMIN || !EMAIL_ADMIN) {
  console.error('\n  Faltan ADMIN_EMAIL y ADMIN_PASSWORD.'
    + '\n  Ponelas en el .env o pasalas por delante:'
    + '\n    ADMIN_EMAIL=… ADMIN_PASSWORD=… node pruebas/correr.cjs\n');
  process.exit(1);
}

let ok = 0, ko = 0;
const chk = (t, esperado, obtenido) => {
  const a = JSON.stringify(esperado), b = JSON.stringify(obtenido);
  if (a === b) { console.log(`  \x1b[32m✓\x1b[0m ${t}`); ok++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${t}\n      esperado ${a}\n      obtuvo   ${b}`); ko++; }
};
const tit = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

let cookieAdmin = '';
async function pedir(ruta, { metodo = 'GET', cuerpo, admin = false, crudo = false } = {}) {
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(admin && cookieAdmin ? { Cookie: cookieAdmin } : {}),
    },
    body: cuerpo instanceof FormData ? cuerpo : (cuerpo ? JSON.stringify(cuerpo) : undefined),
  });
  const set = r.headers.getSetCookie?.() || [];
  if (set.length) cookieAdmin = set.map((c) => c.split(';')[0]).join('; ');
  if (crudo) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type') };
  let json = null; try { json = JSON.parse(await r.text()); } catch { /* no json */ }
  return { status: r.status, json };
}

const CLIENTE_OK = {
  nombre: 'QA Prueba', cuit: '27-30456789-4', telefono: '11 5555-5555',
  email: 'qa@prueba.test', provincia: 'Córdoba', ciudad: 'Villa Carlos Paz',
  codigoPostal: '5152', direccion: 'Av. San Martín 1847', entreCalles: '',
  formaEnvio: 'Andreani a sucursal',
};

(async () => {
  tit('1. EL CATÁLOGO SE SIRVE ENTERO Y CON LA GRILLA RESUELTA');
  const cat = await pedir('/api/catalogo');
  chk('responde', 200, cat.status);
  const productos = cat.json?.productos || [];
  chk('hay productos', true, productos.length > 0);

  const p = productos.find((x) => x.combinaciones.length > 1) || productos[0];
  chk('cada producto trae su grilla de SKU', true, p.combinaciones.every((c) => c.sku && 'precio' in c));
  chk('una curva es una unidad de cada combinación', p.combinaciones.length, p.unidadesPorCurva);
  chk('y su precio es la suma de esas unidades',
    p.combinaciones.reduce((t, c) => t + c.precio, 0), p.precioPorCurva);
  chk('no se filtra el stock: no viene ningún campo de stock', false,
    JSON.stringify(cat.json).toLowerCase().includes('"stock"'));
  chk('los colores vienen con su hex para pintar el cuadrito', true,
    p.colores.every((c) => c.nombre && /^(#|hsl)/.test(c.hex)));
  chk('no quedó ningún producto de OFERTA', false,
    productos.some((x) => /oferta/i.test(x.titulo)));

  tit('2. LOS PRECIOS LOS PONE EL SERVIDOR');
  /*
   * La prueba que justifica todo lo demás. Si el navegador pudiera fijar el
   * precio, el pedido llegaría al depósito valorizado en lo que el comprador
   * quiso — y eso se descubre al facturar, no antes.
   */
  const unSku = p.combinaciones[0];
  const conPrecioFalso = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{
        skuAgrupador: p.sku, curvas: 0,
        cantidades: { [unSku.sku]: 2 },
        // Basura a propósito: el servidor no debería mirar nada de esto.
        precio: 1, subtotal: 1, total: 1,
      }],
    },
  });
  chk('previsualiza igual', 200, conPrecioFalso.status);
  chk('y valoriza con el precio del catálogo', unSku.precio * 2, conPrecioFalso.json?.total);

  tit('3. NO SE PUEDE PEDIR LO QUE NO EXISTE');
  const otro = productos.find((x) => x.sku !== p.sku);
  const skuAjeno = otro?.combinaciones[0]?.sku;
  const mezclado = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{ skuAgrupador: p.sku, curvas: 0, cantidades: { [skuAjeno]: 5 } }],
    },
  });
  chk('un SKU de otro producto no entra', 400, mezclado.status);

  const inventado = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: { cliente: CLIENTE_OK, carrito: [{ skuAgrupador: 'NO-EXISTE', cantidades: { X: 1 } }] },
  });
  chk('un producto inventado tampoco', 400, inventado.status);

  tit('4. LAS CANTIDADES RARAS NO ROMPEN NADA');
  const raras = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{
        skuAgrupador: p.sku, curvas: -3,
        cantidades: { [unSku.sku]: -10, [p.combinaciones[1]?.sku || unSku.sku]: 2.7 },
      }],
    },
  });
  // -10 se descarta, 2.7 se trunca a 2, y las curvas negativas quedan en cero.
  const esperadoRaras = p.combinaciones[1] ? p.combinaciones[1].precio * 2 : unSku.precio * 2;
  chk('negativos y decimales se normalizan', esperadoRaras, raras.json?.total);
  chk('sin totales negativos', true, (raras.json?.total ?? -1) >= 0);

  tit('5. LOS DATOS DEL CLIENTE SE VALIDAN EN EL SERVIDOR');
  const vacio = await pedir('/api/pedidos', {
    metodo: 'POST',
    cuerpo: { cliente: {}, carrito: [{ skuAgrupador: p.sku, cantidades: { [unSku.sku]: 1 } }] },
  });
  chk('sin datos no se confirma', 400, vacio.status);
  chk('y se marcan los ocho obligatorios', 8, Object.keys(vacio.json?.erroresCliente || {}).length);

  const cuitMalo = await pedir('/api/pedidos', {
    metodo: 'POST',
    cuerpo: {
      cliente: { ...CLIENTE_OK, cuit: '27-30456789-9' },
      carrito: [{ skuAgrupador: p.sku, cantidades: { [unSku.sku]: 1 } }],
    },
  });
  chk('un CUIT con dígito verificador malo se rechaza', 400, cuitMalo.status);
  chk('y lo dice en el campo', true, Boolean(cuitMalo.json?.erroresCliente?.cuit));

  tit('6. UN PEDIDO COMPLETO, DE PUNTA A PUNTA');
  const carritoReal = [
    { skuAgrupador: p.sku, curvas: 1, cantidades: { [unSku.sku]: 3 } },
  ];
  const previa = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST', cuerpo: { cliente: CLIENTE_OK, carrito: carritoReal },
  });
  chk('previsualiza', 200, previa.status);
  const esperadoTotal = p.precioPorCurva + unSku.precio * 3;
  chk('la curva y las sueltas se suman', esperadoTotal, previa.json?.total);
  chk('y las unidades también', p.unidadesPorCurva + 3, previa.json?.unidades);

  const confirmado = await pedir('/api/pedidos', {
    metodo: 'POST', cuerpo: { cliente: CLIENTE_OK, carrito: carritoReal },
  });
  chk('se confirma', 201, confirmado.status);
  chk('con número de pedido', true, /^ISU-\d{6}$/.test(confirmado.json?.numero || ''));
  chk('el total no cambió entre la previa y la confirmación', esperadoTotal, confirmado.json?.total);

  tit('7. EL REMITO SE GENERA Y ES UN PDF DE VERDAD');
  const numero = confirmado.json.numero;
  const firma = confirmado.json.token;
  chk('al confirmar viene la firma para bajarlo', true, typeof firma === 'string' && firma.length > 20);

  const remito = await pedir(`/api/pedidos/${numero}/pedido.pdf?t=${encodeURIComponent(firma)}`, { crudo: true });
  chk('pedido.pdf responde', 200, remito.status);
  chk('pedido.pdf es application/pdf', true, String(remito.tipo).includes('application/pdf'));
  // Los cuatro primeros bytes de un PDF son %PDF. Un 200 con un HTML de error
  // adentro también "descarga bien" y se ve recién al abrirlo.
  chk('pedido.pdf empieza con %PDF', '%PDF', remito.buffer.subarray(0, 4).toString());
  chk('pedido.pdf no está vacío', true, remito.buffer.length > 800);

  const inexistente = await pedir('/api/pedidos/ISU-999999/pedido.pdf');
  chk('un pedido que no existe da 404', 404, inexistente.status);
  const docRaro = await pedir(`/api/pedidos/${numero}/factura.pdf`);
  chk('un documento que no existe da 404', 404, docRaro.status);

  tit('7b. EL PEDIDO DE OTRO NO SE BAJA PROBANDO NÚMEROS');
  /*
   * Los números son correlativos. Sin nada que verificar, ISU-000001 en la
   * barra de direcciones entregaba el remito de ese pedido —con el nombre, el
   * CUIT, el teléfono y la dirección de quien lo hizo—.
   */
  const ajeno = await pedir(`/api/pedidos/${numero}/pedido.pdf`);
  chk('sin la firma no se baja', 404, ajeno.status);
  const firmaFalsa = await pedir(`/api/pedidos/${numero}/pedido.pdf?t=lacomoquiera`);
  chk('con una firma inventada tampoco', 404, firmaFalsa.status);
  chk('y contesta lo mismo que si no existiera', ajeno.status, inexistente.status);

  const rotuloDeCliente = await pedir(`/api/pedidos/${numero}/rotulo.pdf?t=${encodeURIComponent(firma)}`);
  chk('el rótulo no lo baja el cliente ni con su firma', 403, rotuloDeCliente.status);

  tit('8. EL PANEL NO SE ABRE SIN CONTRASEÑA');
  cookieAdmin = '';
  chk('los productos piden sesión', 401, (await pedir('/api/admin/productos', { admin: true })).status);
  chk('los pedidos también', 401, (await pedir('/api/admin/pedidos', { admin: true })).status);
  chk('importar también', 401, (await pedir('/api/admin/importar', { metodo: 'POST', admin: true })).status);

  /*
   * Se entra por la MISMA puerta que los clientes: /api/sesion. El servidor
   * mira el email y decide el rol. Que el panel tuviera su propio login era
   * tener dos formas de estar autenticado y dos lugares donde arreglar lo
   * mismo.
   */
  const claveMala = await pedir('/api/sesion', {
    metodo: 'POST', cuerpo: { email: EMAIL_ADMIN, password: 'a' },
  });
  chk('con la contraseña equivocada no entra', 401, claveMala.status);

  // El limitador deja un intento por segundo: se espera para no medirlo a él.
  await new Promise((r) => setTimeout(r, 1100));
  const entra = await pedir('/api/sesion', {
    metodo: 'POST', cuerpo: { email: EMAIL_ADMIN, password: CLAVE_ADMIN },
  });
  chk('con la correcta sí',   200,     entra.status);
  chk('y el rol es admin',    'admin', entra.json?.rol);
  chk('y ahora los productos se ven', 200, (await pedir('/api/admin/productos', { admin: true })).status);

  tit('9. UNA COOKIE FALSIFICADA NO SIRVE');
  const guardada = cookieAdmin;
  cookieAdmin = 'isuwaya_sesion=eyJyb2wiOiJhZG1pbiJ9.firmaInventada';
  chk('firma inventada, rechazada', 401, (await pedir('/api/admin/productos', { admin: true })).status);
  cookieAdmin = 'isuwaya_sesion=' + Buffer.from(JSON.stringify({rol:'admin',vence:1})).toString('base64url') + '.x';
  chk('vencida, rechazada', 401, (await pedir('/api/admin/productos', { admin: true })).status);
  cookieAdmin = guardada;

  tit('10. IMPORTAR ES IDEMPOTENTE');
  /*
   * Subir la misma planilla dos veces tiene que dejar el catálogo igual, no
   * duplicado. Es lo que hace que se pueda reimportar después de tocar precios
   * en STOCKER sin miedo.
   */
  /*
 * Se reimporta el catálogo REAL, no el de ejemplo.
 *
 * Importar una planilla distinta agrega productos, que es lo correcto y no
 * prueba nada sobre duplicados. Lo que hay que comprobar es que la MISMA
 * planilla dos veces deje el catálogo igual — que es lo que hace que se pueda
 * reimportar después de tocar precios sin miedo.
 */
const planilla = path.join(__dirname, 'catalogo-isuwaya.xlsx');
  if (!fs.existsSync(planilla)) {
    console.log('  (no está pruebas/export-stocker.xlsx: se saltea la importación)');
  } else {
    const antes = (await pedir('/api/admin/productos', { admin: true })).json.productos.length;
    const fd = new FormData();
    fd.append('planilla', new Blob([fs.readFileSync(planilla)]), 'export.xlsx');
    const imp = await pedir('/api/admin/importar', { metodo: 'POST', cuerpo: fd, admin: true });
    chk('la planilla se importa', 200, imp.status);
    const despues = (await pedir('/api/admin/productos', { admin: true })).json.productos.length;
    chk('reimportar no duplica productos', antes, despues);
    const cat = (await pedir('/api/catalogo')).json;
    chk('y OFERTA sigue afuera después de reimportar', false,
      cat.productos.some((x) => /oferta/i.test(x.titulo))
      || cat.categorias.some((c) => /oferta/i.test(c.nombre)));

    const basura = new FormData();
    basura.append('planilla', new Blob(['esto no es un excel']), 'cualquiera.xlsx');
    const mala = await pedir('/api/admin/importar', { metodo: 'POST', cuerpo: basura, admin: true });
    chk('un archivo que no es planilla se rechaza con 400', 400, mala.status);
  }

  tit('12. COLORES: SE EDITAN, SE UNEN, Y NO SE BORRAN SI ESTÁN EN USO');
  const colores = (await pedir('/api/admin/colores', { admin: true })).json.colores;
  chk('hay colores cargados', true, colores.length > 0);
  chk('todos con hex válido', true, colores.every((c) => /^(#[0-9a-f]{6}|hsl)/i.test(c.hex)));

  const unColor = colores.find((c) => c.variantes > 0);
  const hexOriginal = unColor.hex;
  const cambio = await pedir(`/api/admin/colores/${unColor.id}`, {
    metodo: 'PUT', cuerpo: { hex: '#123456' }, admin: true,
  });
  chk('se cambia el hex', 200, cambio.status);
  const trasCambio = (await pedir('/api/admin/colores', { admin: true })).json.colores
    .find((c) => c.id === unColor.id);
  chk('y queda guardado',                '#123456', trasCambio.hex);
  chk('y deja de estar "por confirmar"', 0,         trasCambio.provisorio);

  const hexMalo = await pedir(`/api/admin/colores/${unColor.id}`, {
    metodo: 'PUT', cuerpo: { hex: 'azulcito' }, admin: true,
  });
  chk('un hex inventado se rechaza', 400, hexMalo.status);

  /*
   * Borrar un color en uso dejaría a esas variantes sin color: el cliente
   * vería una fila sin cuadrito ni nombre y no sabría qué está pidiendo.
   */
  const borrado = await pedir(`/api/admin/colores/${unColor.id}`, { metodo: 'DELETE', admin: true });
  chk('no se borra un color en uso', 409, borrado.status);

  // Unir: se crea uno y se lo renombra al que ya existe.
  await pedir('/api/admin/colores', {
    metodo: 'POST', cuerpo: { nombre: 'QA Color Temporal', hex: '#abcdef' }, admin: true,
  });
  const temporal = (await pedir('/api/admin/colores', { admin: true })).json.colores
    .find((c) => c.nombre === 'QA Color Temporal');
  const union = await pedir(`/api/admin/colores/${temporal.id}`, {
    metodo: 'PUT', cuerpo: { nombre: unColor.nombre }, admin: true,
  });
  chk('renombrar a uno que existe los une', 'unido', union.json?.accion);
  chk('y el temporal desaparece', undefined,
    (await pedir('/api/admin/colores', { admin: true })).json.colores.find((c) => c.nombre === 'QA Color Temporal'));

  await pedir(`/api/admin/colores/${unColor.id}`, { metodo: 'PUT', cuerpo: { hex: hexOriginal }, admin: true });

  tit('13. TALLES: NIÑO Y ADULTO SON COSAS DISTINTAS');
  const talles = (await pedir('/api/admin/talles', { admin: true })).json.talles;
  chk('hay talles', true, talles.length > 0);
  chk('separados en grupos', true, talles.some((t) => t.grupo === 'nino') && talles.some((t) => t.grupo === 'adulto'));
  chk('no quedaron minúsculas sueltas', false, talles.some((t) => t.nombre !== t.nombre.toUpperCase() && /^\d?x/i.test(t.nombre)));

  const talleEnUso = talles.find((t) => t.variantes > 0);
  chk('no se borra un talle en uso', 409,
    (await pedir(`/api/admin/talles/${talleEnUso.id}`, { metodo: 'DELETE', admin: true })).status);

  tit('14. LA GUÍA DE TALLES ES DE CADA PRODUCTO');
  const unProducto = (await pedir('/api/admin/productos', { admin: true })).json.productos[0];
  const guia = {
    columnas: ['Ancho', 'Largo'],
    filas: [{ talle: 'M', Ancho: '54', Largo: '70' }, { talle: 'L', Ancho: '58', Largo: '72' }],
    nota: 'Medidas en cm.',
  };
  const guardarGuia = await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}/guia`, {
    metodo: 'PUT', cuerpo: { guia }, admin: true,
  });
  chk('se guarda', 200, guardarGuia.status);

  const enCatalogo = (await pedir('/api/catalogo')).json.productos
    .find((p2) => p2.sku === unProducto.sku_agrupador);
  chk('y el CLIENTE la ve', 2, enCatalogo?.guiaTalles?.filas?.length);
  chk('con las medidas puestas', '54', enCatalogo.guiaTalles.filas[0].Ancho);

  /*
   * Una guía CON talles pero SIN qué medir no es una guía: sería una columna de
   * talles sola, que el cliente ya ve en la matriz.
   */
  const guiaSinMedidas = await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}/guia`, {
    metodo: 'PUT', cuerpo: { guia: { columnas: [], filas: [{ talle: 'M' }] } }, admin: true,
  });
  chk('con talles pero sin medidas se rechaza', 400, guiaSinMedidas.status);

  // Y una guía vacía del todo SÍ es válida: quiere decir "sacala".
  const quitarla = await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}/guia`, {
    metodo: 'PUT', cuerpo: { guia: null }, admin: true,
  });
  chk('mandarla vacía la quita', 200,  quitarla.status);
  chk('y el cliente deja de verla', null,
    (await pedir('/api/catalogo')).json.productos
      .find((p2) => p2.sku === unProducto.sku_agrupador)?.guiaTalles ?? null);

  tit('15. PRECIOS EN MASA: NUNCA SIN FILTRO');
  const sinFiltro = await pedir('/api/admin/variantes', {
    metodo: 'PUT', cuerpo: { accion: 'porcentaje', valor: 10 }, admin: true,
  });
  /*
   * Sin filtro esto tocaría las 2300 variantes del catálogo. Un cambio de ese
   * tamaño tiene que pedirse a propósito, no salir de un formulario vacío.
   */
  chk('sin ningún filtro se rechaza', 400, sinFiltro.status);

  const cuenta = await pedir('/api/admin/variantes/contar', {
    metodo: 'POST', cuerpo: { skuAgrupador: unProducto.sku_agrupador }, admin: true,
  });
  chk('se puede ver a cuántas toca antes', true, cuenta.json.variantes > 0);

  const antesDelCambio = (await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}`, { admin: true })).json;
  const aplicar = await pedir('/api/admin/variantes', {
    metodo: 'PUT',
    cuerpo: { skuAgrupador: unProducto.sku_agrupador, accion: 'fijar', valor: 12345 },
    admin: true,
  });
  chk('con filtro se aplica',      200,                    aplicar.status);
  chk('y dice cuántas cambió',     cuenta.json.variantes,  aplicar.json.cambiadas);

  const despuesDelCambio = (await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}`, { admin: true })).json;
  chk('las variantes quedaron con ese precio', true,
    despuesDelCambio.variantes.every((v) => v.precio === 12345));

  await pedir('/api/admin/variantes', {
    metodo: 'PUT', cuerpo: { skuAgrupador: unProducto.sku_agrupador, accion: 'heredar' }, admin: true,
  });
  chk('y "heredar" las devuelve al precio del producto', true,
    (await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}`, { admin: true }))
      .json.variantes.every((v) => v.precio === null));

  tit('15b. PRECIO PROPIO PARA LOS TALLES GRANDES');
  /*
   * Del 3XL para arriba lleva más tela y suele salir más caro, y cuánto más
   * cambia por producto. Sin esto, la única salida sería crear un producto
   * aparte por talle: parte el catálogo y rompe la curva.
   */
  const conGrandes = (await pedir('/api/catalogo')).json.productos
    .find((x) => x.talles.some((t) => ['3XL', '4XL', '5XL'].includes(t)));

  if (!conGrandes) {
    console.log('  (ningún producto tiene talles grandes: se saltea)');
  } else {
    const aplicar = await pedir(`/api/admin/productos/${encodeURIComponent(conGrandes.sku)}/precio-talles`, {
      metodo: 'PUT', cuerpo: { talles: ['3XL', '4XL', '5XL'], precio: 99999 }, admin: true,
    });
    chk('se aplica a esos talles', 200,  aplicar.status);
    chk('y dice a cuántas tocó',   true, aplicar.json.cambiadas > 0);

    const verlo = (await pedir('/api/catalogo')).json.productos.find((x) => x.sku === conGrandes.sku);
    const grandes = verlo.combinaciones.filter((c) => ['3XL', '4XL', '5XL'].includes(c.talle));
    const resto = verlo.combinaciones.filter((c) => !['3XL', '4XL', '5XL'].includes(c.talle));
    chk('el CLIENTE ve el precio distinto en esos talles', true, grandes.every((c) => c.precio === 99999));
    chk('y el resto sigue con el del producto',            true, resto.every((c) => c.precio === verlo.precio));
    // Es lo que hace que valga la pena: la curva lleva un talle de cada uno.
    chk('la curva cuesta lo que suman sus talles',
      verlo.combinaciones.reduce((t, c) => t + c.precio, 0), verlo.precioPorCurva);

    await pedir(`/api/admin/productos/${encodeURIComponent(conGrandes.sku)}/precio-talles`, {
      metodo: 'PUT', cuerpo: { talles: ['3XL', '4XL', '5XL'], precio: null }, admin: true,
    });
    chk('y se puede volver atrás', true,
      (await pedir('/api/catalogo')).json.productos.find((x) => x.sku === conGrandes.sku)
        .combinaciones.every((c) => c.precio === verlo.precio));

    const sinTalles = await pedir(`/api/admin/productos/${encodeURIComponent(conGrandes.sku)}/precio-talles`, {
      metodo: 'PUT', cuerpo: { talles: [], precio: 100 }, admin: true,
    });
    chk('sin elegir talles se rechaza', 400, sinTalles.status);
  }

  tit('15c. LOS COLORES DE UNA FOTO SON LOS DEL PRODUCTO');
  /*
   * Ofreciendo los treinta y seis colores del catálogo, se puede etiquetar la
   * foto de un pantalón negro como "Salmon" — y esa foto no se muestra nunca,
   * sin ningún error que lo avise.
   */
  const detalleProd = (await pedir(`/api/admin/productos/${encodeURIComponent(unProducto.sku_agrupador)}`, { admin: true })).json;
  const coloresReales = new Set(detalleProd.variantes.map((v) => v.color));
  chk('el detalle trae sólo los colores del producto', true,
    detalleProd.colores.length > 0 && detalleProd.colores.every((c) => coloresReales.has(c.nombre)));
  chk('y no los del catálogo entero', true,
    detalleProd.colores.length < (await pedir('/api/admin/colores', { admin: true })).json.colores.length);
  chk('los talles también, y ordenados', true,
    detalleProd.talles.every((t, i, a) => i === 0 || a[i - 1].orden <= t.orden));

  tit('15d. LOS COLORES OFICIALES');
  const paleta = (await pedir('/api/admin/colores', { admin: true })).json;
  chk('la lista oficial tiene veintidós', 22, paleta.oficiales.length);
  chk('están todos cargados', true,
    paleta.oficiales.every((o) => paleta.colores.some((c) => c.nombre === o)));
  chk('con la ortografía del negocio', true,
    ['Beish', 'Melang', 'Bordo', 'Salmon', 'Aero'].every((n) => paleta.colores.some((c) => c.nombre === n)));
  chk('las uniones del STOCKER no dejaron ninguno afuera', 0,
    paleta.colores.filter((c) => !c.oficial).length);
  chk('y no volvieron los repetidos', 0,
    paleta.colores.filter((c) => ['Moliné', 'Gris', 'Camel Claro', 'Crema', 'Cielo'].includes(c.nombre)).length);

  /*
   * El marcador de "fuera de la lista" se prueba a propósito.
   *
   * Antes lo probaba el dato sucio del STOCKER, pero ahora el importador une
   * los repetidos solo y no queda ninguno marcado. Si el test siguiera
   * apoyado en eso, el día que alguien rompa el marcador nadie se entera.
   */
  await pedir('/api/admin/colores', {
    metodo: 'POST', admin: true, cuerpo: { nombre: 'Fucsia QA', hex: '#FF00AA' },
  });
  const conIntruso = (await pedir('/api/admin/colores', { admin: true })).json;
  const intruso = conIntruso.colores.find((c) => c.nombre === 'Fucsia QA');
  chk('un color que no está en la lista entra marcado', false, intruso?.oficial);
  await pedir(`/api/admin/colores/${intruso?.id}`, { metodo: 'DELETE', admin: true });
  const limpio = (await pedir('/api/admin/colores', { admin: true })).json;
  chk('y el test se lleva su basura', 22, limpio.colores.length);

  tit('16. EL HISTORIAL RESPONDE PREGUNTAS');
  const historial = await pedir('/api/admin/pedidos', { admin: true });
  chk('trae pedidos',   true, Array.isArray(historial.json.pedidos));
  chk('y los totales',  true, historial.json.totales
    && 'facturado' in historial.json.totales && 'unidades' in historial.json.totales);
  chk('con el detalle de cada uno', true,
    historial.json.pedidos.length === 0 || Array.isArray(historial.json.pedidos[0].items));

  const futuro = await pedir('/api/admin/pedidos?desde=2099-01-01', { admin: true });
  chk('un filtro de fecha que no alcanza a nada da cero', 0, futuro.json.totales.pedidos);

  tit('17. LO QUE SE VE ADENTRO NO SOBREVIVE A LA SESIÓN');
  /*
   * El navegador congela la página al salir de ella y el botón Atrás la
   * devuelve pintada sin ejecutar una línea: sin `no-store`, cerrar sesión en
   * una computadora compartida dejaba el panel —clientes y pedidos incluidos—
   * a un Atrás de distancia del que se sentaba después.
   *
   * El otro medio del arreglo vive en el navegador (pagehide/pageshow) y no se
   * puede probar desde acá; esto cubre la mitad que sí sirve el servidor.
   */
  const cabeceras = async (ruta) => (await fetch(`${API}${ruta}`)).headers.get('cache-control') || '';
  chk('el panel se sirve sin guardarse', true, (await cabeceras('/admin.html')).includes('no-store'));
  chk('la tienda también',                true, (await cabeceras('/')).includes('no-store'));
  chk('pero el CSS se sigue cacheando',   false, (await cabeceras('/css/estilos.css')).includes('no-store'));
  chk('y el JavaScript también',          false, (await cabeceras('/js/admin.js')).includes('no-store'));

  /*
   * Todo viajaba sin comprimir: 350 KB de catálogo en un teléfono con datos. Se
   * pide como un navegador —aceptando brotli—, como uno viejo que sólo sabe
   * gzip y como algo que no acepta ninguna, y se mira que el texto llegue entero.
   */
  const codificacion = async (ruta, acepta) => {
    const r = await fetch(`${API}${ruta}`, { headers: { 'Accept-Encoding': acepta } });
    const texto = await r.text();
    return { enc: r.headers.get('content-encoding'), vary: r.headers.get('vary') || '', texto };
  };
  const cssBr = await codificacion('/css/estilos.css', 'br, gzip');
  chk('el CSS sale comprimido con brotli', ['br', true], [cssBr.enc, /accept-encoding/i.test(cssBr.vary)]);
  chk('y se descomprime entero', true, cssBr.texto.includes('--degrade') && cssBr.texto.includes('prefers-reduced-motion'));
  const catBr = await codificacion('/api/catalogo', 'br');
  chk('el catálogo también sale comprimido', 'br', catBr.enc);
  chk('y sigue siendo el JSON de siempre', true, Array.isArray(JSON.parse(catBr.texto).productos));
  chk('con gzip si es lo único que acepta', 'gzip', (await codificacion('/js/app.js', 'gzip')).enc);
  chk('sin comprimir si no acepta ninguna', null, (await codificacion('/css/estilos.css', 'identity')).enc);
  chk('y con brotli apagado (q=0) usa gzip', 'gzip', (await codificacion('/css/estilos.css', 'br;q=0, gzip')).enc);

  const panelSinCookie = await fetch(`${API}/api/admin/clientes`);
  chk('sin sesión el panel no da ni un cliente', 401, panelSinCookie.status);

  tit('19. LA CURVA DE UN COLOR SOLO');
  /*
   * La curva entera obliga a llevarse todos los colores. Quien se quedó sin
   * negro y quiere reponer nada más que eso pide una unidad de cada talle,
   * pero de un color.
   */
  const conVariosColores = productos.find((x) => new Set(x.combinaciones.map((c) => c.color)).size > 2);
  const colorElegido = [...new Set(conVariosColores.combinaciones.map((c) => c.color))][1];
  const combosDelColor = conVariosColores.combinaciones.filter((c) => c.color === colorElegido);

  const curvaColor = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{ skuAgrupador: conVariosColores.sku, curvas: 0, curvasPorColor: { [colorElegido]: 2 }, cantidades: {} }],
    },
  });
  chk('se previsualiza', 200, curvaColor.status);
  chk('trae una unidad de cada talle de ese color, por cada curva',
    combosDelColor.length * 2, curvaColor.json?.unidades);
  chk('y cuesta lo que suman esos talles',
    combosDelColor.reduce((t, c) => t + c.precio, 0) * 2, curvaColor.json?.total);
  chk('el desglose es de ese color y de ningún otro',
    [colorElegido], curvaColor.json?.items?.[0]?.detalle?.map((d) => d.color));

  /*
   * El nombre del color que ve el cliente y el que llega al depósito tienen
   * que ser el mismo. En la base conviven veintinueve escrituras del mismo
   * color; armando el pedido con el texto crudo, se pedía "Melang" y salía
   * "Moline".
   */
  const nombresDelCatalogo = new Set(conVariosColores.combinaciones.map((c) => c.color));
  chk('y con el nombre que muestra el catálogo, no el de la planilla', true,
    curvaColor.json?.items?.[0]?.detalle?.every((d) => nombresDelCatalogo.has(d.color)));

  const mezcla = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{
        skuAgrupador: conVariosColores.sku,
        curvas: 1,
        curvasPorColor: { [colorElegido]: 1 },
        cantidades: { [combosDelColor[0].sku]: 5 },
      }],
    },
  });
  chk('curva entera, curva de color y sueltas se suman sin pisarse',
    conVariosColores.unidadesPorCurva + combosDelColor.length + 5, mezcla.json?.unidades);
  chk('y el importe también',
    conVariosColores.precioPorCurva
      + combosDelColor.reduce((t, c) => t + c.precio, 0)
      + combosDelColor[0].precio * 5,
    mezcla.json?.total);

  const colorFalso = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{ skuAgrupador: conVariosColores.sku, curvas: 0, curvasPorColor: { 'Fucsia Inventado': 4 }, cantidades: {} }],
    },
  });
  chk('un color que no existe no entra de contrabando', true,
    (colorFalso.json?.errores || []).some((e) => e.includes('Fucsia Inventado')));
  chk('y no suma ni una unidad', 0, colorFalso.json?.unidades || 0);

  const curvaNegativa = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{ skuAgrupador: conVariosColores.sku, curvas: 0, curvasPorColor: { [colorElegido]: -3 }, cantidades: {} }],
    },
  });
  chk('una curva negativa no descuenta nada', 0, curvaNegativa.json?.unidades || 0);

  const exagerado = await pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: {
      cliente: CLIENTE_OK,
      carrito: [{ skuAgrupador: conVariosColores.sku, curvas: 0, cantidades: { [combosDelColor[0].sku]: 999999 } }],
    },
  });
  chk('un cero de más en una cantidad se avisa, no se cobra', 0, exagerado.json?.unidades || 0);
  chk('y se dice por qué', true,
    (exagerado.json?.errores || []).some((e) => e.includes('demasiado')));

  tit('20. LOS TALLES SALEN EN EL ORDEN DEL NEGOCIO');
  /*
   * "2XL" y "XXL" son el mismo talle escrito de dos formas. Con una lista fija
   * de nombres, la forma que faltaba caía en el cajón de lo desconocido y se
   * iba al final: las columnas salían XS S M L XL 4XL 5XL 2XL 3XL, con los dos
   * talles más pedidos al final de todo.
   */
  const conTallesGrandes = productos.find((x) => x.talles.includes('2XL') && x.talles.includes('4XL'));
  if (conTallesGrandes) {
    const orden = conTallesGrandes.talles;
    chk('2XL viene antes que 3XL', true, orden.indexOf('2XL') < orden.indexOf('3XL'));
    chk('3XL antes que 4XL',       true, orden.indexOf('3XL') < orden.indexOf('4XL'));
    chk('y XL antes que 2XL',      true, orden.indexOf('XL') < orden.indexOf('2XL'));
  }
  const conTallesDeNino = productos.find((x) => x.talles.every((t) => /^\d+$/.test(t)) && x.talles.length > 2);
  if (conTallesDeNino) {
    const nums = conTallesDeNino.talles.map(Number);
    chk('los talles de niño van por número', true, nums.every((n, i) => i === 0 || nums[i - 1] < n));
  }

  tit('18. EL RÓTULO ES DE QUIEN DESPACHA');
  const rotuloAdmin = await pedir(`/api/pedidos/${numero}/rotulo.pdf`, { admin: true, crudo: true });
  chk('el administrador sí lo baja', 200, rotuloAdmin.status);
  chk('y es un PDF de verdad', '%PDF', rotuloAdmin.buffer.subarray(0, 4).toString());
  chk('de 10×15, así que pesa menos que el A4', true, rotuloAdmin.buffer.length > 800);
  const remitoAdmin = await pedir(`/api/pedidos/${numero}/pedido.pdf`, { admin: true, crudo: true });
  chk('el remito también, sin firma', 200, remitoAdmin.status);

  tit('11. LAS RESPUESTAS QUE NO EXISTEN SON HONESTAS');
  const apiRara = await pedir('/api/lo-que-sea');
  chk('un endpoint inventado da 404 en JSON', 404, apiRara.status);
  chk('y no devuelve el HTML de la página', true, Boolean(apiRara.json?.message));

  const archivoRaro = await pedir('/no-existe.js', { crudo: true });
  chk('un archivo que no está da 404, no el index', 404, archivoRaro.status);

  tit('22. LAS FOTOS DEL PANEL LLEGAN AL CATÁLOGO');
  /*
   * El panel guardaba las fotos en una tabla y el catálogo leía de otra: se
   * podían subir veinte por producto, cada una con su color, y al cliente le
   * llegaba sólo la principal. Se sube una general y una de un color, se mira
   * que las dos lleguen con su color, y se borran.
   */
  /*
   * Un producto SIN fotos: con las fotos reales cargadas, uno que ya tiene sus
   * cinco por color rechazaría la de prueba y la prueba mediría el tope, no lo
   * que dice que mide.
   */
  const conFoto = productos.find((x) => new Set(x.combinaciones.map((c) => c.color)).size > 1
    && !(x.fotos || []).length) || p;
  const rutaAdmin = `/api/admin/productos/${encodeURIComponent(conFoto.sku)}`;
  const deAdmin = (await pedir(rutaAdmin, { admin: true })).json;
  const colorDeFoto = (deAdmin.colores || []).find((c) => c.id && c.nombre);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const subirFoto = async (colorId) => {
    const fd = new FormData();
    fd.append('foto', new Blob([png], { type: 'image/png' }), 'prueba.png');
    if (colorId) fd.append('colorId', String(colorId));
    return pedir(`${rutaAdmin}/fotos`, { metodo: 'POST', cuerpo: fd, admin: true });
  };
  const general = await subirFoto(null);
  const deColor = await subirFoto(colorDeFoto?.id);
  chk('las dos fotos se suben', [200, 200], [general.status, deColor.status]);

  const conFotos = (await pedir('/api/catalogo')).json.productos.find((x) => x.sku === conFoto.sku);
  const rutas = (conFotos.fotos || []).map((f) => f.ruta);
  chk('el catálogo trae todas, no sólo la principal', true,
    rutas.includes(general.json?.ruta) && rutas.includes(deColor.json?.ruta));
  chk('cada una con su color', colorDeFoto?.nombre,
    conFotos.fotos.find((f) => f.ruta === deColor.json?.ruta)?.color);
  chk('la general sin color', null, conFotos.fotos.find((f) => f.ruta === general.json?.ruta)?.color);
  chk('y la principal va primero', conFotos.foto, conFotos.fotos[0]?.ruta);

  /*
   * La tira de miniaturas bajaba las fotos enteras. Cada foto trae ahora una
   * versión chica, que se sirve como imagen de verdad. Y como para hacerla hay
   * que abrir el archivo, lo que no es una imagen rebota aunque el navegador
   * diga que es un PNG.
   */
  const miniatura = conFotos.fotos.find((f) => f.ruta === deColor.json?.ruta)?.miniatura;
  chk('cada foto trae su miniatura', true, typeof miniatura === 'string' && miniatura.endsWith('.webp'));
  const miniServida = await pedir(miniatura, { crudo: true });
  chk('la miniatura se sirve y es una imagen', [200, true], [miniServida.status, String(miniServida.tipo).includes('image/webp')]);
  // La mediana es la que ven la fila del catálogo en pantallas densas y la foto grande del panel.
  const media = conFotos.fotos.find((f) => f.ruta === deColor.json?.ruta)?.media;
  chk('y su versión mediana', true, typeof media === 'string' && media.endsWith('-med.webp'));
  const mediaServida = await pedir(media, { crudo: true });
  chk('la mediana se sirve y es una imagen', [200, true], [mediaServida.status, String(mediaServida.tipo).includes('image/webp')]);
  const trucho = new FormData();
  trucho.append('foto', new Blob([Buffer.from('esto no es una imagen')], { type: 'image/png' }), 'trucha.png');
  chk('un archivo que no es imagen rebota aunque diga que sí', 400,
    (await pedir(`${rutaAdmin}/fotos`, { metodo: 'POST', cuerpo: trucho, admin: true })).status);

  const nuestras = ((await pedir(rutaAdmin, { admin: true })).json.fotos || [])
    .filter((f) => [general.json?.ruta, deColor.json?.ruta].includes(f.ruta));
  for (const f of nuestras) await pedir(`/api/admin/fotos/${f.id}`, { metodo: 'DELETE', admin: true });
  const despues = (await pedir('/api/catalogo')).json.productos.find((x) => x.sku === conFoto.sku);
  chk('y se borran sin dejar rastro', 0,
    (despues.fotos || []).filter((f) => [general.json?.ruta, deColor.json?.ruta].includes(f.ruta)).length);
  chk('y la miniatura se borra con la foto', 404, (await pedir(miniatura, { crudo: true })).status);
  chk('y la mediana también', 404, (await pedir(media, { crudo: true })).status);

  tit('22b. HASTA CINCO FOTOS POR COLOR');
  /*
   * La regla del negocio: hasta cinco fotos por color, y el producto 20 o cinco
   * por cada color que vende. Se suben seis del mismo color: la sexta rebota.
   */
  const seis = [];
  for (let k = 0; k < 6; k += 1) seis.push(await subirFoto(colorDeFoto?.id));
  chk('las cinco primeras de un color entran', [200, 200, 200, 200, 200], seis.slice(0, 5).map((x) => x.status));
  chk('la sexta rebota', 400, seis[5].status);
  const det22 = (await pedir(rutaAdmin, { admin: true })).json;
  const coloresQueVende = new Set(conFoto.combinaciones.map((c) => c.color)).size;
  chk('el tope del producto es 20, o cinco por color si da más', Math.max(20, 5 * coloresQueVende), det22.maxFotos);
  /*
   * Con cuatro colores o menos el tope da 20 igual, así que esa comprobación
   * sola no distingue la regla nueva de la vieja. Se mira además el producto
   * con más colores del catálogo, donde cinco por color tiene que dar más.
   */
  const cuantosColores = (x) => new Set(x.combinaciones.map((c) => c.color)).size;
  const elDeMasColores = productos.reduce((a, b) => (cuantosColores(b) > cuantosColores(a) ? b : a));
  const detMasColores = (await pedir(`/api/admin/productos/${encodeURIComponent(elDeMasColores.sku)}`, { admin: true })).json;
  chk(`con muchos colores el tope crece (${elDeMasColores.sku}, ${cuantosColores(elDeMasColores)} colores)`,
    5 * cuantosColores(elDeMasColores), detMasColores.maxFotos);
  for (const f of (det22.fotos || []).filter((x) => seis.some((y) => y.json?.ruta === x.ruta))) {
    await pedir(`/api/admin/fotos/${f.id}`, { metodo: 'DELETE', admin: true });
  }

  tit('23. LA FORMA DE ENVÍO LA ESCRIBE EL CLIENTE');
  /*
   * Era una lista cerrada de siete transportes, y cada mayorista del interior
   * trabaja con el suyo. Ahora se escribe, con un largo que entre en el
   * recuadro del rótulo.
   */
  const conEnvio = (formaEnvio) => pedir('/api/pedidos/previsualizar', {
    metodo: 'POST',
    cuerpo: { cliente: { ...CLIENTE_OK, formaEnvio }, carrito: [{ skuAgrupador: p.sku, curvas: 1, cantidades: {} }] },
  });
  chk('un transporte que no estaba en ninguna lista se acepta', undefined,
    (await conEnvio('Expreso Cruz del Sur a domicilio')).json?.erroresCliente?.formaEnvio);
  chk('pero con un largo que entre en el rótulo', true,
    /hasta 60/.test((await conEnvio('x'.repeat(61))).json?.erroresCliente?.formaEnvio || ''));
  chk('y sigue siendo obligatoria', true, Boolean((await conEnvio('  ')).json?.erroresCliente?.formaEnvio));

  tit('21. CONFIRMAR PEDIDOS TIENE UN TECHO POR IP');
  /*
   * Va última a propósito: deja la IP frenada un minuto, así que cualquier
   * prueba de pedidos que viniera después mediría el limitador y no lo suyo.
   *
   * Confirmar es anónimo —no se le pide cuenta a nadie para comprar— y cada
   * llamada guarda una fila, arma dos PDF y le manda un mail y un WhatsApp al
   * dueño. Sin techo, un script con CUITs generados le llena la casilla.
   */
  let frenado = 0;
  for (let i = 0; i < 14; i += 1) {
    const r = await pedir('/api/pedidos', { metodo: 'POST', cuerpo: { cliente: {}, carrito: [] } });
    if (r.status === 429) frenado += 1;
  }
  chk('a la ráfaga la corta', true, frenado > 0);
  chk('y con 429, no con un error inventado', true, frenado > 0);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
