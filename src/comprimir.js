const zlib = require('node:zlib');

/*
 * Compresión de lo que sale del servidor, sin paquetes de afuera.
 *
 * Todo viajaba tal cual: el catálogo son 350 KB de JSON, la hoja de estilos 50
 * y los módulos del sitio otros 90. Comprimido, eso baja a una fracción —el
 * JSON de productos repite las mismas claves cientos de veces— y en un teléfono
 * con datos es la diferencia entre ver el catálogo enseguida o esperar.
 *
 * Funciona juntando lo que la ruta escribe y comprimiendo al final. Sirve igual
 * para `res.json` que para los archivos de /public, que express entrega de a
 * pedazos: nada de lo que manda este servidor se escribe en vivo, así que
 * esperar al final no demora a nadie. Lo que ya viene comprimido o no gana nada
 * —fotos, PDF— pasa derecho sin tocarse.
 *
 * Brotli si el navegador lo acepta, gzip si no. Los archivos que no cambian
 * (los de /public, que traen Last-Modified) se comprimen una vez al máximo y se
 * guardan en memoria; lo que arma cada ruta se comprime rápido, porque se hace
 * en cada pedido.
 */

const COMPRIMIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml|font\/(ttf|otf))/i;
const MINIMO = 1024;          // por debajo, las cabeceras de la compresión pesan más que lo que ahorra
const TOPE_MEMORIA = 80;      // respuestas comprimidas guardadas; la más vieja sale primero

const guardadas = new Map();

/** Qué codificación usar según lo que dice el navegador que acepta (respeta `q=0`). */
function elegirCodificacion(cabecera) {
  const pesos = {};
  for (const parte of String(cabecera || '').split(',')) {
    const [nombre, ...parametros] = parte.trim().toLowerCase().split(';');
    if (!nombre) continue;
    const q = parametros.map((p) => p.trim()).find((p) => p.startsWith('q='));
    pesos[nombre] = q ? Number(q.slice(2)) : 1;
  }
  if (pesos.br > 0) return 'br';
  if (pesos.gzip > 0) return 'gzip';
  return null;
}

function aBuffer(pedazo, codificacion) {
  if (pedazo === undefined || pedazo === null) return null;
  return Buffer.isBuffer(pedazo) ? pedazo : Buffer.from(pedazo, typeof codificacion === 'string' ? codificacion : 'utf8');
}

function comprimirCuerpo(cuerpo, codificacion, fijo) {
  if (codificacion === 'br') {
    return zlib.brotliCompressSync(cuerpo, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: fijo ? 11 : 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: cuerpo.length,
      },
    });
  }
  return zlib.gzipSync(cuerpo, { level: fijo ? 9 : 6 });
}

function comprimir(req, res, next) {
  // HEAD no lleva cuerpo, y un pedido por rangos espera los bytes originales.
  const codificacion = req.method === 'HEAD' || req.headers.range
    ? null
    : elegirCodificacion(req.headers['accept-encoding']);
  if (!codificacion) return next();

  const escribir = res.write.bind(res);
  const terminar = res.end.bind(res);
  let pedazos = null;   // null: todavía no se decidió · false: pasa derecho · []: se junta para comprimir

  const decidir = () => {
    if (pedazos !== null) return;
    const tipo = String(res.getHeader('Content-Type') || '');
    const comprimible = COMPRIMIBLE.test(tipo);
    if (comprimible) res.vary('Accept-Encoding');
    const sinCuerpo = res.statusCode === 204 || res.statusCode === 304;
    const noTocar = /no-transform/i.test(String(res.getHeader('Cache-Control') || ''));
    pedazos = comprimible && !sinCuerpo && !noTocar && !res.getHeader('Content-Encoding') ? [] : false;
  };

  res.write = (pedazo, codif, listo) => {
    decidir();
    if (pedazos === false) return escribir(pedazo, codif, listo);
    const b = aBuffer(pedazo, codif);
    if (b) pedazos.push(b);
    const cb = typeof codif === 'function' ? codif : listo;
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };

  res.end = (pedazo, codif, listo) => {
    decidir();
    if (pedazos === false) return terminar(pedazo, codif, listo);
    let cb = listo;
    if (typeof pedazo === 'function') { cb = pedazo; pedazo = null; }
    else if (typeof codif === 'function') { cb = codif; codif = undefined; }
    const b = aBuffer(pedazo, codif);
    if (b) pedazos.push(b);

    const cuerpo = Buffer.concat(pedazos);
    pedazos = false;
    if (cuerpo.length < MINIMO) {
      res.setHeader('Content-Length', cuerpo.length);
      return terminar(cuerpo, cb);
    }

    /*
     * La clave lleva el ETag, que cambia cuando cambia el contenido: un archivo
     * editado o un catálogo con un precio nuevo nunca devuelven lo guardado de
     * antes. Sólo se guarda lo que tiene ETag.
     */
    const etag = res.getHeader('ETag');
    const fijo = Boolean(res.getHeader('Last-Modified'));
    const clave = etag ? `${codificacion}|${req.path}|${etag}` : null;
    let listoParaMandar = clave ? guardadas.get(clave) : null;
    if (!listoParaMandar) {
      listoParaMandar = comprimirCuerpo(cuerpo, codificacion, fijo);
      if (clave) {
        guardadas.set(clave, listoParaMandar);
        if (guardadas.size > TOPE_MEMORIA) guardadas.delete(guardadas.keys().next().value);
      }
    }

    res.setHeader('Content-Encoding', codificacion);
    res.setHeader('Content-Length', listoParaMandar.length);
    return terminar(listoParaMandar, cb);
  };

  next();
}

module.exports = { comprimir, elegirCodificacion };
