// Configuración pública de Embedded Signup (2026-10-14) — SOLO servidor.
//
// Por qué se lee aquí y se pasa como prop, en vez de usar `process.env.NEXT_PUBLIC_*` en el
// componente: Next congela en el build cada referencia LITERAL a `process.env.NEXT_PUBLIC_X`
// (en el cliente y también en el servidor). Cuando el CRM vivía en hPanel (hasta 2026-11) las variables se cambiaban en el panel y la
// app se reinicia sin recompilar, así que una referencia literal se quedaría con el valor del
// último build —vacío la primera vez— y el botón diría «falta configurar» aunque ya estuviera.
// El acceso dinámico (`env[nombre]`) no se congela: se lee en cada petición.
import { META_GRAPH_VERSION } from "./graph";

export const ENV_APP_ID = "NEXT_PUBLIC_META_APP_ID";
export const ENV_CONFIG_ID = "NEXT_PUBLIC_META_ES_CONFIG_ID";
export const ENV_APP_SECRET = "META_WA_APP_SECRET";

/** Lo que el navegador necesita para lanzar Embedded Signup. Nada de esto es secreto. */
export interface EmbeddedSignupPublicConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export type EmbeddedSignupAvailability =
  | { ok: true; config: EmbeddedSignupPublicConfig }
  | { ok: false; missing: string[] };

function read(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * ¿Se puede lanzar Embedded Signup? Revisa también el App Secret (sin devolverlo): sin él el
 * servidor no puede canjear el código, y es mejor decirlo antes de que el usuario haga todo el
 * flujo de Meta para nada.
 */
export function embeddedSignupAvailability(
  env: Record<string, string | undefined> = process.env,
): EmbeddedSignupAvailability {
  const appId = read(env, ENV_APP_ID);
  const configId = read(env, ENV_CONFIG_ID);
  const missing = [
    ...(appId ? [] : [ENV_APP_ID]),
    ...(configId ? [] : [ENV_CONFIG_ID]),
    ...(read(env, ENV_APP_SECRET) ? [] : [ENV_APP_SECRET]),
  ];
  if (missing.length) return { ok: false, missing };
  return { ok: true, config: { appId, configId, graphVersion: META_GRAPH_VERSION } };
}

/** App ID + App Secret para el canje del código. null si falta alguno. */
export function metaAppCredentials(
  env: Record<string, string | undefined> = process.env,
): { appId: string; appSecret: string } | null {
  const appId = read(env, ENV_APP_ID);
  const appSecret = read(env, ENV_APP_SECRET);
  return appId && appSecret ? { appId, appSecret } : null;
}
