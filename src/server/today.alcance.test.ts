import { describe, it, expect, vi, beforeEach } from "vitest";

// Tarjeta #715, bugs A-03 y A-04 de la vista /hoy.
//
// A-03: `resolveOwnerIds` tenía su propia copia de las listas de roles —la tercera del
// repositorio— y HOSTESS no estaba en ninguna, así que caía en el `return undefined`
// final y veía el trabajo de toda la empresa.
// A-04: el rango del día se calculaba con setHours() sobre la zona del proceso, mientras
// /agenda agrupa en hora de Cancún.

const userFindMany = vi.fn();
const contactCount = vi.fn();
const contactFindMany = vi.fn();
const dealCount = vi.fn();
const dealFindMany = vi.fn();
const activityCount = vi.fn();
const activityFindMany = vi.fn();
const conversationCount = vi.fn();
const conversationFindMany = vi.fn();
const walkInCount = vi.fn();
const walkInFindMany = vi.fn();
const quoteCount = vi.fn();
const slaCount = vi.fn();
const slaFindMany = vi.fn();
const messageGroupBy = vi.fn();

vi.mock("@/lib/db", () => ({
  default: {
    user: { findMany: (...a: unknown[]) => userFindMany(...a) },
    contact: {
      count: (...a: unknown[]) => contactCount(...a),
      findMany: (...a: unknown[]) => contactFindMany(...a),
    },
    deal: {
      count: (...a: unknown[]) => dealCount(...a),
      findMany: (...a: unknown[]) => dealFindMany(...a),
    },
    activity: {
      count: (...a: unknown[]) => activityCount(...a),
      findMany: (...a: unknown[]) => activityFindMany(...a),
    },
    conversation: {
      count: (...a: unknown[]) => conversationCount(...a),
      findMany: (...a: unknown[]) => conversationFindMany(...a),
    },
    walkIn: {
      count: (...a: unknown[]) => walkInCount(...a),
      findMany: (...a: unknown[]) => walkInFindMany(...a),
    },
    quote: { count: (...a: unknown[]) => quoteCount(...a) },
    message: { groupBy: (...a: unknown[]) => messageGroupBy(...a) },
    slaTimer: {
      count: (...a: unknown[]) => slaCount(...a),
      findMany: (...a: unknown[]) => slaFindMany(...a),
    },
  },
}));

import { getTodayView } from "./today";

beforeEach(() => {
  messageGroupBy.mockReset().mockResolvedValue([]);
  userFindMany.mockReset().mockResolvedValue([{ id: "miembro-1" }]);
  for (const c of [contactCount, dealCount, activityCount, conversationCount, walkInCount, quoteCount, slaCount]) {
    c.mockReset().mockResolvedValue(0);
  }
  for (const f of [contactFindMany, dealFindMany, activityFindMany, conversationFindMany, walkInFindMany, slaFindMany]) {
    f.mockReset().mockResolvedValue([]);
  }
});

/** El `where` de la consulta de tareas, que es la que lleva userId y dueDate. */
function whereDeTareas(): Record<string, unknown> {
  const llamada = activityFindMany.mock.calls[0]?.[0] ?? activityCount.mock.calls[0]?.[0];
  return llamada.where;
}

describe("getTodayView — alcance por rol (#715 A-03)", () => {
  it("HOSTESS ve solo lo suyo, no el trabajo de toda la empresa", async () => {
    await getTodayView("user-1", "HOSTESS");

    // Antes: sin restricción. `resolveActivityScope` la clasifica OWN, como el resto
    // del CRM.
    expect(whereDeTareas().userId).toEqual({ in: ["user-1"] });
  });

  it("un asesor ve solo lo suyo", async () => {
    await getTodayView("user-1", "ASESOR_JR");
    expect(whereDeTareas().userId).toEqual({ in: ["user-1"] });
  });

  it("un team leader ve a su equipo", async () => {
    await getTodayView("user-1", "TEAM_LEADER");
    expect(whereDeTareas().userId).toEqual({ in: ["user-1", "miembro-1"] });
  });

  it("dirección ve todo", async () => {
    await getTodayView("user-1", "DIRECTOR");
    expect(whereDeTareas().userId).toBeUndefined();
  });

  it("un rol desconocido no ve nada, en vez de verlo todo", async () => {
    // El default anterior era "sin restricción", así que cualquier rol nuevo nacía
    // viendo la empresa entera.
    await getTodayView("user-1", "ROL_QUE_NO_EXISTE");
    expect(whereDeTareas().userId).toEqual({ in: [] });
  });
});

