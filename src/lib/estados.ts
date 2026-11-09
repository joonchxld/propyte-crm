// #953 (entrega 1) — Estado y subestado del contacto según el flujograma v0.2 de Luis (pestañas
// «Estados», «Subestados», «Transiciones» y «Por flujo») y sus correcciones del 02-nov.
//
// Lista única: el enum EstadoContacto de schema.prisma y la migración
// prisma/migrations-manual/2026-11-03-estado-subestado.sql tienen que decir lo mismo que este
// archivo (lo comprueba estados.test.ts).
//
// El estado viejo (`contactStatus`) sigue existiendo y lo mantiene un disparador de la base: todo lo
// que todavía lo lee o escribe (puntaje, «Hoy», reglas de flujo, spam, alta de leads) sigue igual.
// Aquí solo vive lo que decide la API: qué cambios se permiten y qué datos pide cada uno.

export const ESTADO_ORDER = [
  "NUEVO",
  "SIN_RESPUESTA",
  "CONTACTADO",
  "REUNION",
  "DEMO",
  "RECORRIDO",
  "PROPUESTA",
  "APARTADO",
  "FIRMA",
  "ESCRITURA",
  "POSTVENTA",
  "PERDIDO",
  "CONTACTADO_PERDIDO",
  "NEGOCIO_PERDIDO",
  "REGISTRADO_POR_BROKER",
  "DERIVADO_A_RH",
] as const;
export type Estado = (typeof ESTADO_ORDER)[number];

export const ESTADO_LABELS: Record<Estado, string> = {
  NUEVO: "Nuevo",
  SIN_RESPUESTA: "Sin respuesta",
  CONTACTADO: "Contactado",
  REUNION: "Reunión",
  DEMO: "Demo",
  RECORRIDO: "Recorrido",
  PROPUESTA: "Propuesta",
  APARTADO: "Apartado",
  FIRMA: "Firma",
  ESCRITURA: "Escritura",
  POSTVENTA: "Postventa",
  PERDIDO: "Perdido",
  CONTACTADO_PERDIDO: "Contactado perdido",
  NEGOCIO_PERDIDO: "Negocio Perdido",
  REGISTRADO_POR_BROKER: "Registrado por broker",
  DERIVADO_A_RH: "Derivado a RH",
};

// Color = señal. Prospección y contacto en fríos, negocio en violetas, cierre en verdes, salidas en rojo.
export const ESTADO_COLORS: Record<Estado, string> = {
  NUEVO: "#3B82F6",
  SIN_RESPUESTA: "#F59E0B",
  CONTACTADO: "#6366F1",
  REUNION: "#8B5CF6",
  DEMO: "#A855F7",
  RECORRIDO: "#C026D3",
  PROPUESTA: "#DB2777",
  APARTADO: "#0D9488",
  FIRMA: "#059669",
  ESCRITURA: "#16A34A",
  POSTVENTA: "#65A30D",
  PERDIDO: "#EF4444",
  CONTACTADO_PERDIDO: "#DC2626",
  NEGOCIO_PERDIDO: "#B91C1C",
  REGISTRADO_POR_BROKER: "#0EA5E9",
  DERIVADO_A_RH: "#9CA3AF",
};

/** Contactos que todavía no tienen estado (los mueve la entrega 3): la ficha los marca para elegirlo. */
export const ESTADO_VACIO_LABEL = "Por clasificar";
export const ESTADO_VACIO_COLOR = "#D97706";
/** Valor del filtro de la lista para «Por clasificar» (no choca con ningún estado). */
export const ESTADO_SIN_ESTADO = "SIN_ESTADO";

export const ESTADOS_SALIDA: readonly Estado[] = ["PERDIDO", "CONTACTADO_PERDIDO", "NEGOCIO_PERDIDO"];
/** Desde Demo es obligatorio el ticket estimado (Luis, 02-nov). */
export const ESTADOS_CON_TICKET: readonly Estado[] = [
  "DEMO", "RECORRIDO", "PROPUESTA", "APARTADO", "FIRMA", "ESCRITURA", "POSTVENTA",
];

