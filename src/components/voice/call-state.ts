// Lógica pura del estado de llamadas del Device (sin React ni SDK), para poder probarla.

/** "incoming" = llamada entrante timbrando, aún sin contestar. "ringing" = saliente timbrando al cliente. */
export type CallState = "idle" | "connecting" | "ringing" | "incoming" | "in-call";

export interface DatosEntrante {
  contactId: string | null;
  nombre: string;
  telefono: string;
  esNuevo: boolean;
  /** El contacto no tiene asesor: la llamada llega al responsable. */
  sinAsesor?: boolean;
}

export interface VoiceState {
  state: CallState;
  activeContactId: string | null;
  incoming: DatosEntrante | null;
}

export type VoiceEvent =
  | { type: "incoming"; datos: DatosEntrante }
  | { type: "accept" } // el asesor contestó la entrante
  | { type: "reject" } // el asesor rechazó la entrante
  | { type: "cancel" } // el llamante colgó, o otra pestaña contestó
  | { type: "disconnect" } // terminó la llamada (entrante o saliente)
  | { type: "dial"; contactId: string } // inicia saliente
  | { type: "outbound-ringing" }
  | { type: "outbound-accept" }
  | { type: "error" };

export const ESTADO_INICIAL: VoiceState = { state: "idle", activeContactId: null, incoming: null };

export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "incoming":
      // Ya hay otra llamada en curso o timbrando: se conserva la actual.
      if (s.state !== "idle") return s;
      return { state: "incoming", activeContactId: e.datos.contactId, incoming: e.datos };
    case "accept":
      if (s.state !== "incoming") return s;
      return { ...s, state: "in-call", incoming: null };
    case "reject":
    case "cancel":
      if (s.state !== "incoming") return s;
      return ESTADO_INICIAL;
    case "disconnect":
    case "error":
      return ESTADO_INICIAL;
    case "dial":
      if (s.state !== "idle") return s;
      return { state: "connecting", activeContactId: e.contactId, incoming: null };
    case "outbound-ringing":
      return s.state === "connecting" ? { ...s, state: "ringing" } : s;
    case "outbound-accept":
      return s.state === "connecting" || s.state === "ringing" ? { ...s, state: "in-call" } : s;
  }
}

/**
 * Datos del llamante a partir de los <Parameter> del TwiML (customParameters) con respaldo
 * en el From de la llamada.
 */
export function datosDeLlamante(
  custom: ReadonlyMap<string, string> | undefined,
  parameters: Record<string, string> | undefined
): DatosEntrante {
  return {
    contactId: custom?.get("contactId") || null,
    nombre: (custom?.get("nombre") ?? "").trim(),
    telefono: parameters?.From ?? "",
    esNuevo: custom?.get("esNuevo") === "1",
    sinAsesor: custom?.get("sinAsesor") === "1",
  };
}

/** Texto principal del aviso: nombre, o el teléfono si no hay nombre. */
export function etiquetaLlamante(d: DatosEntrante): string {
  return d.nombre || d.telefono || "Número desconocido";
}
