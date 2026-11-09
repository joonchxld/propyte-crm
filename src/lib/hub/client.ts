// Cliente del Hub — fuente de verdad del inventario (speckit MAESTRO §2.1, Fase 1).
//
// LECTURA de catálogo: SQL directo al esquema real_estate_hub por la MISMA conexión
// Postgres (igual que el sitio web y el bot del CRM). Decisión de Luis 2026-06-12.
// MUTACIÓN de inventario (hold/release/confirm): REST al Hub con header x-hub-api-key.
//
// El CRM NO escribe catálogo. Esta capa aísla el swap futuro a una API REST de lectura
// (solo habría que reimplementar las funciones list/get sin tocar a los callers).
import {
  listPublishedDevelopments,
  getDevelopmentByIdUngated,
  listPublishedUnits,
  getUnitByIdUngated,
} from "./catalog";
import type { PublishedDevelopment, PublishedUnit } from "./catalog-types";
import type {
  HubDevelopment,
  HubUnit,
  HubHoldResult,
  HubUnitFilters,
  HubDevelopmentFilters,
} from "./types";

// #961: las variables se leen en CADA llamada y por nombre (`env[nombre]`), no una vez al cargar el
// módulo ni con la referencia literal: así basta con ponerlas en el .env del VPS y redesplegar, y el mensaje
// dice cuál falta. Se toleran espacios y comillas pegadas al copiar el valor en el panel.
export const ENV_HUB_BASE = "HUB_API_BASE_URL";
export const ENV_HUB_KEY = "HUB_API_KEY";

