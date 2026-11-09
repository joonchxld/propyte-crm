import type { LectorDeConfig } from "./types";

/**
 * De dónde sale el secreto de la puerta.
 *
 * SE APARTA DEL PATRÓN DEL HUB A PROPÓSITO. Las puertas del Hub leen su token de una
 * variable de entorno y su pantalla "conectar" solo lo muestra. Aquí vive en
 * `system_config`, y el motivo es que un secreto que solo se puede cambiar entrando al
 * servidor (antes el panel de hPanel, hoy el .env del VPS) **no se rota nunca**: la rotación deja de ser una operación del
 * producto y se vuelve una tarea de infraestructura que nadie hace.
 *
 * Y aquí la rotación importa más que en el Hub: el token viaja EN LA RUTA —único camino
 * de claude.ai— y por lo tanto queda escrito en los logs de acceso del servidor. Un
 * secreto que aparece en los logs y que nadie puede rotar desde la aplicación es el peor
 * de los dos mundos.
 *
 * 🚨 ESTE ARCHIVO SOLO LEE. La escritura vive fuera del directorio de la puerta, en
 * `src/server/revision-token.ts`, y el guardia de solo-lectura vigila que siga así.
 */

/** La clave en `system_config`. Cambiarla deja huérfano el token vigente. */
export const CLAVE_TOKEN = "mcp.revision.token";

export type OrigenToken = "base" | "entorno" | "ausente";

export type TokenEsperado = {
  /** Cadena vacía cuando no hay ninguno configurado. La puerta rechaza todo en ese caso. */
  token: string;
  origen: OrigenToken;
  /** ISO de la última rotación. `null` si nunca se rotó o si viene del entorno. */
  rotadoEn: string | null;
};

type FilaToken = { token?: unknown; rotadoEn?: unknown };

/**
 * Lee el token vigente: primero la base, y el entorno como respaldo de arranque.
 *
 * El orden importa. Si el entorno ganara, rotar desde la pantalla no tendría efecto
 * mientras la variable siguiera puesta —y el síntoma sería el peor posible: la pantalla
 * diría "rotado" y el token viejo seguiría abriendo—.
 *
 * SIN CACHÉ, a propósito. Es un `findUnique` por clave única, y cachearlo aunque fueran
 * 30 segundos significaría que el token recién rotado no sirve todavía y el anterior sí:
 * una ventana en la que el secreto que acabas de revocar sigue abriendo la puerta.
 */
export async function leerTokenEsperado(db: LectorDeConfig): Promise<TokenEsperado> {
  const fila = await db.systemConfig.findUnique({ where: { key: CLAVE_TOKEN } });

  const valor = (fila?.value ?? null) as FilaToken | null;
  const enBase = typeof valor?.token === "string" ? valor.token.trim() : "";
  if (enBase) {
    return {
      token: enBase,
      origen: "base",
      rotadoEn: typeof valor?.rotadoEn === "string" ? valor.rotadoEn : null,
    };
  }

  const enEntorno = (process.env.MCP_REVISION_TOKEN ?? "").trim();
  if (enEntorno) return { token: enEntorno, origen: "entorno", rotadoEn: null };

  return { token: "", origen: "ausente", rotadoEn: null };
}