describe("getTodayView — el día es el de Cancún (#715 A-04)", () => {
  it("a las 23:30 UTC (18:30 en Cancún) el día sigue siendo el de Cancún, no el siguiente", async () => {
    // 2026-09-07T23:30Z = 2026-09-07 18:30 en Cancún. El fin del día tiene que ser la
    // medianoche de Cancún (2026-09-08T04:59:59.999Z), no la del proceso.
    vi.setSystemTime(new Date("2026-09-07T23:30:00.000Z"));

    await getTodayView("user-1", "ASESOR");

    const due = whereDeTareas().dueDate as { lte: Date };
    expect(due.lte.toISOString()).toBe("2026-09-08T04:59:59.999Z");

    vi.useRealTimers();
  });

  it("a las 03:00 UTC (22:00 del día anterior en Cancún) el día es el anterior", async () => {
    // Este es el caso que rompía: en UTC ya es día 8, en Cancún todavía es 7.
    vi.setSystemTime(new Date("2026-09-08T03:00:00.000Z"));

    await getTodayView("user-1", "ASESOR");

    const due = whereDeTareas().dueDate as { lte: Date };
    expect(due.lte.toISOString()).toBe("2026-09-08T04:59:59.999Z");

    vi.useRealTimers();
  });
});

// Tarjeta #683. `contactScope` viajaba como filtro de la relación contact en los dos
// conteos que la usan (temporizadores en riesgo y conversaciones sin leer) y no
// descartaba los contactos borrados. Con ámbito global el objeto quedaba vacío, así que
// esos dos números incluían trabajo pendiente de contactos que ya no existen.
//
// En producción, el 2026-09-08, 18 de 131 contactos están borrados: el 14%.
describe("getTodayView — los contactos borrados no aparecen en la vista (#683)", () => {
  /** El filtro de la relación contact en los conteos que lo usan. */
  function contactoEnTemporizadores(): Record<string, unknown> {
    return slaCount.mock.calls[0][0].where.contact;
  }
  function contactoEnConversaciones(): Record<string, unknown> {
    return conversationCount.mock.calls[0][0].where.contact;
  }

  it("con ámbito global (dirección) descarta los borrados en vez de no filtrar nada", async () => {
    await getTodayView("user-1", "DIRECTOR");

    // Antes esto era `{}`: sin dueño que filtrar, no quedaba ninguna condición.
    expect(contactoEnTemporizadores().deletedAt).toBeNull();
    expect(contactoEnConversaciones().deletedAt).toBeNull();
  });

  it("con ámbito propio conserva el dueño Y añade el borrado", async () => {
    await getTodayView("user-1", "ASESOR_JR");

    expect(contactoEnTemporizadores()).toEqual({
      deletedAt: null,
      assignedToId: { in: ["user-1"] },
    });
  });

  it("los dos conteos de contactos de la vista usan el mismo criterio", async () => {
    // La incoherencia era dentro de la MISMA pantalla: los leads nuevos sí filtraban
    // borrados y los temporizadores no.
    await getTodayView("user-1", "DIRECTOR");

    expect(contactCount.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(contactoEnTemporizadores().deletedAt).toBeNull();
  });
});

describe("getTodayView — clientes esperando respuesta (#990)", () => {
  const hace3h = new Date(Date.now() - 3 * 3600000);
  const conv = (id: string) => ({
    id, channel: "WHATSAPP", status: "HUMAN", snoozedUntil: null, controlledById: "user-1", connectorId: null, connector: null,
    unreadCount: 0, lastInboundAt: hace3h,
    contact: { id: `ct-${id}`, firstName: "Ana", lastName: id, assignedToId: null, targetPlaza: null },
  });
  /** La consulta de esperando es la única que filtra por status HUMAN con AND. */
  const llamadaEspera = () => conversationFindMany.mock.calls.map((c) => c[0]).find((a) => a?.where?.AND);

  it("con unreadCount 0 y último mensaje INBOUND sí aparece, con el tiempo que lleva", async () => {
    conversationFindMany.mockImplementation(async (a: { where?: { AND?: unknown } }) => (a?.where?.AND ? [conv("c1")] : []));
    messageGroupBy.mockResolvedValue([{ conversationId: "c1", direction: "INBOUND", _max: { createdAt: hace3h } }]);

    const v = await getTodayView("user-1", "ASESOR");

    expect(v.esperandoRespuesta.count).toBe(1);
    expect(v.esperandoRespuesta.items[0]).toMatchObject({ id: "c1", href: "/inbox?c=c1", meta: "escribió hace 3 h" });
    // Sin filtro por unreadCount ni umbral de tiempo; solo lo mío y contactos vivos.
    const where = JSON.stringify(llamadaEspera()!.where);
    expect(where).not.toContain("unreadCount");
    expect(where).toContain('"controlledById":"user-1"');
    expect(where).toContain('"deletedAt":null');
  });

  it("si ya contestamos (último saliente) no aparece", async () => {
    conversationFindMany.mockImplementation(async (a: { where?: { AND?: unknown } }) => (a?.where?.AND ? [conv("c1")] : []));
    messageGroupBy.mockResolvedValue([
      { conversationId: "c1", direction: "INBOUND", _max: { createdAt: hace3h } },
      { conversationId: "c1", direction: "OUTBOUND", _max: { createdAt: new Date(hace3h.getTime() + 60000) } },
    ]);
    const v = await getTodayView("user-1", "ASESOR");
    expect(v.esperandoRespuesta.count).toBe(0);
  });
});