function leerVariable(env: Record<string, string | undefined>, nombre: string): string {
  return (env[nombre] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** Configuración del REST del Hub en este momento. `faltan` = nombres vacíos (nunca los valores). */
export function hubApiConfig(env: Record<string, string | undefined> = process.env): {
  base: string;
  key: string;
  faltan: string[];
} {
  const base = leerVariable(env, ENV_HUB_BASE).replace(/\/+$/, "");
  const key = leerVariable(env, ENV_HUB_KEY);
  return { base, key, faltan: [...(base ? [] : [ENV_HUB_BASE]), ...(key ? [] : [ENV_HUB_KEY])] };
}

// ───────────────────────── Lectura (delega en catalog.ts) ─────────────────────────
// El gate público vive en catalog.ts. Aquí solo se adapta al shape legado HubDevelopment /
// HubUnit y se conserva la firma (array / T|null) para no tocar a los callers actuales.
//
// getHubUnit/getHubDevelopment (lookup por ID) usan las variantes *Ungated a propósito:
// resuelven cualquier unidad/desarrollo exista o no en el sitio — el cotizador, shortlists
// y deals resuelven un hubUnitId que el CRM ya posee, aunque la unidad ya se haya vendido.
// list*/search* SÍ llevan el gate público: son listados de descubrimiento (pantalla
// /developments, agente IA), no resolución de un ID que el CRM ya tiene guardado.

function toHubDevelopment(d: PublishedDevelopment): HubDevelopment {
  return {
    id: d.id,
    nombre: d.name,
    zona: d.zone,
    plaza: d.city,
    status: d.stage,
    precioMin: d.priceMinMxn,
    precioMax: d.priceMaxMxn,
    moneda: d.currency ?? "MXN",
  };
}

function toHubUnit(u: PublishedUnit): HubUnit {
  return {
    id: u.id,
    developmentId: u.developmentId,
    numero: u.unitNumber,
    titulo: u.title,
    tipo: u.unitType,
    tipologia: u.typology,
    recamaras: u.bedrooms,
    banos: u.bathrooms,
    m2Construccion: u.builtAreaM2,
    m2Total: u.areaM2,
    precioMxn: u.priceMxn,
    precioUsd: u.priceUsd,
    moneda: u.currency ?? "MXN",
    status: u.status,
  };
}

export async function listHubDevelopments(
  filters: HubDevelopmentFilters = {}
): Promise<HubDevelopment[]> {
  const { data } = await listPublishedDevelopments({
    search: filters.search ?? null,
    zone: filters.zone ?? null,
    priceMin: filters.budgetMin ?? null,
    priceMax: filters.budgetMax ?? null,
    limit: filters.limit ?? 100,
  });
  return data.map(toHubDevelopment);
}

export async function getHubDevelopment(id: string): Promise<HubDevelopment | null> {
  const { data } = await getDevelopmentByIdUngated(id);
  return data ? toHubDevelopment(data) : null;
}

export async function listHubUnits(filters: HubUnitFilters = {}): Promise<HubUnit[]> {
  // onlyAvailable se resuelve en SQL (catalog.ts), ANTES del LIMIT. Antes se filtraba
  // aquí en JS después de traer `limit` filas ya ordenadas por unit_number — si las
  // unidades disponibles no caían en esa primera ventana, se perdían en silencio pese
  // a existir (ej. /api/hub/units?limit=20 desde el deal form).
  const { data } = await listPublishedUnits({
    developmentId: filters.developmentId ?? null,
    search: filters.search ?? null,
    onlyAvailable: filters.onlyAvailable ?? null,
    limit: filters.limit ?? 200,
  });
  return data.map(toHubUnit);
}

export async function getHubUnit(id: string): Promise<HubUnit | null> {
  const { data } = await getUnitByIdUngated(id);
  return data ? toHubUnit(data) : null;
}

// ───────────────────── Mutación de inventario (REST al Hub) ─────────────────────

async function hubInventoryPost(path: string, body: Record<string, unknown>): Promise<HubHoldResult> {
  const { base, key, faltan } = hubApiConfig();
  if (faltan.length) {
    return { ok: false, motivo: "sin_configurar", error: `Hub API no configurada: el servidor no tiene ${faltan.join(" ni ")}` };
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const json = (await res.json().catch(() => ({}))) as HubHoldResult;
    if (!res.ok) {
      // 401/403 = la clave no es la del Hub; 404/405 = la URL no lleva a la ruta de inventario. Eso es
      // configuración, no la unidad: se puede apartar de respaldo. El resto de 4xx es el Hub diciendo
      // que no (unidad ocupada, 409) y se respeta.
      const motivo =
        res.status >= 500 ? "sin_respuesta" : [401, 403, 404, 405].includes(res.status) ? "mal_configurado" : "rechazo";
      const pista =
        res.status === 401 || res.status === 403
          ? " (revisa HUB_API_KEY: tiene que ser la HUB_INTERNAL_API_KEY del Hub)"
          : res.status === 404 || res.status === 405
            ? " (revisa HUB_API_BASE_URL)"
            : "";
      return { ok: false, motivo, error: `${json?.error ?? `Hub respondió ${res.status}`}${pista}` };
    }
    return { ...json, ok: true };
  } catch (err) {
    return { ok: false, motivo: "sin_respuesta", error: err instanceof Error ? err.message : "Error de red con el Hub" };
  }
}

/** Solicita hold de una unidad en el Hub (atomicidad la garantiza el Hub). */
export function requestUnitHold(args: { hubUnitId: string; crmDealId: string; ttlHours?: number }): Promise<HubHoldResult> {
  return hubInventoryPost(`/api/inventory/units/${args.hubUnitId}/hold`, {
    crmDealId: args.crmDealId,
    ttlHours: args.ttlHours ?? 72,
  });
}

/** Libera un hold de unidad en el Hub. */
export function releaseUnitHold(args: { hubUnitId: string; crmDealId: string }): Promise<HubHoldResult> {
  return hubInventoryPost(`/api/inventory/units/${args.hubUnitId}/release`, { crmDealId: args.crmDealId });
}

/** Confirma la venta de una unidad en el Hub. */
export function confirmUnitHold(args: { hubUnitId: string; crmDealId: string }): Promise<HubHoldResult> {
  return hubInventoryPost(`/api/inventory/units/${args.hubUnitId}/confirm`, { crmDealId: args.crmDealId });
}
