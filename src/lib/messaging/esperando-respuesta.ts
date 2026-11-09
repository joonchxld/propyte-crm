/**
 * Recordatorio de conversaciones esperando respuesta (#990).
 *
 * EL FALLO. Una conversación en HUMAN (el bot ya se la pasó a una persona) donde el cliente
 * escribe y nadie contesta solo avisaba UNA vez: «bot_escalation» al escalar y
 * «social_inbound» en cada mensaje. Si esa persona no lo leía, nadie más se enteraba. Medido
 * en producción: 16 conversaciones así en la marca Yaxnáh, todas del responsable de la marca,
 * con días de espera.
 *
 * QUÉ ES «ESPERANDO». status = HUMAN, no pospuesta (`snoozedUntil` futuro) y el último mensaje
 * NO interno (`internalNote = false`) es del cliente (INBOUND). Una nota interna no es una
 * respuesta, y no cuenta ni a favor ni en contra.
 *
 * CUÁNTO SE ESPERA. En minutos HÁBILES desde ese mensaje, con el MISMO calendario del SLA:
 * `computeDueAt` (business-hours.ts) sobre el `businessHours` de la política SLA que le toca
 * a la conversación (`selectSlaPolicy`), y `HORARIO_POR_DEFECTO` si la política no trae
 * agenda. No se cuentan minutos: se pregunta si el instante en que vence el umbral
 * (`computeDueAt(desde, umbral)`) ya pasó. Así no hay un segundo calendario que mantener.
 *
 * ESCALONES.
 *   Nivel 1 (120 min hábiles): al responsable — `controlledById`, si no el asesor del
 *     contacto, si no la cadena de «hilo sin dueño» (responsable de marca → gerencia de la
 *     plaza → administradores).
 *   Nivel 2 (480 min hábiles, un día hábil): además, la gerencia de la plaza del cliente (si
 *     el contacto no tiene plaza, la del responsable); si no hay gerencia, administradores. No
 *     se repite a quien ya recibió el nivel 1 de esta espera.
 * Nunca cuentas técnicas (`.local`): `usuarioRuteableWhere()` en toda consulta de usuarios.
 *
 * SIN DUPLICADOS Y SIN SPAM. El candado es la propia tabla de avisos: una `Notification` de
 * tipo `conversation_waiting_N`, con el enlace del hilo y creada DESPUÉS del último mensaje
 * del cliente. Un aviso por nivel por cada mensaje del cliente; si vuelve a escribir (o se
 * contesta y vuelve a escribir) el ciclo empieza de cero. Si la espera ya pasó el nivel 2 sin
 * que hubiera salido el 1 (caso de las que ya estaban rezagadas al estrenar esto), solo sale
 * el nivel 2: no se mandan los dos de golpe. Sin columnas nuevas.
 *
 * COSTO. Una consulta de conversaciones HUMAN, UNA agrupada para el último mensaje de todas,
 * UNA de avisos existentes y un `createMany`. Las de destinatarios solo corren para las que
 * de verdad tienen algo que avisar. Solo en horario hábil de la agenda de cada conversación.
 */
import type prismaClient from "@/lib/db";
import { computeDueAt, estaEnHorarioLaboral, HORARIO_POR_DEFECTO, type BusinessHours } from "@/lib/workflows/business-hours";
import { selectSlaPolicy } from "@/lib/workflows/sla-select";
import { usuarioRuteableWhere } from "@/lib/workflows/ruteables";
import { gerenciaDeLaPlaza } from "@/lib/workflows/gerencia";
import { destinatariosHiloSinDueno } from "./aviso-sin-dueno";

type Db = typeof prismaClient;

export type NivelEspera = 1 | 2;

export const MINUTOS_NIVEL_1 = 120;
export const MINUTOS_NIVEL_2 = 480;
/**
 * El recordatorio solo avisa de clientes que escribieron en los últimos 7 días. En prod
 * (2026-11-09) había hilos de hace 19 días: Messenger/Instagram ya no dejan contestarles fuera de
 * la ventana de 24 h, así que avisar de ellos al encender esto eran 36 avisos de golpe sin
 * acción posible. Siguen visibles en «Hoy».
 */
