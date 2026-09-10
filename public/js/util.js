/** Helpers mínimos, compartidos por las tres piezas de la interfaz. */

export const el = (sel, raiz = document) => raiz.querySelector(sel);
export const todos = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

export const pesos = (n) => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

/*
 * Escapa antes de meter cualquier texto en HTML.
 *
 * Los títulos y colores salen de una planilla de Excel que edita una persona:
 * un "&" o un "<" en un nombre rompe el marcado, y un texto preparado a
 * propósito lo aprovecha. La política de seguridad del sitio ya bloquea la
 * ejecución, pero esto evita que el catálogo se vea roto por un apóstrofo.
 */
export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const enteroPositivo = (v) => Math.max(0, Math.trunc(Number(v) || 0));
