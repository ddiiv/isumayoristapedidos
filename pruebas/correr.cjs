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

  tit('11. LAS RESPUESTAS QUE NO EXISTEN SON HONESTAS');
  const apiRara = await pedir('/api/lo-que-sea');
  chk('un endpoint inventado da 404 en JSON', 404, apiRara.status);
  chk('y no devuelve el HTML de la página', true, Boolean(apiRara.json?.message));

  const archivoRaro = await pedir('/no-existe.js', { crudo: true });
  chk('un archivo que no está da 404, no el index', 404, archivoRaro.status);

  console.log(`\n\x1b[1m─────────────────────────────\x1b[0m\n  \x1b[32mPasaron: ${ok}\x1b[0m   \x1b[31mFallaron: ${ko}\x1b[0m`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
