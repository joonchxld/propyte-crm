// #993 — Las cadencias de Copilot como datos: el módulo «Cadencias» (Desempeño) las muestra y las
// edita, y Copilot las sigue. Viven en la base:
//   - propyte_crm.copilot_cadencia_defs: una fila por cadencia (tipo);
//   - propyte_crm.copilot_cadencia_pasos: sus toques.
//
// Aquí van los tipos, las reglas de validación y CADENCIAS_INICIALES: la siembra de la migración
// 2026-11-09-cadencias-por-rama.sql (generada con sqlDeSiembra(); la prueba cadencias-def.test.ts
// comprueba que el archivo trae exactamente esto). Fuentes:
//   - Cadencia General (NUEVOS, BASE_DE_DATOS): PDF «Cadencia Multicanal» y #988, paso por paso
//     igual que el calendario que estaba en código (prueba de paridad con el motor).
//   - Ramas: PDF «Copilot · Cadencias por Rama» (Luis, 09-nov), secciones 3 y 5.
//
// Lógica pura: sin Prisma ni React.
import type { Canal, Pais } from "./cadencia-nuevos";

/** DIA = días civiles después del ancla (aparece al empezar el día); MIN = minutos exactos. */
export type Unidad = "DIA" | "MIN";
/** Desde dónde se cuenta el paso: el ancla de la cadencia, o la fecha de recontacto del contacto. */
export type AnclaPaso = "CADENCIA" | "FECHA_RECONTACTO";
/** SIEMPRE · CON_WA = solo si se le puede escribir por WhatsApp · SIN_WA = solo si no. */
export type CondicionWhatsApp = "SIEMPRE" | "CON_WA" | "SIN_WA";
/** Qué momento es el ancla al inscribir (informativo y para encadenar). */
export type AnclaCadencia = "ALTA" | "RESPUESTA" | "CLASIFICACION" | "FIN_CADENCIA" | "ULTIMO_INBOUND";

export const CANALES: readonly Canal[] = ["LLAMADA", "WHATSAPP", "SMS", "CORREO", "BUZON", "MISMO_CANAL"];
export const PAISES: readonly Pais[] = ["MX", "US", "CA", "OTRO"];

export interface PasoDef {
  id?: string;
  /** Único por cadencia en los toques. Dos pasos pueden compartir código si sus condiciones se excluyen: gana el primero que aplica. */
  codigo: string;
  canal: Canal;
  offset: number;
  unidad: Unidad;
  ancla: AnclaPaso;
  /** Código en copilot_plantillas. null = sin texto (llamadas). Si existe «CODIGO_FUENTE» (p. ej. WA1_SELF_GEN), se usa esa. */
  plantilla: string | null;
  /** Vacío = todos los países. */
  paises: Pais[];
  whatsapp: CondicionWhatsApp;
  /** Cuándo hacerlo, en palabras. Acepta [YA], [FRANJA] y [FRANJA_OPUESTA]. */
  cuando: string;
  /** Aviso para el asesor («Solo si contestó sin horario»). */
  nota: string | null;
  orden: number;
  activo: boolean;
}

export interface FinDeCadencia {
  /** Estado al que pasa el contacto al vencer el plazo sin respuesta (solo si sigue en un estado de la cadencia). */
  estado: string | null;
  subestado: string | null;
  razon: string | null;
  /** Cadencia en la que entra después. */
  siguiente: string | null;
}

export interface CadenciaDef {
  tipo: string;
  nombre: string;
  /** Rama del PDF: «General», «A · Interesado»… */
  rama: string;
  descripcion: string;
  /** Texto para el módulo: cuándo entra un contacto. */
  disparador: string;
  anclaTipo: AnclaCadencia;
  /** Estados del contacto en los que la cadencia sigue viva. Si sale de ellos, termina. */
  estados: string[];
  /** Una respuesta del lead detiene la cadencia y pide clasificarla. */
  respuestaTermina: boolean;
  /** Una cita creada termina la cadencia (Rama A). */
  terminaConCita: boolean;
  /** Sigue aunque el contacto tenga «No contactar» (solo la confirmación de baja). */
  ignoraNoContactar: boolean;
  /** Días de plazo, contados desde el ancla o desde la fecha de recontacto. */
  finDias: number;
  finAncla: AnclaPaso;
  fin: FinDeCadencia;
  activa: boolean;
  orden: number;
  pasos: PasoDef[];
}

