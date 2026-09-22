/*
 * Un STOCKER de mentira, para probar la integración sin el sistema real.
 *
 * Guarda cada pedido que recibe en una carpeta y puede fallar a pedido, que es
 * lo que hace falta para probar los reintentos: un servicio que siempre
 * contesta bien no prueba nada de lo que de verdad pasa en producción.
 *
 * También contesta las dos preguntas de vuelta —qué pasó con cada pedido y
 * cuánto sale cada SKU—. Lo que devuelve sale de dos archivos de la carpeta,
 * `_resoluciones.json` y `_precios.json`, que la prueba escribe: así se puede
 * simular que STOCKER aceptó, rechazó o cambió un precio sin tener STOCKER.
 *
 * Uso: node pruebas/stocker-de-prueba.cjs [PUERTO] [CARPETA]
 *      FALLAR=500 node pruebas/stocker-de-prueba.cjs   → contesta 500 a todo
 *      FALLAR=400 …                                    → contesta 400 (definitivo)
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUERTO = Number(process.argv[2]) || 4599;
const CARPETA = process.argv[3] || path.join(os.tmpdir(), 'isuwaya-stocker');
const TOKEN = process.env.TOKEN || 'token-de-prueba';
fs.mkdirSync(CARPETA, { recursive: true });

let recibidos = 0;

const servidor = http.createServer((req, res) => {
  const contestar = (status, cuerpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cuerpo));
  };

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return contestar(401, { message: 'Token inválido.' });
  }

  /*
   * Las dos preguntas de vuelta. Lo que contestan lo escribe la prueba en la
   * carpeta: acá no hay lógica que simular, sólo la forma de la respuesta.
   */
  if (req.method === 'GET') {
    const archivo = req.url.includes('/precios') ? '_precios.json'
      : req.url.includes('/resoluciones') ? '_resoluciones.json' : null;
    if (!archivo) return contestar(404, { message: 'No existe esa ruta.' });
    // Queda registrado qué se preguntó: la prueba mira si viajó el cursor.
    fs.appendFileSync(path.join(CARPETA, '_gets.log'), `${req.url}\n`);
    const falla = Number(process.env.FALLAR) || 0;
    if (falla) return contestar(falla, { message: `Falla de prueba ${falla}` });
    try {
      return contestar(200, JSON.parse(fs.readFileSync(path.join(CARPETA, archivo), 'utf8')));
    } catch {
      return contestar(200, archivo === '_precios.json'
        ? { precios: [], generadoEn: new Date().toISOString() }
        : { resoluciones: [], hasta: null });
    }
  }

  if (req.method !== 'POST') return contestar(405, { message: 'Sólo POST.' });

  let crudo = '';
  req.on('data', (p) => { crudo += p; });
  req.on('end', () => {
    // El modo "fallar" se mira DESPUÉS de leer el cuerpo: así la prueba puede
    // revisar qué se mandó aunque la respuesta haya sido un error.
    const falla = Number(process.env.FALLAR) || 0;
    let cuerpo = null;
    try { cuerpo = JSON.parse(crudo); } catch { /* se guarda igual */ }
    recibidos += 1;
    /*
     * El nombre arranca con la fecha y no con un contador: el servidor se
     * reinicia durante las pruebas y un contador que vuelve a 1 deja los
     * archivos nuevos ordenados ANTES que los viejos.
     */
    fs.writeFileSync(
      path.join(CARPETA, `${Date.now()}-${String(recibidos).padStart(4, '0')}-${cuerpo?.evento || 'sin-evento'}.json`),
      JSON.stringify({ recibidoEn: new Date().toISOString(), ruta: req.url, cuerpo }, null, 1),
    );
    if (falla) return contestar(falla, { message: `Falla de prueba ${falla}` });
    contestar(200, { ok: true, pedido: { id: recibidos, estado: 'aceptado' } });
  });
});

servidor.listen(PUERTO, () => {
  console.log(`stocker de prueba en ${PUERTO}, guardando en ${CARPETA}`);
});
