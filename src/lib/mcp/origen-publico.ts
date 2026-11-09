/**
 * El origen público de una petición, tomado de las cabeceras y NO de `req.url`.
 *
 * Detrás de un proxy (Passenger/LiteSpeed en hPanel hasta 2026-11; hoy Caddy en el VPS), `req.url` trae la dirección interna donde
 * Node escucha. Medido en producción el 2026-09-17: el documento RFC 9728 salió
 * anunciando `https://0.0.0.0:3000/api/mcp/revision` y el `WWW-Authenticate` mandaba a
 * `https://0.0.0.0:3000/.well-known/...`, inalcanzable para cualquier cliente. Una
 * metadata que apunta a una URL muerta es PEOR que no tenerla: el cliente la sigue y
 * falla, en vez de tratar la puerta como sin descubrimiento.
 *
 * `x-forwarded-host` gana sobre `host` porque es el que sobrevive a un proxy más. Si no
 * hay ninguna de las dos —solo pasa en pruebas que construyen el Request a mano— se cae a
 * `req.url`, que ahí sí es la URL real.
 */
export function origenPublico(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host) return new URL(req.url).origin;

  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