/** Cadencias «generales»: las inscribe el disparador al llegar a Nuevo / Sin respuesta. */
export const TIPOS_GENERALES = ["NUEVOS", "BASE_DE_DATOS"] as const;
export function esGeneral(tipo: string): boolean {
  return (TIPOS_GENERALES as readonly string[]).includes(tipo);
}

// ───────────────────────────── validación ─────────────────────────────

export type ErrorPaso = string;

/** Revisa un paso antes de guardarlo. Devuelve los errores en palabras, o [] si está bien. */
export function validarPaso(p: Partial<PasoDef>): ErrorPaso[] {
  const e: string[] = [];
  if (!p.codigo || !/^[A-Z0-9_]{1,20}$/.test(p.codigo)) e.push("El código va en mayúsculas, números o guion bajo (hasta 20).");
  if (!p.canal || !CANALES.includes(p.canal)) e.push("Canal inválido.");
  if (p.unidad !== "DIA" && p.unidad !== "MIN") e.push("La unidad es días o minutos.");
  if (typeof p.offset !== "number" || !Number.isInteger(p.offset)) e.push("El momento tiene que ser un número entero.");
  else if (p.unidad === "DIA" && (p.offset < 0 || p.offset > 730)) e.push("En días va de 0 a 730.");
  else if (p.unidad === "MIN" && (p.offset < -10_080 || p.offset > 525_600)) e.push("En minutos va de −10,080 (una semana antes) a 525,600 (un año).");
  if (p.ancla !== "CADENCIA" && p.ancla !== "FECHA_RECONTACTO") e.push("Ancla inválida.");
  if (p.whatsapp && !["SIEMPRE", "CON_WA", "SIN_WA"].includes(p.whatsapp)) e.push("Condición de WhatsApp inválida.");
  if (p.paises && p.paises.some((x) => !PAISES.includes(x))) e.push("País inválido.");
  if (!p.cuando || !p.cuando.trim()) e.push("Falta «cuándo».");
  if (p.canal && p.canal !== "LLAMADA" && !p.plantilla) e.push("Los mensajes necesitan una plantilla.");
  return e;
}

/** Texto corto del momento de un paso: «+0», «+2 h», «día 4», «T−24 h», «fecha de recontacto +5 d». */
export function momentoDelPaso(p: Pick<PasoDef, "offset" | "unidad" | "ancla">): string {
  const base = p.ancla === "FECHA_RECONTACTO" ? "Fecha de recontacto " : "";
  if (p.unidad === "DIA") return `${base}${p.offset >= 0 ? "+" : "−"}${Math.abs(p.offset)} d`;
  const m = Math.abs(p.offset);
  const s = p.offset >= 0 ? "+" : "−";
  if (m % 1440 === 0 && m > 0) return `${base}${s}${m / 1440} d`;
  if (m % 60 === 0 && m > 0) return `${base}${s}${m / 60} h`;
  return `${base}${s}${m} min`;
}

// ───────────────────────────── siembra ─────────────────────────────

let orden = 0;
function paso(
  codigo: string,
  canal: Canal,
  offset: number,
  plantilla: string | null,
  cuando: string,
  extra: Partial<Pick<PasoDef, "unidad" | "ancla" | "paises" | "whatsapp" | "nota" | "activo">> = {},
): PasoDef {
  orden += 10;
  return {
    codigo,
    canal,
    offset,
    unidad: extra.unidad ?? "DIA",
    ancla: extra.ancla ?? "CADENCIA",
    plantilla,
    paises: extra.paises ?? [],
    whatsapp: extra.whatsapp ?? (canal === "WHATSAPP" ? "CON_WA" : "SIEMPRE"),
    cuando,
    nota: extra.nota ?? null,
    orden,
    activo: extra.activo ?? true,
  };
}
function reinicia(): void {
  orden = 0;
}