export function esEstado(v: unknown): v is Estado {
  return typeof v === "string" && (ESTADO_ORDER as readonly string[]).includes(v);
}
export function esSalida(e: string | null | undefined): boolean {
  return !!e && (ESTADOS_SALIDA as readonly string[]).includes(e);
}
export function etiquetaEstado(e: string | null | undefined): string {
  return e && esEstado(e) ? ESTADO_LABELS[e] : ESTADO_VACIO_LABEL;
}

// ───────────────────────────── subestados ─────────────────────────────

interface Opcion {
  valor: string;
  etiqueta: string;
  /** Solo en estos flujos. Sin la lista: en todos. Un contacto sin flujo ve todos. */
  flujos?: readonly string[];
}

// Pestaña «Subestados v0.2». Las salidas no llevan subestado: llevan razón (anexo del 02-nov).
// El primero de cada lista es el que se pone al entrar al estado si no se elige otro.
export const SUBESTADOS: Partial<Record<Estado, readonly Opcion[]>> = {
  CONTACTADO: [
    { valor: "EN_CONVERSACION", etiqueta: "En conversación" },
    { valor: "SEGUIMIENTO_AGENDADO", etiqueta: "Seguimiento agendado" },
  ],
  REUNION: [
    { valor: "AGENDADA", etiqueta: "Agendada" },
    { valor: "CONFIRMADA", etiqueta: "Confirmada" },
    { valor: "NO_SHOW", etiqueta: "No-show" },
  ],
  DEMO: [
    { valor: "REALIZADA", etiqueta: "Realizada" },
    { valor: "COTIZANDO", etiqueta: "Cotizando" },
    // Luis, 02-nov: la Presentación a equipo es de F7 Inmobiliaria (no de F6).
    { valor: "PRESENTACION_EQUIPO_AGENDADA", etiqueta: "Presentación a equipo agendada", flujos: ["F7_INMOBILIARIA"] },
    { valor: "PRESENTACION_EQUIPO_REALIZADA", etiqueta: "Presentación a equipo realizada", flujos: ["F7_INMOBILIARIA"] },
  ],
  RECORRIDO: [
    { valor: "AGENDADO", etiqueta: "Agendado" },
    { valor: "CONFIRMADO", etiqueta: "Confirmado" },
    { valor: "NO_SHOW", etiqueta: "No-show" },
    { valor: "COMPLETADO", etiqueta: "Completado" },
  ],
  PROPUESTA: [
    { valor: "ENVIADA", etiqueta: "Enviada" },
    { valor: "EN_NEGOCIACION", etiqueta: "En negociación" },
    { valor: "ACEPTADA", etiqueta: "Aceptada" },
    { valor: "PAQUETE_ACTIVO", etiqueta: "Paquete activo", flujos: ["F1_CORRETAJE_VENDEDOR"] },
  ],
  APARTADO: [
    { valor: "PENDIENTE_DE_PAGO", etiqueta: "Pendiente de pago" },
    { valor: "PAGADO", etiqueta: "Pagado" },
    { valor: "DOCUMENTOS_EN_REVISION", etiqueta: "Documentos y contrato en revisión" },
    { valor: "FINANCIAMIENTO_EN_TRAMITE", etiqueta: "Financiamiento en trámite", flujos: ["F5_NATIVA"] },
    { valor: "FINANCIAMIENTO_APROBADO", etiqueta: "Financiamiento aprobado", flujos: ["F5_NATIVA"] },
  ],
  FIRMA: [
    { valor: "AGENDADA", etiqueta: "Agendada" },
    { valor: "FIRMADO", etiqueta: "Firmado" },
    { valor: "DEVENGO_ACTIVO", etiqueta: "Devengo activo" },
  ],
  ESCRITURA: [
    { valor: "EN_TRAMITE_NOTARIAL", etiqueta: "En trámite notarial" },
    { valor: "FECHA_AGENDADA", etiqueta: "Fecha agendada" },
    { valor: "ESCRITURADO", etiqueta: "Escriturado" },
  ],
  POSTVENTA: [
    { valor: "ENTREGA_PENDIENTE", etiqueta: "Entrega pendiente" },
    { valor: "ENTREGADA", etiqueta: "Entregada" },
    { valor: "ENCUESTA_RESPONDIDA", etiqueta: "Encuesta respondida" },
  ],
};

