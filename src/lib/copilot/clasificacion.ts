// #993 — R2: clasificar la respuesta del lead.
//
// Cuando una cadencia que se detiene con la respuesta (la general, Reperfilar, Ahora no,
// Nutrición, Dejó de responder) detecta que el lead respondió, se PAUSA y Copilot le pide al
// asesor que la clasifique (PDF «Cadencias por Rama», R2; SLA de 5 min en horario). Cada botón
// fija estado, subestado y razón (sección 3) y abre la cadencia de la rama.
//
// «No era respuesta» (sección 6: autorrespuesta, «¿quién eres?», emoji, «ok»): reanuda la cadencia
// donde iba y regresa el estado que tenía, sin perder los toques que faltaban.
//
// Lógica pura.

export type ResultadoClasificacion =
  | "INTERESADO"
  | "AHORA_NO"
  | "NO_ES_LO_QUE_BUSCA"
  | "NO_LE_INTERESA"
  | "BAJA"
  | "YA_COMPRO"
  | "DATOS_INCORRECTOS"
  | "EQUIVOCADO"
  | "NO_ERA_RESPUESTA";

export interface EfectoClasificacion {
  etiqueta: string;
  ayuda: string;
  /** null = no cambia el estado («No era respuesta»). */
  estado: string | null;
  subestado: string | null;
  razon: string | null;
  /** Cadencia en la que entra. */
  cadencia: string | null;
  /** Pide fecha de recontacto (Ahora no); sin fecha se usan 90 días (catálogo, situación 41). */
  pideFecha?: boolean;
}

export const CLASIFICACIONES: Record<ResultadoClasificacion, EfectoClasificacion> = {
  INTERESADO: {
    etiqueta: "Interesado",
    ayuda: "Quiere ver opciones, pregunta precio o pide llamada → Agendar cita",
    estado: "CONTACTADO",
    subestado: "EN_CONVERSACION",
    razon: null,
    cadencia: "AGENDAR",
  },
  AHORA_NO: {
    etiqueta: "Ahora no",
    ayuda: "Le interesa pero más adelante → se retoma en la fecha que pidió",
    estado: "CONTACTADO_PERDIDO",
    subestado: null,
    razon: "POSPUSO",
    cadencia: "POSPUSO",
    pideFecha: true,
  },
  NO_ES_LO_QUE_BUSCA: {
    etiqueta: "No es lo que busca",
    ayuda: "Precio, zona o tipo no le cuadran → una pregunta para reperfilar",
    estado: "CONTACTADO",
    subestado: "EN_CONVERSACION",
    razon: null,
    cadencia: "REPERFILAR",
  },
  NO_LE_INTERESA: {
    etiqueta: "No le interesa",
    ayuda: "Solo exploraba → Contactado perdido, sin más mensajes",
    estado: "CONTACTADO_PERDIDO",
    subestado: null,
    razon: "NO_LE_INTERESA",
    cadencia: null,
  },
  BAJA: {
    etiqueta: "Baja",
    ayuda: "«No me escribas», STOP o molesto → una confirmación y No contactar",
    estado: "CONTACTADO_PERDIDO",
    subestado: null,
    razon: "NO_CONTACTAR",
    cadencia: "BAJA",
  },
  YA_COMPRO: {
    etiqueta: "Ya compró",
    ayuda: "Ya compró o ya tiene asesor → felicitar",
    estado: "CONTACTADO_PERDIDO",
    subestado: null,
    razon: "YA_COMPRO",
    cadencia: "YA_COMPRO",
  },
  DATOS_INCORRECTOS: {
    etiqueta: "Datos incorrectos",
    ayuda: "Teléfono o correo que no son de nadie → Perdido",
    estado: "PERDIDO",
    subestado: null,
    razon: "DATOS_INCORRECTOS",
    cadencia: null,
  },
  EQUIVOCADO: {
    etiqueta: "Equivocado / no es el lead",
    ayuda: "Contestó otra persona → Contactado perdido · Número equivocado",
    estado: "CONTACTADO_PERDIDO",
    subestado: null,
    razon: "NUMERO_EQUIVOCADO",
    cadencia: null,
  },
  NO_ERA_RESPUESTA: {
    etiqueta: "No era respuesta",
    ayuda: "Autorrespuesta, «ok», emoji o «¿quién eres?» → sigue la cadencia donde iba",
    estado: null,
    subestado: null,
    razon: null,
    cadencia: null,
  },
};

export const ORDEN_CLASIFICACIONES: readonly ResultadoClasificacion[] = [
  "INTERESADO",
  "AHORA_NO",
  "NO_ES_LO_QUE_BUSCA",
  "NO_LE_INTERESA",
  "BAJA",
  "YA_COMPRO",
  "DATOS_INCORRECTOS",
  "EQUIVOCADO",
  "NO_ERA_RESPUESTA",
];

export function esResultadoClasificacion(x: unknown): x is ResultadoClasificacion {
  return typeof x === "string" && (ORDEN_CLASIFICACIONES as readonly string[]).includes(x);
}

/** Días por defecto de «Ahora no» sin fecha. */
export const DIAS_POSPUSO_POR_DEFECTO = 90;

/** Estados de salida: salir de uno de ellos a un estado activo cuenta como reactivación (regla 8). */
const SALIDAS = ["PERDIDO", "CONTACTADO_PERDIDO", "NEGOCIO_PERDIDO"];
export function esReactivacion(desde: string | null | undefined, hacia: string | null): boolean {
  return !!desde && SALIDAS.includes(desde) && !!hacia && !SALIDAS.includes(hacia);
}

/** Valida la fecha de recontacto (AAAA-MM-DD, de mañana a 2 años). null si es inválida. */
export function fechaRecontactoValida(fecha: unknown, hoy: string): string | null {
  if (typeof fecha !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const t = Date.parse(`${fecha}T00:00:00Z`);
  const h = Date.parse(`${hoy}T00:00:00Z`);
  if (Number.isNaN(t) || t <= h || t > h + 730 * 86_400_000) return null;
  return fecha;
}
