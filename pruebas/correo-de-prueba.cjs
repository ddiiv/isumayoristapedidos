/*
 * Un servidor de correo de mentira, para probar los avisos sin mandar mails.
 *
 * Los avisos al cliente y a ISUWAYA salen por SMTP. Probarlos contra Gmail
 * mandaría mails de verdad a direcciones inventadas; no probarlos deja la parte
 * del circuito que el cliente ve sin ninguna comprobación. Esto atiende SMTP en
 * la máquina, acepta cualquier usuario y contraseña, y guarda cada mail en una
 * carpeta para que las pruebas lo lean.
 *
 * Uso: node pruebas/correo-de-prueba.cjs [PUERTO] [CARPETA]
 *      y el servidor con MAIL_HOST=127.0.0.1 MAIL_PORT=PUERTO MAIL_USER=x MAIL_PASS=x
 */
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PUERTO = Number(process.argv[2]) || 2525;
const CARPETA = process.argv[3] || path.join(os.tmpdir(), 'isuwaya-correos');
fs.mkdirSync(CARPETA, { recursive: true });

let guardados = 0;
net.createServer((s) => {
  let modo = 'comandos';
  let pendiente = '';
  let datos = [];
  let para = [];
  const decir = (t) => s.write(`${t}\r\n`);
  decir('220 correo-de-prueba');

  s.on('data', (trozo) => {
    pendiente += trozo.toString('latin1');
    let i;
    while ((i = pendiente.indexOf('\r\n')) !== -1) {
      const linea = pendiente.slice(0, i);
      pendiente = pendiente.slice(i + 2);
      if (modo === 'datos') {
        if (linea === '.') {
          guardados += 1;
          const crudo = Buffer.from(datos.join('\r\n'), 'latin1').toString('utf8');
          fs.writeFileSync(path.join(CARPETA, `${Date.now()}-${guardados}.json`), JSON.stringify({ para, crudo }));
          datos = []; para = []; modo = 'comandos';
          decir('250 guardado');
        } else {
          datos.push(linea.startsWith('..') ? linea.slice(1) : linea);
        }
        continue;
      }
      if (modo === 'usuario') { modo = 'clave'; decir('334 UGFzc3dvcmQ6'); continue; }
      if (modo === 'clave') { modo = 'comandos'; decir('235 adelante'); continue; }
      const cmd = linea.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-correo-de-prueba\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
      else if (cmd === 'AUTH') {
        if (/LOGIN/i.test(linea)) { modo = 'usuario'; decir('334 VXNlcm5hbWU6'); } else decir('235 adelante');
      } else if (cmd === 'RCPT') { para.push(linea.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '').trim()); decir('250 ok'); }
      else if (cmd === 'DATA') { modo = 'datos'; decir('354 dale'); }
      else if (cmd === 'QUIT') { decir('221 chau'); s.end(); }
      else decir('250 ok');   // MAIL, RSET, NOOP
    }
  });
  s.on('error', () => {});
}).listen(PUERTO, '127.0.0.1', () => console.log(`correo de prueba en 127.0.0.1:${PUERTO} → ${CARPETA}`));
