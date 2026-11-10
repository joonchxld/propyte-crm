// #993 — El calendario de la cadencia de nuevos tal como estaba en código en la #988.
//
// Solo lo usan las pruebas: es el ORÁCULO de paridad. La siembra de la migración del #993
// (cadencias-def.ts → copilot_cadencia_pasos) evaluada con el motor genérico tiene que dar
// exactamente estos toques para cada país y fuente. No lo importes desde código de la app.
import { cuandoYa, franjaInicial, franjaOpuesta, FRANJA_TEXTO, type Canal, type Pais } from "../cadencia-nuevos";

export type TipoCadencia = "NUEVOS" | "BASE_DE_DATOS";
export type ModoSms = "COMPLEMENTARIO" | "ROBUSTO";
export const ULTIMO_DIA: Record<TipoCadencia, number> = { NUEVOS: 15, BASE_DE_DATOS: 14 };


export interface PerfilCadencia {
  tipo: TipoCadencia;
  pais: Pais;
  /** Fuente del lead (LeadSource): cambia la plantilla del primer WhatsApp. */
  fuente: string | null;
  /** Solo EE. UU.: el lead ya escribió por WhatsApp (Meta bloquea el saliente si no). */
  waAbierto: boolean;
  /** Solo EE. UU.: se decide el día 4. null antes. */
  modoSms: ModoSms | null;
  /** Hora (0–23, Cancún) a la que entró a la cadencia: decide la franja de la L1. */
  horaEntrada: number;
}

export interface ToquePlan {
  /** Único por cadencia: L1…L7, WA1…WA5, CORREO1…CORREO5, SMS1…SMS4, BUZON1, BUZON2. */
  codigo: string;
  canal: Canal;
  dia: number;
  /** Orden dentro del día. */
  orden: number;
  /** Código de la plantilla (copilot_plantillas.codigo). null en las llamadas: llevan guion. */
  plantilla: string | null;
  /** Cuándo hacerlo, en palabras («En menos de 5 min», «Tarde, 16:00–20:00»…). */
  cuando: string;
}

/**
 * Cuándo va cada llamada. La L1 en menos de 5 min; de ahí en adelante se rota la franja
 * (PDF: «L2 tarde (franja opuesta)», «L3 (franja distinta)», «Rotar horario»).
 */
export function cuandoLlamada(n: number, horaEntrada: number): string {
  if (n === 1) return cuandoYa(horaEntrada);
  const f0 = franjaInicial(horaEntrada);
  return FRANJA_TEXTO[n % 2 === 0 ? franjaOpuesta(f0) : f0];
}

/** El WhatsApp puede salir: México, Canadá y otros países siempre; EE. UU. solo si el lead escribió. */
function waPermitido(p: PerfilCadencia): boolean {
  return p.pais !== "US" || p.waAbierto;
}

/** Plantilla del primer WhatsApp según la fuente (Luis, ronda 4, §6). */
export function plantillaPrimerWhatsApp(fuente: string | null, tipo: TipoCadencia): string {
  if (tipo === "BASE_DE_DATOS") return "WA1_BASE_DE_DATOS";
  if (fuente === "SELF_GEN") return "WA1_SELF_GEN";
  if (fuente === "WALK_IN") return "WA1_WALK_IN";
  if (fuente === "EVENTO") return "WA1_EVENTO";
  return "WA1";
}

/** Plantilla del SMS: complementario (con o sin WhatsApp) o robusto. */
function plantillaSms(n: number, p: PerfilCadencia): string {
  if (n === 1) return waPermitido(p) ? "SMS_C1_CON_WA" : "SMS_C1_SIN_WA";
  return p.modoSms === "ROBUSTO" ? `SMS_R${n}` : `SMS_C${n}`;
}

/**
 * Modo de SMS de EE. UU. (PDF: «complementario → robusto si nunca entra a WhatsApp, se decide
 * ~día 4»). Canadá siempre es complementario. México y otros países no llevan SMS.
 */
export function modoSmsDelDia4(pais: Pais, waAbierto: boolean): ModoSms | null {
  if (pais === "CA") return "COMPLEMENTARIO";
  if (pais === "US") return waAbierto ? "COMPLEMENTARIO" : "ROBUSTO";
  return null;
}

/** Días con SMS por modo (PDF, sección 4). El SMS1 del día 1 va en los dos. */
const SMS_POR_DIA: Record<ModoSms, Record<number, number>> = {
  COMPLEMENTARIO: { 1: 1, 6: 2, 12: 3 },
  ROBUSTO: { 1: 1, 4: 2, 8: 3, 13: 4 },
};

/** Las 7 llamadas de la cadencia de nuevos: días 1 (×2), 2, 4, 7, 10 y 13. */
const LLAMADAS_NUEVOS: Record<number, number[]> = { 1: [1, 2], 2: [3], 4: [4], 7: [5], 10: [6], 13: [7] };
/** Otros países: máximo 4 llamadas (Luis, ronda 4, §9), repartidas en los días 1, 4, 7 y 13. */
const LLAMADAS_OTRO_PAIS: Record<number, number[]> = { 1: [1], 4: [4], 7: [5], 13: [7] };
const WHATSAPP_NUEVOS: Record<number, number> = { 1: 1, 4: 2, 7: 3, 10: 4, 13: 5 };
const CORREO_NUEVOS: Record<number, number> = { 2: 1, 5: 2, 8: 3, 11: 4, 15: 5 };

/**
 * Los toques de un día de la cadencia, en el orden en que se hacen. Vacío si el día no tiene
 * toques o ya pasó el último día.
 */
