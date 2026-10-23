/*
 * Pruebas de lo que ISUWAYA toma de la tienda online: fotos y guías de talles.
 *
 * Contra una tienda de mentira en un puerto local; no toca datos/ ni necesita
 * el servidor. Uso: node pruebas/tienda.cjs
 */
const assert = require('node:assert/strict');
const http = require('node:http');

const PUERTO = 4598;
process.env.ISU_API_URL = `http://127.0.0.1:${PUERTO}`;
process.env.ISU_TOKEN = 'token-de-prueba';
process.env.ISU_FOTOS_URL = `http://127.0.0.1:${PUERTO}/fotos/`;
const FOTOS = `http://127.0.0.1:${PUERTO}/fotos`;
const tienda = require('../src/tienda');

const respuesta = {
  productos: [
    // Primero uno cuya foto falta en la tienda: no tiene que apagar las de todos.
    { sku: 'isufalta', variantes: ['FALTA1', 'COMPARTIDA'], fotos: [{ clave: 'p/1/faltafalta1', skus: [] }], guia: null },
    {
      sku: 'ISUBOXPAN',
      fotos: [
        { clave: 'p/3f9a0c1b2d4e/abcdef1234', color: null, skus: [] },
        { clave: 'p/3f9a0c1b2d4e/abcdef5678', color: 'Negro', skus: ['ISUBOXPANNEG4'] },
        { clave: 'p/3f9a0c1b2d4e/abcdef9999', color: 'Marrón', skus: ['OTRO'] },
        { clave: 'p/3f9a0c1b2d4e/zzzzzzzz00', color: 'Verde', skus: [] },
        { clave: '../../etc/passwd', color: null, skus: [] },
        { clave: 'https://otro.sitio/x', color: null, skus: [] },
      ],
      guia: {
        nombre: 'Pantalón', tipo: 'otro', nota: 'Calce holgado',
        medidas: [{ clave: 'cintura', nombre: 'Contorno de cintura' }, { clave: 'largo', nombre: 'Largo total' }],
        filas: [{ talle: '4', valores: [[70, 74], [100, 100]] }, { talle: '5', valores: [[75, 79], null] }],
      },
    },
    { sku: 'ISUBOXPAN', fotos: [{ clave: 'p/1/repetidorepe', skus: [] }], guia: null },
    { sku: 'ISUTERCERO', variantes: ['COMPARTIDA'], fotos: [], guia: null },
  ],
};

let fotosVisibles = true;
const servidor = http.createServer((req, res) => {
  if (req.url.startsWith('/fotos/')) {
    res.writeHead(fotosVisibles && req.method === 'HEAD' && req.url === '/fotos/p/3f9a0c1b2d4e/abcdef1234-400.webp' ? 200 : 404).end();
    return;
  }
  if (req.url !== '/v1/interno/catalogo-mayorista' || req.headers['x-isu-mayorista'] !== 'token-de-prueba') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(respuesta));
});

servidor.listen(PUERTO, async () => {
  try {
    assert.equal(await tienda.actualizar(), 3, 'un SKU repetido se toma una sola vez');
    const t = tienda.de('ISUBOXPAN');
    assert.equal(tienda.de('NOEXISTE'), null);
    assert.equal(t.fotos.length, 4, 'las claves con otra forma no pasan');
    assert.equal(tienda.de('isuboxpan'), t, 'sin importar mayúsculas');
    assert.equal(tienda.de('OTRO-PADRE', ['falta1']), tienda.de('ISUFALTA'), 'por las variantes si el padre no coincide');
    assert.equal(tienda.de('OTRO-PADRE', ['COMPARTIDA']), null, 'una variante de dos productos no engancha');
    assert.equal(tienda.de('ISUFALTA').fotos.length, 1, 'una foto que falta no apaga las de todos');

    const combinaciones = [
      { sku: 'ISUBOXPANNEG4', color: 'Negra' },
      { sku: 'ISUBOXPANMAR4', color: 'Marron' },
    ];
    const fotos = tienda.fotosDeLaTienda(t, combinaciones);
    assert.deepEqual(fotos[0], {
      ruta: `${FOTOS}/p/3f9a0c1b2d4e/abcdef1234-1200.webp`,
      media: `${FOTOS}/p/3f9a0c1b2d4e/abcdef1234-800.webp`,
      miniatura: `${FOTOS}/p/3f9a0c1b2d4e/abcdef1234-400.webp`,
      color: null,
    });
    assert.deepEqual(fotos.map((f) => f.color), [null, 'Negra', 'Marron', null], 'por SKU, si no por nombre, si no general');

    assert.deepEqual(t.guia, {
      columnas: ['Contorno de cintura', 'Largo total'],
      filas: [
        { talle: '4', 'Contorno de cintura': '70–74', 'Largo total': '100' },
        { talle: '5', 'Contorno de cintura': '75–79', 'Largo total': '—' },
      ],
      nota: 'Calce holgado',
      pie: 'Medidas en centímetros.',
    });
    assert.equal(tienda.guiaDeLaTienda({ medidas: [], filas: [] }), null);
    assert.equal(tienda.origenFotos(), `http://127.0.0.1:${PUERTO}`);

    // Si las fotos no se ven (ISU_FOTOS_URL mal puesto), se descartan y queda la guía: el catálogo usa las propias.
    fotosVisibles = false;
    await tienda.actualizar();
    assert.equal(tienda.de('ISUBOXPAN').fotos.length, 0);
    assert.ok(tienda.de('ISUBOXPAN').guia);
    fotosVisibles = true;

    // Si la tienda no contesta bien, se queda con lo último que tenía.
    respuesta.productos = 'roto';
    await assert.rejects(tienda.actualizar(), /no trae productos/);
    assert.ok(tienda.de('ISUBOXPAN'));

    console.log('  ✓ tienda: fotos, colores, guía y respuestas malas');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    servidor.close();
  }
});
