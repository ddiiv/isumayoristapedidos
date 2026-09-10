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

const API = process.env.API || 'http://localhost:8090';
const CLAVE_ADMIN = process.env.ADMIN_PASSWORD;
const EMAIL_ADMIN = process.env.ADMIN_EMAIL || 'ruthtintaya9@gmail.com';

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

  tit('7. LOS DOS PDF SE GENERAN Y SON PDF DE VERDAD');
  const numero = confirmado.json.numero;
  for (const doc of ['pedido', 'rotulo']) {
    const r = await pedir(`/api/pedidos/${numero}/${doc}.pdf`, { crudo: true });
    chk(`${doc}.pdf responde`, 200, r.status);
    chk(`${doc}.pdf es application/pdf`, true, String(r.tipo).includes('application/pdf'));
    // Los cuatro primeros bytes de un PDF son %PDF. Un 200 con un HTML de error
    // adentro también "descarga bien" y se ve recién al abrirlo.
    chk(`${doc}.pdf empieza con %PDF`, '%PDF', r.buffer.subarray(0, 4).toString());
    chk(`${doc}.pdf no está vacío`, true, r.buffer.length > 800);
  }

  const inexistente = await pedir('/api/pedidos/ISU-999999/pedido.pdf');
  chk('un pedido que no existe da 404', 404, inexistente.status);
  const docRaro = await pedir(`/api/pedidos/${numero}/factura.pdf`);
  chk('un documento que no existe da 404', 404, docRaro.status);

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

  tit('15d. LOS VEINTE COLORES OFICIALES');
  const paleta = (await pedir('/api/admin/colores', { admin: true })).json;
  chk('la lista oficial tiene veinte', 20, paleta.oficiales.length);
  chk('están todos cargados', true,
    paleta.oficiales.every((o) => paleta.colores.some((c) => c.nombre === o)));
  chk('con la ortografía del negocio', true,
    ['Beish', 'Melang', 'Bordo', 'Salmon', 'Aero'].every((n) => paleta.colores.some((c) => c.nombre === n)));
  chk('y los que no están en la lista quedan marcados', true,
    paleta.colores.some((c) => !c.oficial));

  tit('16. EL HISTORIAL RESPONDE PREGUNTAS');
  const historial = await pedir('/api/admin/pedidos', { admin: true });
  chk('trae pedidos',   true, Array.isArray(historial.json.pedidos));
  chk('y los totales',  true, historial.json.totales
    && 'facturado' in historial.json.totales && 'unidades' in historial.json.totales);
  chk('con el detalle de cada uno', true,
    historial.json.pedidos.length === 0 || Array.isArray(historial.json.pedidos[0].items));

  const futuro = await pedir('/api/admin/pedidos?desde=2099-01-01', { admin: true });
  chk('un filtro de fecha que no alcanza a nada da cero', 0, futuro.json.totales.pedidos);

  tit('11. LAS RESPUESTAS QUE NO EXISTEN SON HONESTAS');
  const apiRara = await pedir('/api/lo-que-sea');
  chk('un endpoint inventado da 404 en JSON', 404, apiRara.status);
  chk('y no devuelve el HTML de la página', true, Boolean(apiRara.json?.message));

  const archivoRaro = await pedir('/no-existe.js', { crudo: true });
  chk('un archivo que no está da 404, no el index', 404, archivoRaro.status);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
