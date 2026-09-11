const path = require('node:path');
const fs = require('node:fs');

/*
 * Lee el .env local si existe.
 *
 * Doce líneas en vez de una dependencia: en Railway las variables las pone la
 * plataforma y este archivo no existe, así que `dotenv` sería un paquete que
 * sólo corre en la máquina de quien desarrolla.
 *
 * Vive en su propio módulo porque lo necesitan dos: el servidor y las pruebas.
 * Las pruebas tienen que entrar como administrador, y la única alternativa a
 * leer el .env es escribir la contraseña en el archivo de pruebas —que sí se
 * commitea—. Eso ya pasó, y como el secreto con el que se firman las sesiones
 * salía de esa misma contraseña, la clave en el repo alcanzaba para falsificar
 * la sesión de cualquiera.
 */
function cargarEnv(raiz = path.join(__dirname, '..')) {
  const archivo = path.join(raiz, '.env');
  if (!fs.existsSync(archivo)) return;
  for (const linea of fs.readFileSync(archivo, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;
    const i = limpia.indexOf('=');
    if (i < 1) continue;
    const clave = limpia.slice(0, i).trim();
    if (process.env[clave] !== undefined) continue;  // lo de afuera manda
    process.env[clave] = limpia.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
}

module.exports = { cargarEnv };
