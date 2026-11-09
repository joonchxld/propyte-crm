"use server";

// Vista Hoy del asesor (Fase 2, T2.1). Agrega lo accionable del día en una sola
// consulta server-side con RBAC: ASESOR ve lo suyo, TEAM_LEADER su equipo, dirección todo.
import prisma from "@/lib/db";
import { enLotes } from "@/lib/db/lotes";
import { realLeadWhere } from "@/lib/leads/real-leads";
import { resolveActivityScope } from "@/lib/activities/scope";
import { cancunDayRange } from "@/lib/agenda/grouping";
import { conversacionesEsperandoRespuesta, haceCuanto } from "@/lib/messaging/esperando-respuesta";

export interface TodayMini {
  id: string;
  title: string;
  subtitle?: string;
  href?: string;
  meta?: string;
  /** Presente solo en tareas: "TASK" | "CALL_TASK" */
  activityType?: string;
  /** Presente solo en CALL_TASK: teléfono del contacto */
  contactPhone?: string | null;
  /** Presente solo en CALL_TASK: id del contacto para CallButton */
  contactId?: string;
}

export interface TodayView {
  newLeads: { count: number; items: TodayMini[] };
  slaAtRisk: { count: number; items: TodayMini[] };
  tasks: { count: number; items: TodayMini[] };
  conversations: { count: number; items: TodayMini[] };
  /** #990: conversaciones en manos de una persona donde el cliente escribió y nadie ha contestado. */
  esperandoRespuesta: { count: number; items: TodayMini[] };
  visits: { count: number; items: TodayMini[] };
  hotDeals: { count: number; items: TodayMini[] };
  openQuotes: { count: number };
}

const EMPTY: TodayView = {
  newLeads: { count: 0, items: [] },
  slaAtRisk: { count: 0, items: [] },
  tasks: { count: 0, items: [] },
  conversations: { count: 0, items: [] },
  esperandoRespuesta: { count: 0, items: [] },
  visits: { count: 0, items: [] },
  hotDeals: { count: 0, items: [] },
  openQuotes: { count: 0 },
};

// Resuelve los IDs de usuario cuyo trabajo puede ver el actual (undefined = todos).
//
// #715 A-03: esto tenía su propia copia de las listas de roles —la tercera del
// repositorio— y ya había divergido: HOSTESS no estaba en ninguna de las dos, así que
// caía en el `return undefined` del final y veía las tareas, los leads y los negocios de
// TODA la empresa. Cualquier rol nuevo habría heredado el mismo agujero, porque el
// default era "sin restricción". Ahora el bucket lo decide `resolveActivityScope`, que es
// el módulo canónico que ya usan getActivities y getOverdueTasks, y el caso no
// contemplado deja de ver todo para no ver nada.
async function resolveOwnerIds(userId: string, role: string): Promise<string[] | undefined> {
  const scope = resolveActivityScope(role);
  if (scope === "ALL") return undefined;
  if (scope === "TEAM") {
    const team = await prisma.user.findMany({ where: { teamLeaderId: userId }, select: { id: true } });
    return [userId, ...team.map((t) => t.id)];
  }
  if (scope === "OWN") return [userId];
  return []; // DENIED: lista vacía → la consulta no devuelve nada
}