const MX_US_CA: Pais[] = ["MX", "US", "CA"];
const MAS_UNO: Pais[] = ["US", "CA"];
const SOLO_US: Pais[] = ["US"];
const OTRO: Pais[] = ["OTRO"];
const SMS_JUNTO = "Junto con el WhatsApp o la llamada";
const HORARIO = "En horario laboral";
const ESTADOS_SALIDA = ["PERDIDO", "CONTACTADO_PERDIDO", "NEGOCIO_PERDIDO"];

function pasosNuevos(): PasoDef[] {
  reinicia();
  return [
    // Día 1 (+0): L1 en menos de 5 min · WA1 · SMS1 (+1) · L2 franja opuesta · Buzón 1 (+1) · EE. UU.: Correo 1.
    paso("WA1", "WHATSAPP", 0, "WA1", "Antes de la llamada", { paises: OTRO }),
    paso("L1", "LLAMADA", 0, null, "[YA]"),
    paso("WA1", "WHATSAPP", 0, "WA1", "Después de la L1", { paises: MX_US_CA }),
    paso("SMS1", "SMS", 0, "SMS_C1_CON_WA", SMS_JUNTO, { paises: MAS_UNO, whatsapp: "CON_WA" }),
    paso("SMS1", "SMS", 0, "SMS_C1_SIN_WA", SMS_JUNTO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("L2", "LLAMADA", 0, null, "[FRANJA_OPUESTA]", { paises: MX_US_CA }),
    paso("BUZON1", "BUZON", 0, "BUZON1", "Si la L2 no contesta (menos de 20 s)", { paises: MAS_UNO }),
    paso("CORREO1", "CORREO", 0, "CORREO1", HORARIO, { paises: SOLO_US }),
    // Día 2: L3 · Correo 1 (fuera de EE. UU.).
    paso("L3", "LLAMADA", 1, null, "[FRANJA]", { paises: MX_US_CA }),
    paso("CORREO1", "CORREO", 1, "CORREO1", HORARIO, { paises: ["MX", "CA", "OTRO"] }),
    // Día 4: L4 · WA2 · EE. UU. sin WhatsApp: SMS2 robusto.
    paso("WA2", "WHATSAPP", 3, "WA2", "Antes de la llamada", { paises: OTRO }),
    paso("L4", "LLAMADA", 3, null, "[FRANJA_OPUESTA]"),
    paso("WA2", "WHATSAPP", 3, "WA2", "Después de la L4", { paises: MX_US_CA }),
    paso("SMS2", "SMS", 3, "SMS_R2", SMS_JUNTO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    // Día 5: Correo 2.
    paso("CORREO2", "CORREO", 4, "CORREO2", HORARIO),
    // Día 6: SMS2 complementario (+1 con WhatsApp).
    paso("SMS2", "SMS", 5, "SMS_C2", SMS_JUNTO, { paises: MAS_UNO, whatsapp: "CON_WA" }),
    // Día 7: L5 · WA3.
    paso("WA3", "WHATSAPP", 6, "WA3", "Antes de la llamada", { paises: OTRO }),
    paso("L5", "LLAMADA", 6, null, "[FRANJA]"),
    paso("WA3", "WHATSAPP", 6, "WA3", "Después de la L5", { paises: MX_US_CA }),
    // Día 8: SMS3 robusto · Correo 3.
    paso("SMS3", "SMS", 7, "SMS_R3", SMS_JUNTO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("CORREO3", "CORREO", 7, "CORREO3", HORARIO),
    // Día 10: L6 · WA4 · Buzón 2 (+1).
    paso("WA4", "WHATSAPP", 9, "WA4", "Antes de la llamada", { paises: OTRO }),
    paso("L6", "LLAMADA", 9, null, "[FRANJA_OPUESTA]", { paises: MX_US_CA }),
    paso("WA4", "WHATSAPP", 9, "WA4", "Después de la L6", { paises: MX_US_CA }),
    paso("BUZON2", "BUZON", 9, "BUZON2", "Si la L6 no contesta (menos de 20 s)", { paises: MAS_UNO }),
    // Día 11: Correo 4.
    paso("CORREO4", "CORREO", 10, "CORREO4", HORARIO),
    // Día 12: SMS3 complementario.
    paso("SMS3", "SMS", 11, "SMS_C3", SMS_JUNTO, { paises: MAS_UNO, whatsapp: "CON_WA" }),
    // Día 13: L7 · WA5 · SMS4 robusto.
    paso("WA5", "WHATSAPP", 12, "WA5", "Antes de la llamada", { paises: OTRO }),
    paso("L7", "LLAMADA", 12, null, "[FRANJA]"),
    paso("WA5", "WHATSAPP", 12, "WA5", "Después de la L7", { paises: MX_US_CA }),
    paso("SMS4", "SMS", 12, "SMS_R4", SMS_JUNTO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    // Día 15: Correo 5.
    paso("CORREO5", "CORREO", 14, "CORREO5", HORARIO),
  ];
}

function pasosBaseDeDatos(): PasoDef[] {
  reinicia();
  return [
    paso("WA1", "WHATSAPP", 0, "WA1_BASE_DE_DATOS", HORARIO),
    paso("SMS1", "SMS", 0, "SMS_C1_SIN_WA", HORARIO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("CORREO2", "CORREO", 6, "CORREO2", HORARIO),
    paso("WA5", "WHATSAPP", 13, "WA5", HORARIO),
    paso("SMS4", "SMS", 13, "SMS_R4", HORARIO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
  ];
}

function pasosAgendar(): PasoDef[] {
  reinicia();
  return [
    paso("A1", "MISMO_CANAL", 0, "R_A1", "En menos de 5 min desde que respondió", { unidad: "MIN" }),
    paso("A2", "MISMO_CANAL", 120, "R_A2", "2 h después de la respuesta", {
      unidad: "MIN",
      nota: "Solo si contestó las preguntas pero no eligió horario; si no, márcalo «No se pudo».",
    }),
    paso("A3L", "LLAMADA", 1, null, "[FRANJA]"),
    paso("A3", "WHATSAPP", 1, "R_A3", "Si la llamada no contesta"),
    paso("A3", "SMS", 1, "R_A3", "Si la llamada no contesta", { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("A4", "CORREO", 2, "R_A4", HORARIO),
    paso("A5", "WHATSAPP", 4, "R_A5", HORARIO),
    paso("A5", "SMS", 4, "R_A5", HORARIO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
  ];
}

function pasosGhosting(): PasoDef[] {
  reinicia();
  return [
    paso("C2A", "MISMO_CANAL", 2, "R_C2a", "Por el canal donde habló"),
    paso("C2L", "LLAMADA", 4, null, "[FRANJA]"),
    paso("C2BZ", "BUZON", 4, "BUZON2", "Si la llamada no contesta (máximo 1)", { paises: MAS_UNO, activo: false }),
    paso("C2B", "CORREO", 7, "R_C2b", HORARIO),
    paso("C2C", "WHATSAPP", 10, "R_C2c", HORARIO),
    paso("C2C", "SMS", 10, "R_C2c", HORARIO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("C2D", "CORREO", 14, "R_C2d", HORARIO),
    paso("C2DW", "WHATSAPP", 14, "R_C2d", HORARIO),
  ];
}

function pasosReperfilar(): PasoDef[] {
  reinicia();
  return [
    paso("B3A", "MISMO_CANAL", 0, "R_B3a", "En menos de 5 min desde que respondió", { unidad: "MIN" }),
    paso("B3B", "CORREO", 3, "R_B3b", HORARIO),
  ];
}

function pasosPospuso(): PasoDef[] {
  reinicia();
  return [
    paso("B2A", "MISMO_CANAL", 0, "R_B2a", "Al clasificar", { unidad: "MIN" }),
    paso("B2B", "CORREO", 90, "R_B2b", HORARIO, { nota: "Solo sale si la fecha de recontacto todavía no llega." }),
    paso("B2B2", "CORREO", 180, "R_B2b", HORARIO, { nota: "Solo sale si la fecha de recontacto todavía no llega." }),
    paso("B2C", "WHATSAPP", 0, "R_B2c", "El día que pidió", { ancla: "FECHA_RECONTACTO" }),
    paso("B2C", "SMS", 0, "R_B2c", "El día que pidió", { ancla: "FECHA_RECONTACTO", paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("B2CC", "CORREO", 0, "R_B2c", "El día que pidió", { ancla: "FECHA_RECONTACTO" }),
    paso("B2L", "LLAMADA", 5, null, "[FRANJA]", { ancla: "FECHA_RECONTACTO", nota: "Solo si aceptó retomarlo." }),
  ];
}

function pasosNutricion(): PasoDef[] {
  reinicia();
  return [
    paso("C1A", "CORREO", 15, "R_C1a", HORARIO),
    paso("C1B", "CORREO", 45, "R_C1b", HORARIO),
    paso("C1C", "WHATSAPP", 75, "R_C1c", HORARIO),
    paso("C1C", "SMS", 75, "R_C1c", HORARIO, { paises: SOLO_US, whatsapp: "SIN_WA" }),
    paso("C1CC", "CORREO", 75, "R_C1c", HORARIO),
    // PDF: «+77 d · llamada 1 int. (solo si hubo apertura/clic)». El CRM todavía no mide aperturas
    // de correo (decisión pendiente, sección 8): queda apagada; se enciende desde el módulo.
    paso("C1L", "LLAMADA", 77, null, "[FRANJA]", { nota: "Solo si abrió el correo o dio clic.", activo: false }),
    paso("C1A2", "CORREO", 105, "R_C1a", HORARIO, { nota: "Con un dato nuevo." }),
    paso("C1B2", "CORREO", 135, "R_C1b", HORARIO, { nota: "Con un dato nuevo." }),
    paso("C1D", "CORREO", 165, "R_C1d", HORARIO),
  ];
}

function pasosUnico(codigo: string, plantilla: string): PasoDef[] {
  reinicia();
  return [paso(codigo, "MISMO_CANAL", 0, plantilla, "Al clasificar", { unidad: "MIN" })];
}

const SIN_FIN: FinDeCadencia = { estado: null, subestado: null, razon: null, siguiente: null };

export const CADENCIAS_INICIALES: CadenciaDef[] = [
  {
    tipo: "NUEVOS",
    nombre: "Cadencia de nuevos",
    rama: "General",
    descripcion: "Primer contacto: 7 llamadas, 5 WhatsApp, 5 correos, y SMS y buzón para +1 (PDF «Cadencia Multicanal»).",
    disparador: "Alta en Nuevo o Sin respuesta, o llega a uno de esos dos estados desde otro.",
    anclaTipo: "ALTA",
    estados: ["NUEVO", "SIN_RESPUESTA"],
    respuestaTermina: true,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 15,
    finAncla: "CADENCIA",
    fin: { estado: "PERDIDO", subestado: null, razon: "SIN_RESPUESTA_TRAS_CADENCIA", siguiente: "NUTRICION" },
    activa: true,
    orden: 10,
    pasos: pasosNuevos(),
  },
  {
    tipo: "BASE_DE_DATOS",
    nombre: "Cadencia ligera (Base de datos)",
    rama: "General",
    descripcion: "Leads de Base de datos: WhatsApp el día 1, correo el día 7 y cierre el día 14 (Luis, ronda 4).",
    disparador: "Como la de nuevos, cuando la fuente es Base de datos.",
    anclaTipo: "ALTA",
    estados: ["NUEVO", "SIN_RESPUESTA"],
    respuestaTermina: true,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 14,
    finAncla: "CADENCIA",
    fin: { estado: "PERDIDO", subestado: null, razon: "SIN_RESPUESTA_TRAS_CADENCIA", siguiente: "NUTRICION" },
    activa: true,
    orden: 20,
    pasos: pasosBaseDeDatos(),
  },
  {
    tipo: "AGENDAR",
    nombre: "Agendar cita",
    rama: "A · Interesado",
    descripcion: "El lead quiere ver opciones: dos preguntas de perfil y dos horarios hasta tener la cita.",
    disparador: "El asesor clasifica la respuesta como «Interesado».",
    anclaTipo: "RESPUESTA",
    estados: ["CONTACTADO"],
    respuestaTermina: false,
    terminaConCita: true,
    ignoraNoContactar: false,
    finDias: 5,
    finAncla: "CADENCIA",
    fin: { estado: null, subestado: null, razon: null, siguiente: "GHOSTING" },
    activa: true,
    orden: 30,
    pasos: pasosAgendar(),
  },
  {
    tipo: "GHOSTING",
    nombre: "Dejó de responder",
    rama: "C2 · Ghosting",
    descripcion: "Respondió y desapareció. En esta entrega solo entra al terminar «Agendar cita» sin cita (la detección a las 48 h es la fase 2B).",
    disparador: "«Agendar cita» termina sin cita.",
    anclaTipo: "ULTIMO_INBOUND",
    estados: ["CONTACTADO"],
    respuestaTermina: true,
    terminaConCita: true,
    ignoraNoContactar: false,
    finDias: 15,
    finAncla: "CADENCIA",
    fin: { estado: "CONTACTADO_PERDIDO", subestado: null, razon: "DEJO_DE_RESPONDER", siguiente: "NUTRICION" },
    activa: true,
    orden: 40,
    pasos: pasosGhosting(),
  },
  {
    tipo: "REPERFILAR",
    nombre: "Reperfilar",
    rama: "B3 · No es lo que busca",
    descripcion: "Pregunta qué sí le serviría (zona, rango o tipo) y, a los 3 días, un correo con lo único que encaja o la verdad de que hoy no hay.",
    disparador: "El asesor clasifica la respuesta como «No es lo que busca».",
    anclaTipo: "RESPUESTA",
    estados: ["CONTACTADO"],
    respuestaTermina: true,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 4,
    finAncla: "CADENCIA",
    fin: { estado: "CONTACTADO_PERDIDO", subestado: null, razon: "NO_LE_INTERESA", siguiente: "NUTRICION" },
    activa: true,
    orden: 50,
    pasos: pasosReperfilar(),
  },
  {
    tipo: "POSPUSO",
    nombre: "Ahora no (pospuso)",
    rama: "B2 · Ahora no",
    descripcion: "Respeta la fecha que pidió: un mensaje al clasificar, un correo trimestral mientras tanto y retomar el día que dijo.",
    disparador: "El asesor clasifica «Ahora no» con fecha (sin fecha: 90 días).",
    anclaTipo: "CLASIFICACION",
    estados: ["CONTACTADO_PERDIDO"],
    respuestaTermina: true,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 6,
    finAncla: "FECHA_RECONTACTO",
    fin: { estado: null, subestado: null, razon: null, siguiente: "NUTRICION" },
    activa: true,
    orden: 60,
    pasos: pasosPospuso(),
  },
  {
    tipo: "NUTRICION",
    nombre: "Nutrición",
    rama: "C1 · Nunca contestó",
    descripcion: "Silencio de 2 semanas y luego un toque al mes con un dato real; archivo al día 180.",
    disparador: "Termina la cadencia de nuevos sin respuesta (y al final de Reperfilar, Dejó de responder y Ahora no).",
    anclaTipo: "FIN_CADENCIA",
    estados: ESTADOS_SALIDA,
    respuestaTermina: true,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 180,
    finAncla: "CADENCIA",
    fin: SIN_FIN,
    activa: true,
    orden: 70,
    pasos: pasosNutricion(),
  },
  {
    tipo: "BAJA",
    nombre: "Baja",
    rama: "B1 · Baja",
    descripcion: "Una sola confirmación y no se le vuelve a escribir: el contacto queda en «No contactar».",
    disparador: "El asesor clasifica «Baja» (o el lead manda STOP).",
    anclaTipo: "CLASIFICACION",
    estados: ["CONTACTADO_PERDIDO"],
    respuestaTermina: false,
    terminaConCita: false,
    ignoraNoContactar: true,
    finDias: 1,
    finAncla: "CADENCIA",
    fin: SIN_FIN,
    activa: true,
    orden: 80,
    pasos: pasosUnico("B1", "R_B1"),
  },
  {
    tipo: "YA_COMPRO",
    nombre: "Ya compró",
    rama: "B4 · Ya compró",
    descripcion: "Felicitar y ofrecer una actualización de vez en cuando; nutrición solo si acepta.",
    disparador: "El asesor clasifica «Ya compró».",
    anclaTipo: "CLASIFICACION",
    estados: ["CONTACTADO_PERDIDO"],
    respuestaTermina: false,
    terminaConCita: false,
    ignoraNoContactar: false,
    finDias: 2,
    finAncla: "CADENCIA",
    fin: SIN_FIN,
    activa: true,
    orden: 90,
    pasos: pasosUnico("B4", "R_B4"),
  },
];

// ───────────────────────────── SQL de la siembra ─────────────────────────────

function q(s: string | null): string {
  return s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`;
}
function arr(xs: readonly string[]): string {
  return xs.length === 0 ? "'{}'::text[]" : `ARRAY[${xs.map(q).join(", ")}]::text[]`;
}

/**
 * Los INSERT de la siembra (definiciones y pasos), tal como van en la migración. ON CONFLICT DO
 * NOTHING: volver a correr la migración no pisa lo que se editó en el módulo.
 */
export function sqlDeSiembra(defs: readonly CadenciaDef[] = CADENCIAS_INICIALES): string {
  const lineas: string[] = [];
  lineas.push(
    'INSERT INTO propyte_crm.copilot_cadencia_defs ("tipo", "nombre", "rama", "descripcion", "disparador", "anclaTipo", "estados", "respuestaTermina", "terminaConCita", "ignoraNoContactar", "finDias", "finAncla", "finEstado", "finSubestado", "finRazon", "finSiguiente", "activa", "orden") VALUES',
  );
  lineas.push(
    defs
      .map(
        (d) =>
          `(${q(d.tipo)}, ${q(d.nombre)}, ${q(d.rama)}, ${q(d.descripcion)}, ${q(d.disparador)}, ${q(d.anclaTipo)}, ${arr(d.estados)}, ${d.respuestaTermina}, ${d.terminaConCita}, ${d.ignoraNoContactar}, ${d.finDias}, ${q(d.finAncla)}, ${q(d.fin.estado)}, ${q(d.fin.subestado)}, ${q(d.fin.razon)}, ${q(d.fin.siguiente)}, ${d.activa}, ${d.orden})`,
      )
      .join(",\n"),
  );
  lineas.push('ON CONFLICT ("tipo") DO NOTHING;');
  lineas.push("");
  // Los pasos solo se siembran en una cadencia que todavía no tiene ninguno.
  lineas.push(
    'INSERT INTO propyte_crm.copilot_cadencia_pasos ("tipo", "codigo", "canal", "offset", "unidad", "ancla", "plantilla", "paises", "whatsapp", "cuando", "nota", "orden", "activo")',
  );
  lineas.push('SELECT v.* FROM (VALUES');
  lineas.push(
    defs
      .flatMap((d) =>
        d.pasos.map(
          (p) =>
            `(${q(d.tipo)}, ${q(p.codigo)}, ${q(p.canal)}, ${p.offset}, ${q(p.unidad)}, ${q(p.ancla)}, ${q(p.plantilla)}, ${arr(p.paises)}, ${q(p.whatsapp)}, ${q(p.cuando)}, ${q(p.nota)}, ${p.orden}, ${p.activo})`,
        ),
      )
      .join(",\n"),
  );
  lineas.push(') AS v("tipo", "codigo", "canal", "offset", "unidad", "ancla", "plantilla", "paises", "whatsapp", "cuando", "nota", "orden", "activo")');
  lineas.push('WHERE NOT EXISTS (SELECT 1 FROM propyte_crm.copilot_cadencia_pasos p WHERE p."tipo" = v."tipo");');
  return lineas.join("\n");
}
