// #988 / #993 — Copilot fase 1: lo común a todas las cadencias (país del teléfono, franjas, días en
// Cancún, resultados, orden de «Mi día»). El calendario de cada cadencia ya no vive en código: está
// en el catálogo (módulo Cadencias, cadencias-def.ts) y lo evalúa motor.ts.
//
// Historia (#988): la cadencia de nuevos (Nuevo → Sin respuesta, 15 días).
//
// Fuente: «Cadencia Multicanal — Resumen Operativo» (PDF de Luis, 29-oct), páginas 1, 4 y 5. Lo
// que el PDF no trae sale de las respuestas de Luis (rondas 3 y 4, 02-nov):
//   - una sola tarea por contacto y por día, con los toques de ese día adentro (ronda 4, §5);
//   - los números de otros países llevan la versión México: sin SMS, WhatsApp primero y máximo 4
//     llamadas (ronda 4, §9);
//   - Base de datos lleva una cadencia ligera de 14 días: WhatsApp el día 1, correo el día 7 y
//     WhatsApp de cierre el día 14 (ronda 4, §6);
//   - tope de 40 tareas al día y orden calientes → nuevos en su tiempo → tibios → fríos (ronda 3).
//
// Fase 1 (sistemas@, 02-nov): Copilot NO envía nada. Cada toque es una tarea del asesor con el
// texto listo y el asesor marca el resultado.
//
// Lógica pura: sin Prisma ni React, para que la importen servidor, cliente y pruebas.

export type Canal = "LLAMADA" | "WHATSAPP" | "SMS" | "CORREO" | "BUZON" | "MISMO_CANAL";
export type Pais = "MX" | "US" | "CA" | "OTRO";
export type Franja = "MANANA" | "TARDE";

export const CANAL_LABELS: Record<Canal, string> = {
  LLAMADA: "Llamada",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  CORREO: "Correo",
  BUZON: "Buzón de voz",
  MISMO_CANAL: "Mismo canal",
};

/** Tope de tareas que se le muestran al asesor en «Mi día» (Luis, ronda 3). */
export const TOPE_TAREAS_DIA = 40;

/** Una tarea sin marcar se pone en rojo y avisa al gerente a las 24 h (sistemas@, 05-nov). */
export const VENCIDA_MS = 24 * 3_600_000;

// ───────────────────────────── país del teléfono ─────────────────────────────

/** Ladas de Canadá dentro del +1 (NANP). El resto del +1 es EE. UU. salvo el Caribe. */
const LADAS_CANADA = new Set([
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368",
  "382", "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519",
  "548", "579", "581", "584", "587", "600", "604", "613", "639", "647", "672", "683", "705", "709",
  "742", "753", "778", "780", "782", "807", "819", "825", "867", "873", "879", "902", "905",
]);
/** Países del Caribe con +1 que no son EE. UU. ni Canadá: llevan la versión México («otro país»). */
const LADAS_CARIBE = new Set([
  "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767",
  "784", "809", "829", "849", "868", "869", "876",
]);

/**
 * País de la cadencia a partir del teléfono ya normalizado (E.164). Sin teléfono se toma México:
 * el calendario es el mismo y los toques de teléfono salen como «sin teléfono».
 */
export function paisDeTelefono(e164: string | null | undefined): Pais {
  const s = (e164 ?? "").trim();
  if (!s.startsWith("+")) return "MX";
  if (s.startsWith("+52")) return "MX";
  const nanp = s.match(/^\+1(\d{3})\d{7}$/);
  if (nanp) {
    if (LADAS_CANADA.has(nanp[1])) return "CA";
    if (LADAS_CARIBE.has(nanp[1])) return "OTRO";
    return "US";
  }
  return "OTRO";
}

export const PAIS_LABELS: Record<Pais, string> = {
  MX: "México",
  US: "Estados Unidos",
  CA: "Canadá",
  OTRO: "Otro país",
};

// ───────────────────────────── franjas ─────────────────────────────
// El calendario de cada cadencia ya no vive aquí (#993): está en la base (copilot_cadencia_pasos),
// se edita en el módulo Cadencias y lo evalúa motor.ts. Lo que sigue lo usan el motor y la UI.

export const FRANJA_TEXTO: Record<Franja, string> = {
  MANANA: "Mañana, 9:00–13:00 (hora del lead)",
  TARDE: "Tarde, 16:00–20:00 (hora del lead)",
};

export function franjaOpuesta(f: Franja): Franja {
  return f === "MANANA" ? "TARDE" : "MANANA";
}

/** Franja de la L1 según la hora de entrada: antes de las 14:00 es la mañana. */
export function franjaInicial(horaEntrada: number): Franja {
  return horaEntrada < 14 ? "MANANA" : "TARDE";
}

/** «En menos de 5 min», o «a primera hora» si el lead entró fuera de 9:00–20:00. */
export function cuandoYa(horaEntrada: number): string {
  if (horaEntrada >= 9 && horaEntrada < 20) return "En menos de 5 min desde que entró";
  return "A primera hora (entró fuera del horario de 9:00 a 20:00)";
}

// ───────────────────────────── días ─────────────────────────────

const DIA_MS = 86_400_000;
/** Cancún está en UTC−5 todo el año (sin horario de verano desde 2015). */
const CANCUN_OFFSET_MS = -5 * 3_600_000;