export async function getTodayView(userId: string, role: string): Promise<TodayView> {
  try {
    const owners = await resolveOwnerIds(userId, role);
    const ownerWhere = owners ? { in: owners } : undefined;

    const now = new Date();
    // #715 A-04: el día es el civil de Cancún, el mismo que usa /agenda. Con setHours()
    // el rango salía en la zona del proceso (UTC en el contenedor) y las dos pantallas
    // discrepaban de qué es "hoy" durante cinco horas cada día.
    const { start: startToday, end: endToday } = cancunDayRange(now);
    const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000); // SLA en riesgo: vence en <2h

    // #683: `contactScope` viaja como filtro de la RELACIÓN contact en los conteos de
    // temporizadores y de conversaciones (`{ contact: contactScope }`), y ahí no había
    // nada que descartara los contactos borrados. Con el ámbito global —cuando
    // `ownerWhere` es null, o sea dirección y admin— el objeto quedaba vacío, así que
    // esos dos números incluían el trabajo pendiente de contactos que ya no existen.
    // Medido en producción el 2026-09-08: 18 de 131 contactos están borrados.
    //
    // Los otros dos conteos de contactos de esta vista (:90 y :92) sí lo llevaban, y de
    // ahí venía la incoherencia: la misma pantalla contaba dos cosas con dos criterios.
    const contactScope = { deletedAt: null, ...(ownerWhere ? { assignedToId: ownerWhere } : {}) };
    const dealScope = ownerWhere ? { assignedToId: ownerWhere } : {};
    const activityUserScope = ownerWhere ? { userId: ownerWhere } : {};

    const [
      newLeadsCount, newLeads,
      slaCount, sla,
      tasksCount, tasks,
      convCount, conv,
      espera,
      visitsCount, visits,
      hotCount, hot,
      openQuotes,
    ] = await enLotes([
      // 1. Leads nuevos sin tocar. El `deletedAt: null` explícito que había aquí se
      // quitó porque ahora lo trae `contactScope` (#683) y también realLeadWhere (#682):
      // repetirlo en el literal es un TS2783 ("se especifica más de una vez").
      () => prisma.contact.count({ where: realLeadWhere({ contactStatus: "NUEVO" as never, ...contactScope }) }),
      () => prisma.contact.findMany({
        where: realLeadWhere({ contactStatus: "NUEVO" as never, ...contactScope }),
        select: { id: true, firstName: true, lastName: true, phone: true, leadSource: true },
        orderBy: { createdAt: "desc" }, take: 6,
      }),
      // 2. SLA en riesgo (corriendo y por vencer)
      () => prisma.slaTimer.count({ where: { status: "RUNNING" as never, dueAt: { lte: soon }, contact: contactScope } }),
      () => prisma.slaTimer.findMany({
        where: { status: "RUNNING" as never, dueAt: { lte: soon }, contact: contactScope },
        select: { id: true, dueAt: true, type: true, contact: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { dueAt: "asc" }, take: 6,
      }),
      // 3. Tareas vencidas o de hoy (TASK + CALL_TASK)
      () => prisma.activity.count({
        where: { deletedAt: null, activityType: { in: ["TASK", "CALL_TASK"] as never }, status: "PENDIENTE" as never, dueDate: { lte: endToday }, ...activityUserScope },
      }),
      () => prisma.activity.findMany({
        where: { deletedAt: null, activityType: { in: ["TASK", "CALL_TASK"] as never }, status: "PENDIENTE" as never, dueDate: { lte: endToday }, ...activityUserScope },
        select: { id: true, subject: true, dueDate: true, activityType: true, contact: { select: { id: true, firstName: true, lastName: true, phone: true } } },
        orderBy: { dueDate: "asc" }, take: 6,
      }),
      // 4. Conversaciones sin responder
      () => prisma.conversation.count({ where: { unreadCount: { gt: 0 }, status: { not: "CLOSED" as never }, contact: contactScope } }),
      () => prisma.conversation.findMany({
        where: { unreadCount: { gt: 0 }, status: { not: "CLOSED" as never }, contact: contactScope },
        select: { id: true, unreadCount: true, lastInboundAt: true, contact: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { lastInboundAt: "desc" }, take: 6,
      }),
      // 4b. #990: clientes esperando respuesta. Exacto, no por `unreadCount` (en producción 14 de
      // 16 tenían 0: alguien abrió el hilo sin contestar): cualquier HUMAN cuyo último mensaje no
      // interno es del cliente, sin umbral, y que es MÍO (yo controlo el hilo o el contacto es
      // mío; el propio usuario, no su equipo). Misma lógica que el cron.
      () => conversacionesEsperandoRespuesta(
        prisma,
        { OR: [{ controlledById: userId }, { contact: { assignedToId: userId } }] },
        now,
      ),
      // 5. Visitas de hoy
      () => prisma.activity.count({
        where: { deletedAt: null, activityType: { in: ["MEETING_PRESENTIAL", "MEETING_VIRTUAL", "MEETING_SHOWROOM"] as never }, dueDate: { gte: startToday, lte: endToday }, ...activityUserScope },
      }),
      () => prisma.activity.findMany({
        where: { deletedAt: null, activityType: { in: ["MEETING_PRESENTIAL", "MEETING_VIRTUAL", "MEETING_SHOWROOM"] as never }, dueDate: { gte: startToday, lte: endToday }, ...activityUserScope },
        select: { id: true, subject: true, dueDate: true, contact: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { dueDate: "asc" }, take: 6,
      }),
      // 6. Deals calientes (contacto HOT, no cerrados)
      () => prisma.deal.count({
        where: { deletedAt: null, stage: { notIn: ["WON", "LOST", "FROZEN"] as never }, contact: { temperature: "HOT" as never }, ...dealScope },
      }),
      () => prisma.deal.findMany({
        where: { deletedAt: null, stage: { notIn: ["WON", "LOST", "FROZEN"] as never }, contact: { temperature: "HOT" as never }, ...dealScope },
        select: { id: true, stage: true, estimatedValue: true, currency: true, contact: { select: { firstName: true, lastName: true } } },
        orderBy: { updatedAt: "desc" }, take: 6,
      }),
      // 7. Cotizaciones abiertas (enviadas / vistas)
      () => prisma.quote.count({
        where: { deletedAt: null, status: { in: ["SENT", "OPENED"] as never }, ...(ownerWhere ? { deal: { assignedToId: ownerWhere } } : {}) },
      }),
    ]);

    const name = (c?: { firstName: string; lastName: string } | null) =>
      c ? `${c.firstName} ${c.lastName}` : "—";

    return {
      newLeads: {
        count: newLeadsCount,
        items: newLeads.map((c) => ({ id: c.id, title: `${c.firstName} ${c.lastName}`, subtitle: c.phone, href: `/contacts/${c.id}` })),
      },
      slaAtRisk: {
        count: slaCount,
        items: sla.map((s) => ({ id: s.id, title: name(s.contact), subtitle: s.type as string, meta: s.dueAt.toISOString(), href: s.contact ? `/contacts/${s.contact.id}` : undefined })),
      },
      tasks: {
        count: tasksCount,
        items: tasks.map((t) => ({
          id: t.id,
          title: t.subject,
          subtitle: name(t.contact),
          meta: t.dueDate?.toISOString(),
          href: t.contact ? `/contacts/${t.contact.id}` : undefined,
          activityType: t.activityType as string,
          contactPhone: t.contact?.phone ?? null,
          contactId: t.contact?.id,
        })),
      },
      conversations: {
        count: convCount,
        items: conv.map((c) => ({ id: c.id, title: name(c.contact), subtitle: `${c.unreadCount} sin leer`, meta: c.lastInboundAt?.toISOString(), href: "/inbox" })),
      },
      esperandoRespuesta: {
        count: espera.esperando.length,
        items: espera.esperando.slice(0, 6).map(({ c, desde }) => ({
          id: c.id,
          title: name(c.contact),
          subtitle: "Esperando tu respuesta",
          meta: `escribió ${haceCuanto(desde, now)}`,
          href: `/inbox?c=${c.id}`,
        })),
      },
      visits: {
        count: visitsCount,
        items: visits.map((v) => ({ id: v.id, title: v.subject, subtitle: name(v.contact), meta: v.dueDate?.toISOString(), href: v.contact ? `/contacts/${v.contact.id}` : undefined })),
      },
      hotDeals: {
        count: hotCount,
        items: hot.map((d) => ({ id: d.id, title: name(d.contact), subtitle: d.stage as string, meta: `${Number(d.estimatedValue).toLocaleString("es-MX")} ${d.currency}`, href: `/pipeline?dealId=${d.id}` })),
      },
      openQuotes: { count: openQuotes },
    };
  } catch (err) {
    console.error("[today] getTodayView falló:", err);
    return EMPTY;
  }
}