export function toquesDelDia(dia: number, p: PerfilCadencia): ToquePlan[] {
  if (!Number.isInteger(dia) || dia < 1 || dia > ULTIMO_DIA[p.tipo]) return [];
  return p.tipo === "BASE_DE_DATOS" ? toquesBaseDeDatos(dia, p) : toquesNuevos(dia, p);
}

function toquesNuevos(dia: number, p: PerfilCadencia): ToquePlan[] {
  const out: Omit<ToquePlan, "orden">[] = [];
  const masUno = p.pais === "US" || p.pais === "CA";
  const otroPais = p.pais === "OTRO";
  const llamadas = (otroPais ? LLAMADAS_OTRO_PAIS : LLAMADAS_NUEVOS)[dia] ?? [];
  const wa = waPermitido(p) ? WHATSAPP_NUEVOS[dia] : undefined;

  // Otros países: «WhatsApp primero» (ronda 4, §9).
  if (otroPais && wa) out.push(toqueWhatsApp(wa, dia, p, "Antes de la llamada"));

  for (const n of llamadas) {
    out.push({ codigo: `L${n}`, canal: "LLAMADA", dia, plantilla: null, cuando: cuandoLlamada(n, p.horaEntrada) });
    // El WhatsApp va después de la primera llamada del día (PDF, día 1: L1, WA1, SMS1, L2).
    if (!otroPais && wa && n === llamadas[0]) out.push(toqueWhatsApp(wa, dia, p, `Después de la L${n}`));
    if (masUno && dia === 1 && n === llamadas[0]) {
      const sms = smsDelDia(dia, p);
      if (sms) out.push(sms);
    }
    // Buzón de voz: solo +1, tras la L2 (día 1) y la L6 (día 10).
    if (masUno && (n === 2 || n === 6)) {
      out.push({
        codigo: n === 2 ? "BUZON1" : "BUZON2",
        canal: "BUZON",
        dia,
        plantilla: n === 2 ? "BUZON1" : "BUZON2",
        cuando: `Si la L${n} no contesta (menos de 20 s)`,
      });
    }
  }
  // Días con WhatsApp y sin llamada (no pasa en México; queda por si se edita el calendario).
  if (!otroPais && wa && llamadas.length === 0) out.push(toqueWhatsApp(wa, dia, p, "En horario laboral"));
  if (masUno && dia !== 1) {
    const sms = smsDelDia(dia, p);
    if (sms) out.push(sms);
  }

  // Correo: EE. UU. adelanta el Correo 1 al día 1 (a la par).
  const correo = p.pais === "US" ? (dia === 1 ? 1 : dia === 2 ? undefined : CORREO_NUEVOS[dia]) : CORREO_NUEVOS[dia];
  if (correo) {
    out.push({ codigo: `CORREO${correo}`, canal: "CORREO", dia, plantilla: `CORREO${correo}`, cuando: "En horario laboral" });
  }
  return out.map((t, i) => ({ ...t, orden: i + 1 }));
}

function toqueWhatsApp(n: number, dia: number, p: PerfilCadencia, cuando: string): Omit<ToquePlan, "orden"> {
  return {
    codigo: `WA${n}`,
    canal: "WHATSAPP",
    dia,
    plantilla: n === 1 ? plantillaPrimerWhatsApp(p.fuente, p.tipo) : `WA${n}`,
    cuando,
  };
}

function smsDelDia(dia: number, p: PerfilCadencia): Omit<ToquePlan, "orden"> | null {
  if (p.pais !== "US" && p.pais !== "CA") return null;
  // Antes del día 4 (o en Canadá) el modo es complementario.
  const modo: ModoSms = p.pais === "CA" ? "COMPLEMENTARIO" : p.modoSms ?? "COMPLEMENTARIO";
  const n = SMS_POR_DIA[modo][dia];
  if (!n) return null;
  return { codigo: `SMS${n}`, canal: "SMS", dia, plantilla: plantillaSms(n, { ...p, modoSms: modo }), cuando: "Junto con el WhatsApp o la llamada" };
}

/**
 * Base de datos (Luis, ronda 4, §6): WhatsApp el día 1, correo el día 7 y WhatsApp de cierre el día
 * 14; llamada solo a quien responda (y al responder ya sale de la cadencia). A EE. UU. sin WhatsApp
 * se le manda el SMS equivalente.
 */
function toquesBaseDeDatos(dia: number, p: PerfilCadencia): ToquePlan[] {
  const wa = waPermitido(p);
  if (dia === 1) {
    return [
      wa
        ? { codigo: "WA1", canal: "WHATSAPP", dia, orden: 1, plantilla: "WA1_BASE_DE_DATOS", cuando: "En horario laboral" }
        : { codigo: "SMS1", canal: "SMS", dia, orden: 1, plantilla: "SMS_C1_SIN_WA", cuando: "En horario laboral" },
    ];
  }
  if (dia === 7) return [{ codigo: "CORREO2", canal: "CORREO", dia, orden: 1, plantilla: "CORREO2", cuando: "En horario laboral" }];
  if (dia === 14) {
    return [
      wa
        ? { codigo: "WA5", canal: "WHATSAPP", dia, orden: 1, plantilla: "WA5", cuando: "En horario laboral" }
        : { codigo: "SMS4", canal: "SMS", dia, orden: 1, plantilla: "SMS_R4", cuando: "En horario laboral" },
    ];
  }
  return [];
}

/** Todo el calendario (para mostrar lo que falta en la ficha). Usa el modo de SMS que se le pase. */
export function calendarioCompleto(p: PerfilCadencia): ToquePlan[] {
  const out: ToquePlan[] = [];
  for (let d = 1; d <= ULTIMO_DIA[p.tipo]; d++) out.push(...toquesDelDia(d, p));
  return out;
}