/** Etiqueta por código, sin importar el estado (los códigos repetidos —Agendada, No-show— dicen lo mismo). */
export const SUBESTADO_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(SUBESTADOS).flatMap((ops) => (ops ?? []).map((o) => [o.valor, o.etiqueta])),
);

function aplicaAlFlujo(o: { flujos?: readonly string[] }, flujo: string | null | undefined): boolean {
  return !o.flujos || !flujo || o.flujos.includes(flujo);
}

export function subestadosDe(estado: string | null | undefined, flujo?: string | null): Opcion[] {
  if (!estado || !esEstado(estado)) return [];
  return (SUBESTADOS[estado] ?? []).filter((o) => aplicaAlFlujo(o, flujo));
}
export function subestadoPorDefecto(estado: string | null | undefined, flujo?: string | null): string | null {
  return subestadosDe(estado, flujo)[0]?.valor ?? null;
}
export function etiquetaSubestado(s: string | null | undefined): string | null {
  return s ? SUBESTADO_LABELS[s] ?? s : null;
}

// ───────────────────────────── razones de salida ─────────────────────────────

export const RAZON_SALIDA_ORDER = [
  "DATOS_INCORRECTOS",
  "SIN_RESPUESTA_TRAS_CADENCIA",
  "DUPLICADO",
  "SPAM",
  "PROTEGIDO_POR_BROKER",
  "NO_CALIFICA",
  "NO_LE_INTERESA",
  "POSPUSO",
  "DEJO_DE_RESPONDER",
  "ELIGIO_OTRA_OPCION",
  "PRECIO",
  "FINANCIAMIENTO",
  "PRODUCTO",
  "CONFIANZA",
  "SITUACION_PERSONAL",
  "CANCELO_APARTADO",
  "NO_CONTACTAR",
  // #993 (R12): ramas B4 y «Equivocado» de la clasificación de respuestas.
  "YA_COMPRO",
  "NUMERO_EQUIVOCADO",
  "OTRO",
] as const;
export type RazonSalida = (typeof RAZON_SALIDA_ORDER)[number];

export const RAZON_SALIDA_LABELS: Record<RazonSalida, string> = {
  DATOS_INCORRECTOS: "Datos incorrectos",
  SIN_RESPUESTA_TRAS_CADENCIA: "Sin respuesta tras cadencia",
  DUPLICADO: "Duplicado",
  SPAM: "Spam o lead falso",
  PROTEGIDO_POR_BROKER: "Cliente protegido por broker",
  NO_CALIFICA: "No califica",
  NO_LE_INTERESA: "No le interesa",
  POSPUSO: "Pospuso la compra",
  DEJO_DE_RESPONDER: "Dejó de responder",
  ELIGIO_OTRA_OPCION: "Eligió otra opción",
  PRECIO: "Precio",
  FINANCIAMIENTO: "Financiamiento",
  PRODUCTO: "Producto",
  CONFIANZA: "Confianza",
  SITUACION_PERSONAL: "Cambió su situación personal",
  CANCELO_APARTADO: "Canceló apartado o contrato",
  NO_CONTACTAR: "Pidió no ser contactado",
  YA_COMPRO: "Ya compró",
  NUMERO_EQUIVOCADO: "Número equivocado (no es el lead)",
  OTRO: "Otro",
};