/** Fecha civil de Cancún (AAAA-MM-DD) de un instante. */
export function fechaCancun(d: Date): string {
  return new Date(d.getTime() + CANCUN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Hora (0–23) de Cancún de un instante. */
export function horaCancun(d: Date): number {
  return new Date(d.getTime() + CANCUN_OFFSET_MS).getUTCHours();
}

/** Número de día de la cadencia (1 = el día en que entró), contado en días civiles de Cancún. */
export function diaDeCadencia(diaInicio: string, ahora: Date): number {
  const a = Date.parse(`${diaInicio}T00:00:00Z`);
  const b = Date.parse(`${fechaCancun(ahora)}T00:00:00Z`);
  return Math.floor((b - a) / DIA_MS) + 1;
}

/** Fecha civil del día N de la cadencia. */
export function fechaDelDia(diaInicio: string, dia: number): string {
  return new Date(Date.parse(`${diaInicio}T00:00:00Z`) + (dia - 1) * DIA_MS).toISOString().slice(0, 10);
}

// ───────────────────────────── resultados ─────────────────────────────

export type Resultado =
  | "CONTESTO"
  | "NO_CONTESTO"
  | "DEJADO"
  | "ENVIADO"
  | "RESPONDIO"
  | "NO_SE_PUDO"
  | "NO_HECHO"
  | "EXPIRADO";

export const RESULTADO_LABELS: Record<Resultado, string> = {
  CONTESTO: "Contestó una persona",
  NO_CONTESTO: "No contestó",
  DEJADO: "Lo dejé",
  ENVIADO: "Enviado",
  RESPONDIO: "Respondió",
  NO_SE_PUDO: "No se pudo",
  NO_HECHO: "No se hizo",
  EXPIRADO: "Expiró",
};

/** Lo que el asesor puede marcar en cada canal. NO_HECHO y EXPIRADO los pone el sistema. */
export const RESULTADOS_POR_CANAL: Record<Canal, readonly Resultado[]> = {
  LLAMADA: ["CONTESTO", "NO_CONTESTO", "NO_SE_PUDO"],
  WHATSAPP: ["ENVIADO", "RESPONDIO", "NO_SE_PUDO"],
  SMS: ["ENVIADO", "RESPONDIO", "NO_SE_PUDO"],
  CORREO: ["ENVIADO", "RESPONDIO", "NO_SE_PUDO"],
  BUZON: ["DEJADO", "NO_SE_PUDO"],
  MISMO_CANAL: ["ENVIADO", "RESPONDIO", "NO_SE_PUDO"],
};

export function esResultadoDelCanal(canal: string, r: unknown): r is Resultado {
  const lista = (RESULTADOS_POR_CANAL as Record<string, readonly string[]>)[canal];
  return !!lista && typeof r === "string" && lista.includes(r);
}

/**
 * Respuesta del lead: pausa la cadencia y pasa a Contactado (PDF: «se pausa al primer "responde"
 * por cualquier canal; una llamada conectada cuenta»). El buzón no es respuesta.
 */
export function esRespuesta(r: string | null | undefined): boolean {
  return r === "CONTESTO" || r === "RESPONDIO";
}

/** Un intento de contacto: mueve Nuevo → Sin respuesta (flujograma: «justo después de la primera actividad»). */
export function esIntento(r: string | null | undefined): boolean {
  return r === "NO_CONTESTO" || r === "DEJADO" || r === "ENVIADO";
}

// ───────────────────────────── «Mi día» ─────────────────────────────

export interface TareaParaOrdenar {
  /** contact_temperaturas.orden (0 Caliente … 40 Muerto); null si aún no se calcula. */
  ordenTemperatura: number | null;
  dia: number;
  fecha: string;
  /** Tiene la L1 pendiente: es un nuevo dentro de su tiempo. */
  l1Pendiente: boolean;
  inicio: Date | string;
}

/**
 * Orden de «Mi día» (Luis, ronda 3): calientes → nuevos dentro de su tiempo (L1 pendiente) → el
 * resto por temperatura (Tibio A, Tibio B, Frío). Dentro del mismo grupo, primero lo más atrasado.
 * «Una tarea caliente nunca queda detrás de una fría.»
 */
export function compararTareas(a: TareaParaOrdenar, b: TareaParaOrdenar): number {
  const grupo = (t: TareaParaOrdenar) => (t.ordenTemperatura === 0 ? 0 : t.l1Pendiente ? 1 : 2);
  const g = grupo(a) - grupo(b);
  if (g !== 0) return g;
  const ta = a.ordenTemperatura ?? 25;
  const tb = b.ordenTemperatura ?? 25;
  if (ta !== tb) return ta - tb;
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
  return new Date(b.inicio).getTime() - new Date(a.inicio).getTime();
}

/** Vencida: lleva 24 h o más sin marcar desde que apareció en «Mi día». */
export function estaVencida(creadoAt: Date | string, ahora: Date): boolean {
  return ahora.getTime() - new Date(creadoAt).getTime() >= VENCIDA_MS;
}

// ───────────────────────────── a quién aplica ─────────────────────────────

/** Tipos de contacto que no llevan la cadencia de compradores. Paridad con el SQL: cadencia-nuevos.test.ts. */
export const TIPOS_SIN_CADENCIA = ["BROKER_EXTERNO", "EMPLEO", "PROVEEDOR", "LEAD_VENDEDOR", "OTRO"] as const;
/**
 * Flujos que no son de un comprador: vendedor, captación de desarrolladores, broker, inmobiliaria y
 * empleo. F2, F4 y F5 sí son de compra (Luis, ronda 4, §2 y §10) y los llevan igual que «Sin flujo».
 */
export const FLUJOS_SIN_CADENCIA = [
  "F1_CORRETAJE_VENDEDOR",
  "F3_CAPTACION_MB",
  "F6_BROKER",
  "F7_INMOBILIARIA",
  "F8_EMPLEO",
] as const;