export const DIAS_MAXIMOS_RECORDATORIO = 7;

export const NIVELES_ESPERA: Record<NivelEspera, { minutos: number; tipo: string; titulo: string }> = {
  1: { minutos: MINUTOS_NIVEL_1, tipo: "conversation_waiting_1", titulo: "Cliente esperando respuesta" },
  2: { minutos: MINUTOS_NIVEL_2, tipo: "conversation_waiting_2", titulo: "Cliente sin respuesta desde hace un día" },
};

/** Mismo formato de enlace que `bot_escalation` y `social_inbound`. */
export function enlaceDeLaConversacion(conversationId: string): string {
  return `/inbox?c=${conversationId}`;
}

// ───────────────────────────── Parte pura ─────────────────────────────

export interface UltimoMensaje {
  direction: "INBOUND" | "OUTBOUND";
  createdAt: Date;
}

export interface EntradaEspera {
  status: string;
  snoozedUntil: Date | null;
  /** Último mensaje NO interno del hilo (null si no hay ninguno). */
  ultimoNoInterno: UltimoMensaje | null;
}

/** Desde cuándo espera el cliente, o null si la conversación no está esperando. */
export function esperandoDesde(c: EntradaEspera, ahora: Date): Date | null {
  if (c.status !== "HUMAN") return null;
  if (c.snoozedUntil && c.snoozedUntil.getTime() > ahora.getTime()) return null;
  if (!c.ultimoNoInterno || c.ultimoNoInterno.direction !== "INBOUND") return null;
  return c.ultimoNoInterno.createdAt;
}

/** Instante en que se cumplen los minutos hábiles del nivel, contados desde el mensaje del cliente. */
export function vencimientoDelNivel(desde: Date, nivel: NivelEspera, horario: BusinessHours | null | undefined): Date {
  return computeDueAt(desde, NIVELES_ESPERA[nivel].minutos, horario);
}

/** Nivel de espera alcanzado: 0 si aún no pasa el primer umbral. */
export function nivelAlcanzado(desde: Date, ahora: Date, horario: BusinessHours | null | undefined): 0 | NivelEspera {
  if (vencimientoDelNivel(desde, 2, horario).getTime() <= ahora.getTime()) return 2;
  if (vencimientoDelNivel(desde, 1, horario).getTime() <= ahora.getTime()) return 1;
  return 0;
}

export interface AvisoPrevio {
  type: string;
  link: string | null;
  createdAt: Date;
}

/** ¿Ya hay aviso de este nivel para esta espera? (tipo + enlace del hilo + posterior al mensaje del cliente) */
export function nivelYaAvisado(
  avisos: readonly AvisoPrevio[],
  conversationId: string,
  nivel: NivelEspera,
  desde: Date,
): boolean {
  const tipo = NIVELES_ESPERA[nivel].tipo;
  return avisos.some(
    (a) => a.type === tipo && !!a.link && a.link.includes(conversationId) && a.createdAt.getTime() > desde.getTime(),
  );
}

/**
 * Qué nivel toca avisar ahora (0 = nada). Solo el más alto alcanzado, y solo si no tiene ya
 * su aviso: no se manda el 1 detrás de un 2 ni los dos en la misma pasada.
 */
export function nivelAAvisar(input: {
  conversationId: string;
  desde: Date;
  ahora: Date;
  horario: BusinessHours | null | undefined;
  avisos: readonly AvisoPrevio[];
}): 0 | NivelEspera {
  const nivel = nivelAlcanzado(input.desde, input.ahora, input.horario);
  if (nivel === 0) return 0;
  return nivelYaAvisado(input.avisos, input.conversationId, nivel, input.desde) ? 0 : nivel;
}

/** Primer id de la lista que sea una persona (no nulo, activo, sin correo técnico). */
export function primerResponsable(
  candidatos: ReadonlyArray<string | null | undefined>,
  personas: ReadonlySet<string>,
): string | null {
  for (const id of candidatos) if (id && personas.has(id)) return id;
  return null;
}

