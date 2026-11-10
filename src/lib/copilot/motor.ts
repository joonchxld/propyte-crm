// #993 — Motor de cadencias: convierte la definición (copilot_cadencia_pasos) en los toques de un
// contacto concreto. Lógica pura: lo usan el cron (cadencia-servicio.ts), la ficha y las pruebas.
//
// Reglas:
//   - Un paso aplica si está activo, el país del teléfono está en su lista (vacía = todos) y se
//     cumple su condición de WhatsApp. Se puede escribir por WhatsApp fuera de EE. UU., o en EE. UU.
//     si el lead ya escribió por ahí (Meta bloquea el saliente), y nunca con opt-out de WhatsApp (R5).
//   - Si dos pasos comparten código, gana el primero que aplica (así se expresan las versiones por
//     país del mismo toque: WA1 antes de la llamada en «otro país», después en el resto).
//   - Momento: en DÍAS, el paso aparece al empezar ese día civil de Cancún (el +0 aparece en el
//     ancla misma); en MINUTOS, a la hora exacta (ancla + minutos, que pueden ser negativos).
//   - Un paso que cae en el fin de la cadencia o después no sale.
//   - La plantilla «CODIGO_FUENTE» gana si existe (WA1 → WA1_SELF_GEN para un Self-Gen).
//   - Un paso agregado después (createdAt) no genera toques con momento anterior a su creación.
import { FRANJA_TEXTO, cuandoYa, fechaCancun, franjaInicial, franjaOpuesta, horaCancun, type Canal, type Pais } from "./cadencia-nuevos";
import type { CadenciaDef, PasoDef } from "./cadencias-def";

export interface ContextoContacto {
  pais: Pais;
  /** El lead ya escribió por WhatsApp (solo importa en EE. UU.). */
  waAbierto: boolean;
  whatsappOptOut: boolean;
  /** contacts.fechaRecontacto (AAAA-MM-DD) o null. */
  fechaRecontacto: string | null;
  /** contacts.leadSource, para la plantilla por fuente. */
  fuente: string | null;
}

export interface ToquePlaneado {
  codigo: string;
  canal: Canal;
  orden: number;
  plantilla: string | null;
  cuando: string;
  nota: string | null;
  programadoAt: Date;
  /** Fecha civil de Cancún del toque (AAAA-MM-DD). */
  fecha: string;
  /** Día de la cadencia para mostrar: 1 = el día del ancla. */
  dia: number;
}

const DIA_MS = 86_400_000;

/** Inicio (UTC) del día civil de Cancún: 00:00 en Cancún = 05:00 UTC (sin horario de verano). */
export function inicioDelDiaCancun(fecha: string): Date {
  return new Date(Date.parse(`${fecha}T05:00:00Z`));
}

export function sumarDias(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
}

export function puedeWhatsApp(ctx: Pick<ContextoContacto, "pais" | "waAbierto" | "whatsappOptOut">): boolean {
  if (ctx.whatsappOptOut) return false;
  return ctx.pais !== "US" || ctx.waAbierto;
}

export function pasoAplica(p: PasoDef, ctx: ContextoContacto): boolean {
  if (!p.activo) return false;
  if (p.paises.length > 0 && !p.paises.includes(ctx.pais)) return false;
  const wa = puedeWhatsApp(ctx);
  if (p.whatsapp === "CON_WA" && !wa) return false;
  if (p.whatsapp === "SIN_WA" && wa) return false;
  if (p.ancla === "FECHA_RECONTACTO" && !ctx.fechaRecontacto) return false;
  return true;
}

