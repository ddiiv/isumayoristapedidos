const express = require('express');
const crypto = require('node:crypto');
const tomar = require('../tomarPedido');

/*
 * El asistente de ventas por chat (stocker/asistente-local).
 *
 * Toma pedidos conversando y los deja acá como si el cliente los hubiera hecho
 * en la página: el mismo armado, los mismos datos, el mismo aviso por WhatsApp
 * y mail, y a STOCKER por la misma cola (ver src/tomarPedido.js). Lo único
 * propio es que puede cambiar o cancelar un pedido suyo mientras espera la
 * revisión: por chat el cliente pide de a partes y todo va en un solo pedido.
 * Y que trae un pedido por su número, si el WhatsApp que escribe es el
 * teléfono del pedido (el PDF, y retomarlo otro día).
 *
 * Entra con una clave (ASISTENTE_TOKEN) y no por IP: atiende a muchos clientes
 * desde una sola compu, y el freno de la página —diez pedidos por minuto por
 * IP— lo cortaría. Sin la variable, la puerta está cerrada.
 */
const r = express.Router();

r.use((req, res, next) => {
  const clave = process.env.ASISTENTE_TOKEN || '';
  if (!clave) return res.status(503).json({ message: 'El asistente no está habilitado: falta ASISTENTE_TOKEN.' });
  const dada = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const esperada = Buffer.from(clave);
  if (dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) {
    return res.status(401).json({ message: 'Clave del asistente inválida.' });
  }
  next();
});

const contestar = (fn) => async (req, res, next) => {
  try {
    const { status, json } = await fn(req);
    res.status(status).json(json);
  } catch (e) { next(e); }
};

r.post('/pedidos/previsualizar', contestar((req) => tomar.previsualizar(req.body)));
r.post('/pedidos', contestar((req) => tomar.confirmar(req.body, { origen: 'asistente' })));
r.put('/pedidos/:numero', contestar((req) => tomar.cambiar(req.params.numero, req.body, { origen: 'asistente' })));
// El teléfono va en el cuerpo y no en la dirección, para que no quede en los logs.
r.post('/pedidos/:numero/reclamar', contestar(async (req) => tomar.reclamar(req.params.numero, req.body?.telefono)));
r.post('/pedidos/:numero/cancelar', contestar(async (req) => tomar.cancelar(req.params.numero, { origen: 'asistente' })));

module.exports = r;
