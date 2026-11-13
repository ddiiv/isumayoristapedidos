const express = require('express');
const crypto = require('node:crypto');
const whatsapp = require('../whatsapp');

/*
 * Avisos de otros sistemas al grupo de WhatsApp de los empleados.
 *
 * La tienda minorista (isu) no tiene WhatsApp vinculado propio: cada venta
 * pagada la publica acá y sale por el mismo grupo que los pedidos mayoristas,
 * con su PDF. Un solo número vinculado para las dos tiendas.
 *
 * Entra con AVISOS_TOKEN (la misma clave va en el worker de isu como
 * PORTAL_AVISOS_TOKEN). Sin la variable, la puerta está cerrada. Si WhatsApp
 * está desconectado contesta 503 y la tienda reintenta.
 */
const r = express.Router();
const MAX_PDF = 2 * 1024 * 1024;

r.use((req, res, next) => {
  const clave = process.env.AVISOS_TOKEN || '';
  if (clave.length < 32) return res.status(503).json({ message: 'Los avisos no están habilitados: falta AVISOS_TOKEN.' });
  const dada = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const esperada = Buffer.from(clave);
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) {
    return res.status(401).json({ message: 'Clave inválida.' });
  }
  next();
});

r.post('/grupo', async (req, res, next) => {
  try {
    const { texto, pdf, archivo } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim() || texto.length > 3000) return res.status(400).json({ message: 'Falta el texto (hasta 3000 caracteres).' });
    let documento = null;
    if (pdf !== undefined) {
      documento = typeof pdf === 'string' ? Buffer.from(pdf, 'base64') : null;
      if (!documento || documento.length > MAX_PDF || documento.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ message: 'El PDF no es válido.' });
    }
    const nombre = /^[\w.-]{1,80}\.pdf$/.test(String(archivo || '')) ? archivo : 'pedido.pdf';
    const r2 = await whatsapp.mandarAlGrupo({ texto, pdf: documento, archivo: nombre });
    if (!r2.ok) return res.status(503).json({ message: r2.motivo });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = r;