/** Cuándo cae un paso, o null si depende de una fecha que el contacto no tiene. */
export function programadoDelPaso(p: Pick<PasoDef, "offset" | "unidad" | "ancla">, anclaAt: Date, fechaRecontacto: string | null): Date | null {
  if (p.ancla === "FECHA_RECONTACTO") {
    if (!fechaRecontacto) return null;
    const base = inicioDelDiaCancun(fechaRecontacto);
    return p.unidad === "DIA" ? inicioDelDiaCancun(sumarDias(fechaRecontacto, p.offset)) : new Date(base.getTime() + p.offset * 60_000);
  }
  if (p.unidad === "MIN") return new Date(anclaAt.getTime() + p.offset * 60_000);
  if (p.offset === 0) return anclaAt;
  return inicioDelDiaCancun(sumarDias(fechaCancun(anclaAt), p.offset));
}

/** Fin de la cadencia: el inicio del día N contado desde el ancla (o desde la fecha de recontacto). */
export function finDeCadencia(def: Pick<CadenciaDef, "finDias" | "finAncla">, anclaAt: Date, fechaRecontacto: string | null): Date {
  const base = def.finAncla === "FECHA_RECONTACTO" && fechaRecontacto ? fechaRecontacto : fechaCancun(anclaAt);
  return inicioDelDiaCancun(sumarDias(base, def.finDias));
}

/** «Cuándo» con las marcas resueltas: [YA], [FRANJA] y [FRANJA_OPUESTA], según la hora del ancla. */
export function cuandoTexto(cuando: string, anclaAt: Date): string {
  const h = horaCancun(anclaAt);
  const f0 = franjaInicial(h);
  return cuando
    .replace(/\[YA\]/g, cuandoYa(h))
    .replace(/\[FRANJA_OPUESTA\]/g, FRANJA_TEXTO[franjaOpuesta(f0)])
    .replace(/\[FRANJA\]/g, FRANJA_TEXTO[f0]);
}

/** Plantilla por fuente: «WA1_SELF_GEN» gana a «WA1» si existe. */
export function plantillaParaFuente(plantilla: string | null, fuente: string | null, existentes: ReadonlySet<string>): string | null {
  if (!plantilla || !fuente) return plantilla;
  const propia = `${plantilla}_${fuente}`;
  return existentes.has(propia) ? propia : plantilla;
}

/**
 * Todos los toques de una cadencia para este contacto, en orden de momento y de orden. No filtra
 * por «ya llegó»: eso lo decide quien llama (el cron crea los que ya llegaron; la ficha muestra
 * los que faltan).
 */
export function planDeCadencia(
  def: Pick<CadenciaDef, "finDias" | "finAncla">,
  pasos: readonly PasoDef[],
  ctx: ContextoContacto,
  anclaAt: Date,
  plantillasExistentes: ReadonlySet<string> = new Set(),
): ToquePlaneado[] {
  const fin = finDeCadencia(def, anclaAt, ctx.fechaRecontacto);
  const anclaFecha = fechaCancun(anclaAt);
  const vistos = new Set<string>();
  const out: ToquePlaneado[] = [];
  for (const p of [...pasos].sort((a, b) => a.orden - b.orden)) {
    if (vistos.has(p.codigo) || !pasoAplica(p, ctx)) continue;
    const at = programadoDelPaso(p, anclaAt, ctx.fechaRecontacto);
    if (!at || at.getTime() >= fin.getTime()) continue;
    // Un paso agregado en el módulo no aplica a lo que ya debió salir antes de crearlo.
    const desde = (p as { createdAt?: Date }).createdAt;
    if (desde && at.getTime() < desde.getTime()) continue;
    vistos.add(p.codigo);
    const fecha = fechaCancun(at);
    out.push({
      codigo: p.codigo,
      canal: p.canal,
      orden: p.orden,
      plantilla: plantillaParaFuente(p.plantilla, ctx.fuente, plantillasExistentes),
      cuando: cuandoTexto(p.cuando, anclaAt),
      nota: p.nota,
      programadoAt: at,
      fecha,
      dia: diasEntre(anclaFecha, fecha) + 1,
    });
  }
  return out.sort((a, b) => a.programadoAt.getTime() - b.programadoAt.getTime() || a.orden - b.orden);
}