/** Qué se escribe en «Detalle» para cada razón (texto de ayuda del formulario). */
export const RAZON_SALIDA_AYUDA: Partial<Record<RazonSalida, string>> = {
  DATOS_INCORRECTOS: "Teléfono inexistente, correo que rebota o número de otra persona",
  DUPLICADO: "Con qué contacto se duplica",
  SPAM: "Bot, broma o sondeo de la competencia",
  NO_CALIFICA: "Presupuesto, renta en vez de compra, zona o producto que no manejamos, forma de pago",
  NO_LE_INTERESA: "Solo exploraba o buscaba un desarrollo que no comercializamos",
  YA_COMPRO: "Ya compró o ya tiene asesor",
  NUMERO_EQUIVOCADO: "Contestó otra persona; el número no es del lead",
  ELIGIO_OTRA_OPCION: "Qué desarrollo, reventa u otro asesor o broker (obligatorio)",
  PRECIO: "Precio total, enganche o mensualidad",
  FINANCIAMIENTO: "Crédito rechazado, financiamiento no aprobado, tasa o plazo",
  PRODUCTO: "Ubicación, tamaño, amenidades, fecha de entrega, unidad vendida",
  CONFIANZA: "Dudas sobre el desarrollador, legales o del recorrido",
  CANCELO_APARTADO: "Apartado vencido sin reapartar o contrato cancelado",
  OTRO: "Cuál (obligatorio)",
};

// Anexo de Luis (02-nov): «Razón de descarte» para Perdido y Contactado perdido, «Razón de pérdida»
// para Negocio Perdido. Una sola columna; la etiqueta cambia según el estado.
export const RAZONES_POR_SALIDA: Record<"PERDIDO" | "CONTACTADO_PERDIDO" | "NEGOCIO_PERDIDO", readonly RazonSalida[]> = {
  PERDIDO: ["DATOS_INCORRECTOS", "SIN_RESPUESTA_TRAS_CADENCIA", "DUPLICADO", "SPAM", "PROTEGIDO_POR_BROKER", "OTRO"],
  CONTACTADO_PERDIDO: ["NO_CALIFICA", "NO_LE_INTERESA", "POSPUSO", "DEJO_DE_RESPONDER", "NO_CONTACTAR", "YA_COMPRO", "NUMERO_EQUIVOCADO", "OTRO"],
  NEGOCIO_PERDIDO: [
    "ELIGIO_OTRA_OPCION", "PRECIO", "FINANCIAMIENTO", "PRODUCTO", "CONFIANZA", "POSPUSO",
    "SITUACION_PERSONAL", "DEJO_DE_RESPONDER", "CANCELO_APARTADO", "NO_CONTACTAR", "OTRO",
  ],
};
/** Razones que exigen el detalle escrito. */
export const RAZONES_CON_DETALLE: readonly RazonSalida[] = ["OTRO", "ELIGIO_OTRA_OPCION"];
/** Razones que exigen la fecha de recontacto. */
export const RAZONES_CON_FECHA: readonly RazonSalida[] = ["POSPUSO"];

export function razonesDe(estado: string | null | undefined): readonly RazonSalida[] {
  return estado && estado in RAZONES_POR_SALIDA
    ? RAZONES_POR_SALIDA[estado as keyof typeof RAZONES_POR_SALIDA]
    : [];
}
export function tituloRazon(estado: string | null | undefined): string {
  return estado === "NEGOCIO_PERDIDO" ? "Razón de pérdida" : "Razón de descarte";
}
export function etiquetaRazon(r: string | null | undefined): string | null {
  return r ? RAZON_SALIDA_LABELS[r as RazonSalida] ?? r : null;
}

// ───────────────────────────── transiciones ─────────────────────────────

