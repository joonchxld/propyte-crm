import type { OrigenToken } from "./token";

/**
 * Lo que la pantalla de "conectar" necesita saber, calculado sin tocar React ni la base.
 *
 * Vive aparte para poder probarlo: la regla de cuándo la puerta está lista y qué se
 * muestra cuando no lo está es justo lo que se rompe en silencio, y en un componente
 * server no se prueba.
 */

/**
 * Quién puede VER el secreto.
 *
 * No es "esconder un botón": esta pantalla PINTA una credencial. Se pega a ADMIN y
 * DIRECTOR, que es la misma pareja que administra el resto de la configuración del
 * sistema. Hoy no hay ningún usuario con rol DIRECTOR, así que en la práctica es ADMIN —
 * la lista incluye DIRECTOR para que no haya que tocar código cuando lo haya.
 */
export const ROLES_REVISION = ["ADMIN", "DIRECTOR"] as const;

export function puedeVerTokenRevision(rol: string | null | undefined): boolean {
  return !!rol && (ROLES_REVISION as readonly string[]).includes(rol);
}

export type DatosDeConexion = {
  /** La puerta está lista para conectarse. */
  lista: boolean;
  /** URL completa con el token en la ruta. Cadena vacía si no hay token. */
  url: string;
  origen: OrigenToken;
  rotadoEn: string | null;
  /** Por qué no está lista. Cadena vacía cuando sí lo está. */
  motivo: string;
  /** Las tools de código no funcionan sin el PAT, pero las de datos sí. */
  githubListo: boolean;
};

export function datosDeConexion(opts: {
  host: string;
  token: string;
  origen: OrigenToken;
  rotadoEn: string | null;
  githubPat: string | undefined;
}): DatosDeConexion {
  const githubListo = !!opts.githubPat?.trim();

  if (!opts.token) {
    return {
      lista: false,
      url: "",
      origen: "ausente",
      rotadoEn: null,
      motivo:
        "La puerta todavía no tiene token, así que rechaza cualquier conexión. Genera uno con el botón de abajo.",
      githubListo,
    };
  }

  return {
    lista: true,
    // El host sale de la petición y no de una constante: en `localhost:3000` la URL tiene
    // que apuntar ahí o la pantalla entrega una que no sirve para probar.
    url: `https://${opts.host}/api/mcp/revision/${opts.token}`,
    origen: opts.origen,
    rotadoEn: opts.rotadoEn,
    motivo: "",
    githubListo,
  };
}

/**
 * El aviso sobre de dónde salió el token.
 *
 * Un token que viene del entorno NO se puede rotar desde aquí, y callarlo dejaría un
 * botón que parece funcionar y no cambia nada.
 */
export function avisoDeOrigen(origen: OrigenToken): string {
  if (origen === "entorno") {
    return (
      "Este token viene de la variable MCP_REVISION_TOKEN, no de la base. Al generar uno nuevo " +
      "la puerta empezará a usar el de la base y el de la variable dejará de tener efecto: " +
      "conviene borrarla del .env del VPS para no dejar un secreto vivo que nadie sabe que existe."
    );
  }
  return "";
}
