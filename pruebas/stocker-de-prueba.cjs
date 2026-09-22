/*
 * Un STOCKER de mentira, para probar la integración sin el sistema real.
 *
 * Guarda cada pedido que recibe en una carpeta y puede fallar a pedido, que es
 * lo que hace falta para probar los reintentos: un servicio que siempre
 * contesta bien no prueba nada de lo que de verdad pasa en producción.
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

  if (req.method !== 'POST') return contestar(405, { message: 'Sólo POST.' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return contestar(401, { message: 'Token inválido.' });
  }

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