// Pestaña «Transiciones v0.2» + correcciones del 02-nov:
//   - las salidas se reactivan (regresan a Contactado o Reunión) cuando el lead vuelve a escribir;
//   - F7 Inmobiliaria termina en Firma como F3 y F6;
//   - Registrado por broker solo pasa a Reunión (cuando el broker agenda);
//   - busca empleo → Derivado a RH, desde antes de la Reunión.
// Postventa no tiene salida: una compra nueva del mismo cliente llega con Operaciones (entrega 2).
export const TRANSICIONES: Record<Estado, readonly Estado[]> = {
  NUEVO: ["SIN_RESPUESTA", "CONTACTADO", "REUNION", "PERDIDO", "REGISTRADO_POR_BROKER", "DERIVADO_A_RH"],
  SIN_RESPUESTA: ["CONTACTADO", "REUNION", "PERDIDO", "DERIVADO_A_RH"],
  CONTACTADO: ["REUNION", "CONTACTADO_PERDIDO", "DERIVADO_A_RH"],
  REUNION: ["DEMO", "RECORRIDO", "CONTACTADO_PERDIDO"],
  DEMO: ["RECORRIDO", "PROPUESTA", "NEGOCIO_PERDIDO"],
  RECORRIDO: ["PROPUESTA", "NEGOCIO_PERDIDO"],
  PROPUESTA: ["APARTADO", "FIRMA", "NEGOCIO_PERDIDO"],
  APARTADO: ["FIRMA", "NEGOCIO_PERDIDO"],
  FIRMA: ["ESCRITURA", "NEGOCIO_PERDIDO"],
  ESCRITURA: ["POSTVENTA"],
  POSTVENTA: [],
  PERDIDO: ["CONTACTADO", "REUNION"],
  CONTACTADO_PERDIDO: ["CONTACTADO", "REUNION"],
  NEGOCIO_PERDIDO: ["CONTACTADO", "REUNION"],
  REGISTRADO_POR_BROKER: ["REUNION"],
  DERIVADO_A_RH: [],
};

// Pestaña «Por flujo v0.2» + correcciones del 02-nov. Lo que no aparece aplica a todos los flujos.
const NO_APLICA_POR_FLUJO: Record<string, readonly Estado[]> = {
  F3_CAPTACION_MB: ["RECORRIDO", "APARTADO", "ESCRITURA", "POSTVENTA"],
  F6_BROKER: ["APARTADO", "ESCRITURA", "POSTVENTA"],
  F7_INMOBILIARIA: ["APARTADO", "ESCRITURA", "POSTVENTA"],
};
// F8 Empleo no pasa por el pipeline: se deriva a RH (Luis, 02-nov).
const SOLO_PARA_F8: readonly Estado[] = ["NUEVO", "SIN_RESPUESTA", "PERDIDO", "DERIVADO_A_RH"];

/** ¿El estado existe en el flujo del contacto? Sin flujo, todos. */
export function estadoAplicaAlFlujo(estado: Estado, flujo: string | null | undefined): boolean {
  if (!flujo) return true;
  if (flujo === "F8_EMPLEO") return SOLO_PARA_F8.includes(estado);
  return !(NO_APLICA_POR_FLUJO[flujo] ?? []).includes(estado);
}

/** Estados a los que puede pasar el contacto. «Por clasificar» puede pasar a cualquiera. */
export function destinosPermitidos(desde: string | null | undefined, flujo: string | null | undefined): Estado[] {
  const base: readonly Estado[] = desde && esEstado(desde) ? TRANSICIONES[desde] : ESTADO_ORDER;
  return base.filter((e) => e !== desde && estadoAplicaAlFlujo(e, flujo));
}

// #957: desde el apartado (o la firma del contrato o convenio) el estado del contacto lo marca su
// operación activa más avanzada (disparador en deals). Aquí no se entra ni se sale a mano: se aparta,
// firma o cancela desde la sección Operaciones de la ficha. Un administrador sí puede corregirlo.
export const ESTADOS_POR_OPERACION: readonly Estado[] = ["APARTADO", "FIRMA", "ESCRITURA", "POSTVENTA"];

export function esEstadoPorOperacion(e: string | null | undefined): boolean {
  return !!e && (ESTADOS_POR_OPERACION as readonly string[]).includes(e);
}

// ───────────────────────────── validación del cambio ─────────────────────────────

export interface EstadoActual {
  estado: string | null;
  subestado?: string | null;
  flujo?: string | null;
  ticketEstimado?: number | string | { toString(): string } | null;
  razonSalida?: string | null;
  razonSalidaDetalle?: string | null;
  fechaRecontacto?: Date | string | null;
}

export interface CambioDeEstado {
  estado?: string | null;
  subestado?: string | null;
  razonSalida?: string | null;
  razonSalidaDetalle?: string | null;
  /** AAAA-MM-DD */
  fechaRecontacto?: string | null;
  ticketEstimado?: number | null;
}