/**
 * Destinatarios del nivel 2: los responsables del nivel 1 más la gerencia de la plaza (o los
 * administradores si no hay gerencia), sin repetir a quien ya recibió el nivel 1.
 */
export function destinatariosNivel2(input: {
  responsables: readonly string[];
  gerencia: readonly string[];
  admins: readonly string[];
  yaAvisados: ReadonlySet<string>;
}): string[] {
  const arriba = input.gerencia.length > 0 ? input.gerencia : input.admins;
  const unicos = new Set([...input.responsables, ...arriba]);
  return [...unicos].filter((id) => !input.yaAvisados.has(id));
}

const ETIQUETA_CANAL: Record<string, string> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  WEB: "Web",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
};

/** «hace 25 min», «hace 3 h», «hace 2 d». */
export function haceCuanto(desde: Date, ahora: Date): string {
  const min = Math.max(0, Math.round((ahora.getTime() - desde.getTime()) / 60000));
  if (min < 60) return `hace ${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 48) return `hace ${horas} h`;
  return `hace ${Math.round(horas / 24)} d`;
}

export function textoDelAviso(
  nivel: NivelEspera,
  d: { nombre: string; canal: string; marca: string | null; desde: Date; ahora: Date },
): { title: string; message: string } {
  const canal = ETIQUETA_CANAL[d.canal] ?? d.canal;
  const donde = d.marca ? `${canal}, ${d.marca}` : canal;
  return {
    title: NIVELES_ESPERA[nivel].titulo,
    message: `${d.nombre} (${donde}) escribió ${haceCuanto(d.desde, d.ahora)} y nadie ha contestado.`,
  };
}

// ───────────────────────────── Parte con BD ─────────────────────────────

export interface ResultadoEsperando {
  omitido?: "fuera_de_horario";
  revisadas: number;
  esperando: number;
  nivel1: number;
  nivel2: number;
  notificaciones: number;
}

/** Tope de conversaciones HUMAN por pasada: el cron corre cada minuto, el resto entra en la siguiente. */
const TOPE_CONVERSACIONES = 500;

function horarioValido(h: unknown): h is BusinessHours {
  return estaEnHorarioLaboral(new Date(), h as BusinessHours) !== null;
}

/** Conversación esperando respuesta, con lo que hace falta para avisar o listar. */
export interface ConversacionEsperando {
  id: string;
  channel: string;
  status: string;
  snoozedUntil: Date | null;
  controlledById: string | null;
  connectorId: string | null;
  connector: { brand: { name: string } | null } | null;
  contact: { id: string; firstName: string; lastName: string; assignedToId: string | null; targetPlaza: string | null };
}

/**
 * Las conversaciones que esperan respuesta dentro de `donde` (un where de conversaciones que
 * se suma al filtro base: HUMAN, no pospuesta, contacto vivo), la más antigua primero.
 * Compartida por el cron y por «Hoy». Sin umbral de tiempo: eso lo pone quien llama.
 * Dos consultas: las conversaciones y UNA groupBy por conversación y dirección (sin notas
 * internas) para saber de quién es el último mensaje. `revisadas` = candidatas HUMAN leídas.
 */
export async function conversacionesEsperandoRespuesta(
  db: Db,
  donde: Record<string, unknown>,
  ahora: Date,
  take = TOPE_CONVERSACIONES,
): Promise<{ revisadas: number; esperando: Array<{ c: ConversacionEsperando; desde: Date }> }> {
  const conversaciones = (await db.conversation.findMany({
    where: {
      AND: [
        {
          status: "HUMAN",
          lastInboundAt: { not: null },
          OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: ahora } }],
          contact: { deletedAt: null },
        },
        donde,
      ],
    } as never,
    select: {
      id: true,
      channel: true,
      status: true,
      snoozedUntil: true,
      controlledById: true,
      connectorId: true,
      connector: { select: { brand: { select: { name: true } } } },
      contact: { select: { id: true, firstName: true, lastName: true, assignedToId: true, targetPlaza: true } },
    },
    orderBy: { lastInboundAt: "asc" },
    take,
  })) as unknown as ConversacionEsperando[];
  if (conversaciones.length === 0) return { revisadas: 0, esperando: [] };

  // UNA consulta agrupada: el último mensaje no interno de cada dirección, de todas las conversaciones.
  const grupos = await db.message.groupBy({
    by: ["conversationId", "direction"],
    where: { conversationId: { in: conversaciones.map((c) => c.id) }, internalNote: false } as never,
    _max: { createdAt: true },
  });
  const ultimos = new Map<string, { INBOUND?: Date; OUTBOUND?: Date }>();
  for (const g of grupos) {
    if (!g.conversationId || !g._max.createdAt) continue;
    const fila = ultimos.get(g.conversationId) ?? {};
    fila[g.direction as "INBOUND" | "OUTBOUND"] = g._max.createdAt;
    ultimos.set(g.conversationId, fila);
  }
  const ultimoDe = (id: string): UltimoMensaje | null => {
    const u = ultimos.get(id);
    if (!u) return null;
    if (u.INBOUND && (!u.OUTBOUND || u.INBOUND.getTime() > u.OUTBOUND.getTime())) {
      return { direction: "INBOUND", createdAt: u.INBOUND };
    }
    return u.OUTBOUND ? { direction: "OUTBOUND", createdAt: u.OUTBOUND } : null;
  };

  const esperando = conversaciones
    .map((c) => {
      const desde = esperandoDesde({ status: c.status, snoozedUntil: c.snoozedUntil, ultimoNoInterno: ultimoDe(c.id) }, ahora);
      return desde ? { c, desde } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((x, y) => x.desde.getTime() - y.desde.getTime());
  return { revisadas: conversaciones.length, esperando };
}

export async function revisarConversacionesEsperando(db: Db, ahora: Date): Promise<ResultadoEsperando> {
  const vacio: ResultadoEsperando = { revisadas: 0, esperando: 0, nivel1: 0, nivel2: 0, notificaciones: 0 };

  // Calendario: el de la política SLA que le toca a cada conversación; el de reserva si no trae.
  const politicas = await db.slaPolicy.findMany({
    where: { isActive: true },
    select: { id: true, name: true, isActive: true, isDefault: true, priority: true, conditions: true, businessHours: true },
  });
  const horarioDe = (ctx: Record<string, unknown>): BusinessHours => {
    const p = selectSlaPolicy(politicas, ctx);
    return p && horarioValido(p.businessHours) ? (p.businessHours as BusinessHours) : HORARIO_POR_DEFECTO;
  };

  // Barato: si ninguna agenda está abierta ahora, ni se consulta la bandeja.
  const agendas = [
    HORARIO_POR_DEFECTO,
    ...politicas.filter((p) => horarioValido(p.businessHours)).map((p) => p.businessHours as BusinessHours),
  ];
  if (agendas.every((h) => estaEnHorarioLaboral(ahora, h) === false)) return { omitido: "fuera_de_horario", ...vacio };

  // La espera hábil nunca es mayor que la de reloj: sin 120 min de reloj no hay nivel 1.
  const corte = new Date(ahora.getTime() - MINUTOS_NIVEL_1 * 60000);
  const { revisadas, esperando } = await conversacionesEsperandoRespuesta(
    db,
    { lastInboundAt: { not: null, lte: corte, gte: new Date(ahora.getTime() - DIAS_MAXIMOS_RECORDATORIO * 86_400_000) } },
    ahora,
  );
  if (revisadas === 0) return vacio;
  const resultado = { ...vacio, revisadas, esperando: esperando.length };
  if (esperando.length === 0) return resultado;

  // UNA consulta de avisos ya emitidos de esos hilos, desde el mensaje más antiguo en espera.
  const masAntiguo = new Date(Math.min(...esperando.map((e) => e.desde.getTime())));
  const avisos = await db.notification.findMany({
    where: {
      type: { in: [NIVELES_ESPERA[1].tipo, NIVELES_ESPERA[2].tipo] },
      link: { in: esperando.map((e) => enlaceDeLaConversacion(e.c.id)) },
      createdAt: { gt: masAntiguo },
    },
    select: { userId: true, type: true, link: true, createdAt: true },
  });

  const pendientes = esperando
    .map((e) => {
      const horario = horarioDe({ contact: e.c.contact, adAttribution: null, plaza: e.c.contact.targetPlaza ?? null });
      // Solo se avisa dentro del horario hábil de SU agenda; fuera, espera a la mañana.
      if (estaEnHorarioLaboral(ahora, horario) === false) return null;
      const nivel = nivelAAvisar({ conversationId: e.c.id, desde: e.desde, ahora, horario, avisos });
      return nivel ? { ...e, nivel } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (pendientes.length === 0) return resultado;

  // Personas reales entre los dueños candidatos (una consulta); las cuentas técnicas quedan fuera.
  const candidatos = [
    ...new Set(
      pendientes.flatMap((p) => [p.c.controlledById, p.c.contact.assignedToId]).filter((x): x is string => !!x),
    ),
  ];
  const personasFilas = candidatos.length
    ? await db.user.findMany({
        where: { id: { in: candidatos }, ...usuarioRuteableWhere() } as never,
        select: { id: true, plaza: true },
      })
    : [];
  const personas = new Set(personasFilas.map((u) => u.id));
  const plazaDe = new Map(personasFilas.map((u) => [u.id, u.plaza as string | null]));

  const cacheSinDueno = new Map<string, string[]>();
  const cacheGerencia = new Map<string, string[]>();
  let cacheAdmins: string[] | null = null;
  const admins = async () => {
    if (!cacheAdmins) {
      const filas = await db.user.findMany({
        where: { role: "ADMIN", ...usuarioRuteableWhere() } as never,
        select: { id: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      cacheAdmins = filas.map((f) => f.id);
    }
    return cacheAdmins;
  };

  const filas: Array<{ userId: string; title: string; message: string; type: string; link: string }> = [];
  for (const { c, desde, nivel } of pendientes) {
    // Responsable: quien controla el hilo, si no el asesor del contacto, si no la cadena de «sin dueño».
    let responsables: string[];
    const dueno = primerResponsable([c.controlledById, c.contact.assignedToId], personas);
    if (dueno) {
      responsables = [dueno];
    } else {
      const clave = `${c.connectorId ?? ""}|${c.contact.targetPlaza ?? ""}`;
      let cadena = cacheSinDueno.get(clave);
      if (!cadena) {
        cadena = (
          await destinatariosHiloSinDueno({ connectorId: c.connectorId ?? null, plaza: c.contact.targetPlaza ?? null })
        ).userIds;
        cacheSinDueno.set(clave, cadena);
      }
      responsables = cadena;
    }

    let destinatarios = responsables;
    if (nivel === 2) {
      const plaza = c.contact.targetPlaza ?? (dueno ? (plazaDe.get(dueno) ?? null) : null);
      let gerencia: string[] = [];
      if (plaza) {
        gerencia = cacheGerencia.get(plaza) ?? (await gerenciaDeLaPlaza(plaza));
        cacheGerencia.set(plaza, gerencia);
      }
      const yaAvisados = new Set(
        avisos
          .filter(
            (a) =>
              a.type === NIVELES_ESPERA[1].tipo &&
              !!a.link &&
              a.link.includes(c.id) &&
              a.createdAt.getTime() > desde.getTime(),
          )
          .map((a) => a.userId),
      );
      destinatarios = destinatariosNivel2({
        responsables,
        gerencia,
        admins: gerencia.length > 0 ? [] : await admins(),
        yaAvisados,
      });
    }
    if (destinatarios.length === 0) continue;

    const { title, message } = textoDelAviso(nivel, {
      nombre: `${c.contact.firstName} ${c.contact.lastName}`.trim(),
      canal: c.channel,
      marca: c.connector?.brand?.name ?? null,
      desde,
      ahora,
    });
    const link = enlaceDeLaConversacion(c.id);
    for (const userId of destinatarios) filas.push({ userId, title, message, type: NIVELES_ESPERA[nivel].tipo, link });
    if (nivel === 1) resultado.nivel1++;
    else resultado.nivel2++;
  }

  if (filas.length > 0) await db.notification.createMany({ data: filas });
  return { ...resultado, notificaciones: filas.length };
}