export interface DatosDeEstado {
  estado?: Estado | null;
  subestado?: string | null;
  razonSalida?: RazonSalida | null;
  razonSalidaDetalle?: string | null;
  fechaRecontacto?: Date | null;
}

export type ResultadoCambio =
  | { ok: true; datos: DatosDeEstado }
  | { ok: false; error: string; campo: string };

function fechaAAAAMMDD(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function inicioDelDiaUTC(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function tieneTicket(v: EstadoActual["ticketEstimado"] | number | null | undefined): boolean {
  if (v === null || v === undefined) return false;
  const n = Number(String(v));
  return Number.isFinite(n) && n > 0;
}

/**
 * Decide si el cambio que pidió alguien en la ficha o en la lista se puede guardar y qué columnas
 * se escriben. No toca la base: la API lo llama con lo que ya tiene el contacto.
 *   - El cambio de estado sigue la tabla de transiciones y el flujo del contacto, salvo `forzar`
 *     (corrección de un administrador).
 *   - Entrar a una salida pide la razón; «Otro» y «Eligió otra opción» piden detalle; «Pospuso»
 *     pide la fecha de recontacto (hoy o después).
 *   - Desde Demo pide el ticket estimado (el que ya tenía o el que viene en el mismo cambio).
 *   - El subestado tiene que ser del estado (y del flujo); si no viene, se pone el primero.
 */
export function validarCambioDeEstado(
  actual: EstadoActual,
  cambio: CambioDeEstado,
  opts: { forzar?: boolean; hoy?: Date } = {},
): ResultadoCambio {
  const hoy = opts.hoy ?? new Date();
  const flujo = actual.flujo ?? null;
  const tocaEstado = cambio.estado !== undefined && cambio.estado !== actual.estado;
  const destino = (cambio.estado !== undefined ? cambio.estado : actual.estado) ?? null;
  const datos: DatosDeEstado = {};

  if (cambio.estado !== undefined && cambio.estado !== null && !esEstado(cambio.estado)) {
    return { ok: false, error: "Ese estado no existe", campo: "estado" };
  }

  if (tocaEstado) {
    if (destino === null) {
      // Regresarlo a «Por clasificar» es una corrección.
      if (!opts.forzar) return { ok: false, error: "Solo un administrador puede dejar el estado sin clasificar", campo: "estado" };
      return { ok: true, datos: { estado: null, subestado: null } };
    }
    const d = destino as Estado;
    if (!opts.forzar) {
      if (esEstadoPorOperacion(d)) {
        return {
          ok: false,
          error: `${ESTADO_LABELS[d]} lo marca la operación: créala o avánzala en la sección Operaciones de la ficha`,
          campo: "estado",
        };
      }
      if (esEstadoPorOperacion(actual.estado)) {
        return {
          ok: false,
          error: "Este contacto tiene una operación en curso: para sacarlo, cancela la operación en la sección Operaciones",
          campo: "estado",
        };
      }
      if (!destinosPermitidos(actual.estado, flujo).includes(d)) {
        const de = etiquetaEstado(actual.estado);
        if (!estadoAplicaAlFlujo(d, flujo)) {
          return { ok: false, error: `${ESTADO_LABELS[d]} no aplica en el flujo de este contacto`, campo: "estado" };
        }
        return { ok: false, error: `De ${de} no se puede pasar a ${ESTADO_LABELS[d]}`, campo: "estado" };
      }
    }
    datos.estado = d;
  }

  const estadoFinal = destino && esEstado(destino) ? destino : null;

  // #957: el subestado de Apartado a Postventa es el de la operación.
  if (
    !tocaEstado &&
    !opts.forzar &&
    esEstadoPorOperacion(estadoFinal) &&
    cambio.subestado !== undefined &&
    cambio.subestado !== (actual.subestado ?? null)
  ) {
    return { ok: false, error: "El subestado lo marca la operación: cámbialo en la sección Operaciones", campo: "subestado" };
  }

  // Ticket estimado desde Demo.
  if (tocaEstado && estadoFinal && ESTADOS_CON_TICKET.includes(estadoFinal)) {
    const ticket = cambio.ticketEstimado !== undefined ? cambio.ticketEstimado : actual.ticketEstimado;
    if (!tieneTicket(ticket)) {
      return { ok: false, error: `Para pasar a ${ESTADO_LABELS[estadoFinal]} captura el ticket estimado`, campo: "ticketEstimado" };
    }
  }

  // Subestado.
  if (estadoFinal && SUBESTADOS[estadoFinal]) {
    if (cambio.subestado !== undefined && cambio.subestado !== null) {
      if (!subestadosDe(estadoFinal, flujo).some((o) => o.valor === cambio.subestado)) {
        return { ok: false, error: `Ese subestado no es de ${ESTADO_LABELS[estadoFinal]}`, campo: "subestado" };
      }
      if (cambio.subestado !== actual.subestado || tocaEstado) datos.subestado = cambio.subestado;
    } else if (tocaEstado) {
      datos.subestado = subestadoPorDefecto(estadoFinal, flujo);
    } else if (cambio.subestado === null) {
      return { ok: false, error: `Elige un subestado de ${ESTADO_LABELS[estadoFinal]}`, campo: "subestado" };
    }
  } else if (cambio.subestado) {
    return { ok: false, error: `${etiquetaEstado(estadoFinal)} no tiene subestados`, campo: "subestado" };
  } else if (tocaEstado) {
    datos.subestado = null;
  }

  // Razón de salida.
  const tocaRazon =
    cambio.razonSalida !== undefined || cambio.razonSalidaDetalle !== undefined || cambio.fechaRecontacto !== undefined;
  if (estadoFinal && esSalida(estadoFinal)) {
    if (tocaEstado || tocaRazon) {
      const razon = (cambio.razonSalida !== undefined ? cambio.razonSalida : tocaEstado ? null : actual.razonSalida) ?? null;
      if (!razon) {
        return { ok: false, error: `Elige la ${tituloRazon(estadoFinal).toLowerCase()}`, campo: "razonSalida" };
      }
      if (!razonesDe(estadoFinal).includes(razon as RazonSalida)) {
        return { ok: false, error: `Esa razón no es de ${ESTADO_LABELS[estadoFinal]}`, campo: "razonSalida" };
      }
      const r = razon as RazonSalida;
      const detalleCrudo =
        cambio.razonSalidaDetalle !== undefined ? cambio.razonSalidaDetalle : tocaEstado ? null : actual.razonSalidaDetalle;
      const detalle = (detalleCrudo ?? "").trim() || null;
      if (RAZONES_CON_DETALLE.includes(r) && !detalle) {
        return { ok: false, error: `«${RAZON_SALIDA_LABELS[r]}» pide escribir el detalle`, campo: "razonSalidaDetalle" };
      }
      let fecha: Date | null = null;
      if (RAZONES_CON_FECHA.includes(r)) {
        const crudo =
          cambio.fechaRecontacto !== undefined
            ? cambio.fechaRecontacto
            : tocaEstado
              ? null
              : actual.fechaRecontacto instanceof Date
                ? actual.fechaRecontacto.toISOString().slice(0, 10)
                : actual.fechaRecontacto ?? null;
        fecha = crudo ? fechaAAAAMMDD(String(crudo).slice(0, 10)) : null;
        if (!fecha) {
          return { ok: false, error: "«Pospuso la compra» pide la fecha de recontacto", campo: "fechaRecontacto" };
        }
        if (inicioDelDiaUTC(fecha) < inicioDelDiaUTC(hoy) && cambio.fechaRecontacto !== undefined) {
          return { ok: false, error: "La fecha de recontacto no puede ser pasada", campo: "fechaRecontacto" };
        }
      }
      datos.razonSalida = r;
      datos.razonSalidaDetalle = detalle;
      datos.fechaRecontacto = fecha;
    }
  } else if (tocaRazon && (cambio.razonSalida || cambio.razonSalidaDetalle || cambio.fechaRecontacto)) {
    return { ok: false, error: "La razón solo se pide en Perdido, Contactado perdido o Negocio Perdido", campo: "razonSalida" };
  } else if (tocaEstado) {
    datos.razonSalida = null;
    datos.razonSalidaDetalle = null;
    datos.fechaRecontacto = null;
  }

  return { ok: true, datos };
}

/** Claves del body de /api/contacts que maneja este módulo (y que gatea el permiso del campo «estado»). */
export const CLAVES_DEL_ESTADO = ["estado", "subestado", "razonSalida", "razonSalidaDetalle", "fechaRecontacto"] as const;

// ───────────────────────────── estado viejo ─────────────────────────────

/** Espejo de propyte_crm.estado_a_legacy() de la migración (lo comprueba estados.test.ts). */
export const ESTADO_A_LEGACY: Record<Estado, string> = {
  NUEVO: "NUEVO",
  SIN_RESPUESTA: "SIN_RESPUESTA",
  CONTACTADO: "CONTACTADO",
  REUNION: "REUNION",
  DEMO: "PROSPECTO",
  RECORRIDO: "PROSPECTO",
  PROPUESTA: "PROSPECTO",
  APARTADO: "PROSPECTO",
  FIRMA: "PROSPECTO",
  ESCRITURA: "PROSPECTO",
  POSTVENTA: "PROSPECTO",
  PERDIDO: "PERDIDO",
  CONTACTADO_PERDIDO: "CONTACTADO_PERDIDO",
  NEGOCIO_PERDIDO: "PERDIDO",
  REGISTRADO_POR_BROKER: "PROSPECTO",
  DERIVADO_A_RH: "DESCARTADO",
};

/**
 * Filtro de la lista. Un estado nuevo filtra por `estado`; «Por clasificar» por `estado = null`; un
 * valor del estado viejo (vistas guardadas antes del #953, p. ej. «PROSPECTO») sigue filtrando por
 * `contactStatus`. Lo que no es nada de eso no recorta.
 */
export function whereEstado(
  valor: string | null | undefined,
  legacy: readonly string[],
): { estado: Estado | null } | { contactStatus: string } | null {
  if (!valor) return null;
  if (valor === ESTADO_SIN_ESTADO) return { estado: null };
  if (esEstado(valor)) return { estado: valor };
  if (legacy.includes(valor)) return { contactStatus: valor };
  return null;
}

// ───────────────────────────── pantalla ─────────────────────────────

/**
 * ¿Elegir este estado en el chip abre el formulario? Sí cuando el cambio pide algo que el chip no
 * puede dar: la razón (salidas) o el ticket estimado (desde Demo, si todavía no lo tiene).
 */
export function pideFormulario(
  destino: string | null | undefined,
  contacto: { ticketEstimado?: EstadoActual["ticketEstimado"] },
): boolean {
  if (!destino || !esEstado(destino)) return false;
  if (esSalida(destino)) return true;
  return ESTADOS_CON_TICKET.includes(destino) && !tieneTicket(contacto.ticketEstimado);
}

/** Opciones del chip de estado: el actual, a dónde puede pasar y —solo administradores— el resto como corrección. */
export function opcionesDeEstado(
  actual: string | null | undefined,
  flujo: string | null | undefined,
  puedeCorregir: boolean,
): { normales: { valor: string; etiqueta: string }[]; correcciones: { valor: string; etiqueta: string }[] } {
  // #957: a Apartado–Postventa se llega (y se sale) por la operación, no por el chip.
  const destinos = esEstadoPorOperacion(actual) ? [] : destinosPermitidos(actual, flujo).filter((e) => !esEstadoPorOperacion(e));
  const normales = [
    { valor: actual ?? "", etiqueta: etiquetaEstado(actual) },
    ...destinos.map((e) => ({ valor: e, etiqueta: ESTADO_LABELS[e] })),
  ];
  const correcciones = puedeCorregir
    ? [
        ...ESTADO_ORDER.filter((e) => e !== actual && !destinos.includes(e)).map((e) => ({ valor: e, etiqueta: ESTADO_LABELS[e] })),
        ...(actual ? [{ valor: "", etiqueta: ESTADO_VACIO_LABEL }] : []),
      ]
    : [];
  return { normales, correcciones };
}
