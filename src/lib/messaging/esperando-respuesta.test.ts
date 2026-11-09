import { describe, it, expect, vi, beforeEach } from "vitest";

const gerenciaDeLaPlaza = vi.fn();
const destinatariosHiloSinDueno = vi.fn();

vi.mock("@/lib/db", () => ({ default: {} }));
vi.mock("@/lib/workflows/gerencia", () => ({ gerenciaDeLaPlaza: (...a: unknown[]) => gerenciaDeLaPlaza(...a) }));
vi.mock("./aviso-sin-dueno", () => ({
  destinatariosHiloSinDueno: (...a: unknown[]) => destinatariosHiloSinDueno(...a),
}));

import {
  esperandoDesde,
  nivelAlcanzado,
  nivelAAvisar,
  nivelYaAvisado,
  primerResponsable,
  destinatariosNivel2,
  haceCuanto,
  textoDelAviso,
  revisarConversacionesEsperando,
  type AvisoPrevio,
} from "./esperando-respuesta";
import { DIAS_MAXIMOS_RECORDATORIO } from "./esperando-respuesta";
import { HORARIO_POR_DEFECTO } from "@/lib/workflows/business-hours";

// Cancún = UTC-5, lunes a sábado 09-18 (HORARIO_POR_DEFECTO). 2026-11-09 es lunes.
const LUN_10 = new Date("2026-11-09T15:00:00Z"); // lunes 10:00 local
const LUN_12 = new Date("2026-11-09T17:00:00Z"); // +120 min hábiles
const LUN_18 = new Date("2026-11-09T23:00:00Z"); // +480 min hábiles (cierre)
// Martes 09:30 local: ya abrió la oficina y el nivel 2 (vencido al cierre del lunes) puede avisarse.
const MAR_0930 = new Date("2026-11-10T14:30:00Z");
const SAB_17 = new Date("2026-11-14T22:00:00Z"); // sábado 17:00 local

describe("esperandoDesde", () => {
  const base = { status: "HUMAN", snoozedUntil: null, ultimoNoInterno: { direction: "INBOUND" as const, createdAt: LUN_10 } };

  it("HUMAN con último mensaje del cliente espera desde ese mensaje", () => {
    expect(esperandoDesde(base, LUN_12)).toEqual(LUN_10);
  });
  it("si lo último es nuestro (o no hay mensajes) no espera", () => {
    expect(esperandoDesde({ ...base, ultimoNoInterno: { direction: "OUTBOUND", createdAt: LUN_10 } }, LUN_12)).toBeNull();
    expect(esperandoDesde({ ...base, ultimoNoInterno: null }, LUN_12)).toBeNull();
  });
  it("solo HUMAN", () => {
    expect(esperandoDesde({ ...base, status: "BOT" }, LUN_12)).toBeNull();
  });
  it("pospuesta en el futuro no cuenta; vencido el snooze sí", () => {
    expect(esperandoDesde({ ...base, snoozedUntil: new Date(LUN_12.getTime() - 1000) }, LUN_12)).toEqual(LUN_10);
    expect(esperandoDesde({ ...base, snoozedUntil: new Date(LUN_12.getTime() + 60000) }, LUN_12)).toBeNull();
  });
});

describe("nivelAlcanzado (minutos hábiles)", () => {
  const h = HORARIO_POR_DEFECTO;
  it("119 min hábiles no llegan; 120 sí (nivel 1)", () => {
    expect(nivelAlcanzado(LUN_10, new Date(LUN_12.getTime() - 60000), h)).toBe(0);
    expect(nivelAlcanzado(LUN_10, LUN_12, h)).toBe(1);
  });
  it("480 min hábiles: nivel 2", () => {
    expect(nivelAlcanzado(LUN_10, new Date(LUN_18.getTime() - 60000), h)).toBe(1);
    expect(nivelAlcanzado(LUN_10, LUN_18, h)).toBe(2);
  });
  it("las horas de noche y el domingo no cuentan", () => {
    // Sábado 17:00 → queda 1 h hábil el sábado; domingo cerrado → domingo 12:00 local aún no llega.
    expect(nivelAlcanzado(SAB_17, new Date("2026-11-15T17:00:00Z"), h)).toBe(0);
    // Lunes 09:00 local = 14:00Z → solo 60 min hábiles; el nivel 1 llega a las 10:00 local.
    expect(nivelAlcanzado(SAB_17, new Date("2026-11-16T14:00:00Z"), h)).toBe(0);
    expect(nivelAlcanzado(SAB_17, new Date("2026-11-16T15:00:00Z"), h)).toBe(1);
  });
});

describe("candado contra repetición", () => {
  const aviso = (type: string, createdAt: Date, link = "/inbox?c=c1"): AvisoPrevio => ({ type, link, createdAt });
  const dentro = (ms: number) => new Date(LUN_10.getTime() + ms);

  it("un aviso del nivel posterior al mensaje del cliente lo bloquea", () => {
    const avisos = [aviso("conversation_waiting_1", LUN_12)];
    expect(nivelYaAvisado(avisos, "c1", 1, LUN_10)).toBe(true);
    expect(nivelAAvisar({ conversationId: "c1", desde: LUN_10, ahora: LUN_12, horario: HORARIO_POR_DEFECTO, avisos })).toBe(0);
  });
  it("si el cliente vuelve a escribir, el aviso anterior ya no cuenta (reinicio)", () => {
    const avisos = [aviso("conversation_waiting_1", LUN_12)];
    const nuevoMensaje = new Date(LUN_12.getTime() + 3600000); // 13:00 local
    const ahora = new Date(LUN_12.getTime() + 3600000 + 2 * 3600000);
    expect(
      nivelAAvisar({ conversationId: "c1", desde: nuevoMensaje, ahora, horario: HORARIO_POR_DEFECTO, avisos }),
    ).toBe(1);
  });
  it("el aviso de otro hilo no bloquea", () => {
    expect(nivelYaAvisado([aviso("conversation_waiting_1", LUN_12, "/inbox?c=otra")], "c1", 1, LUN_10)).toBe(false);
  });
  it("con nivel 1 ya enviado, al llegar a 480 sale solo el 2", () => {
    const avisos = [aviso("conversation_waiting_1", LUN_12)];
    expect(nivelAAvisar({ conversationId: "c1", desde: LUN_10, ahora: LUN_18, horario: HORARIO_POR_DEFECTO, avisos })).toBe(2);
    expect(
      nivelAAvisar({
        conversationId: "c1", desde: LUN_10, ahora: LUN_18, horario: HORARIO_POR_DEFECTO,
        avisos: [...avisos, aviso("conversation_waiting_2", LUN_18)],
      }),
    ).toBe(0);
  });
  it("rezagada sin nivel 1: solo el 2, no los dos de golpe", () => {
    expect(nivelAAvisar({ conversationId: "c1", desde: LUN_10, ahora: dentro(5 * 86400000), horario: HORARIO_POR_DEFECTO, avisos: [] })).toBe(2);
  });
});

describe("destinatarios", () => {
  it("responsable: el primero que sea persona (la cuenta técnica se salta)", () => {
    const personas = new Set(["asesor"]);
    expect(primerResponsable(["agentes-local", "asesor"], personas)).toBe("asesor");
    expect(primerResponsable([null, "agentes-local"], personas)).toBeNull();
  });
  it("nivel 2: gerencia + responsables sin repetir a quien ya recibió el nivel 1", () => {
    expect(
      destinatariosNivel2({ responsables: ["luis"], gerencia: ["luis", "gerente"], admins: ["admin"], yaAvisados: new Set(["luis"]) }),
    ).toEqual(["gerente"]);
  });
  it("nivel 2 sin gerencia cae a administradores", () => {
    expect(destinatariosNivel2({ responsables: ["luis"], gerencia: [], admins: ["admin"], yaAvisados: new Set(["luis"]) })).toEqual(["admin"]);
  });
});

describe("texto", () => {
  it("hace cuánto", () => {
    expect(haceCuanto(LUN_10, new Date(LUN_10.getTime() + 30 * 60000))).toBe("hace 30 min");
    expect(haceCuanto(LUN_10, new Date(LUN_10.getTime() + 3 * 3600000))).toBe("hace 3 h");
    expect(haceCuanto(LUN_10, new Date(LUN_10.getTime() + 3 * 86400000))).toBe("hace 3 d");
  });
  it("títulos y mensaje", () => {
    const d = { nombre: "Ana Pérez", canal: "WHATSAPP", marca: "Yaxnáh", desde: LUN_10, ahora: new Date(LUN_10.getTime() + 3 * 3600000) };
    expect(textoDelAviso(1, d).title).toBe("Cliente esperando respuesta");
    expect(textoDelAviso(2, d).title).toBe("Cliente sin respuesta desde hace un día");
    expect(textoDelAviso(1, d).message).toBe("Ana Pérez (WhatsApp, Yaxnáh) escribió hace 3 h y nadie ha contestado.");
  });
});

// ─────────────── Función con BD (prisma mockeado) ───────────────

function conv(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    channel: "WHATSAPP",
    status: "HUMAN",
    snoozedUntil: null,
    controlledById: "luis",
    connectorId: "cn1",
    connector: { brand: { name: "Yaxnáh" } },
    contact: { firstName: "Ana", lastName: "Pérez", assignedToId: null, targetPlaza: "CUN" },
    ...over,
  };
}

function fakeDb(o: {
  convs?: unknown[];
  grupos?: unknown[];
  avisos?: unknown[];
  personas?: unknown[];
  admins?: unknown[];
}) {
  return {
    slaPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    conversation: { findMany: vi.fn().mockResolvedValue(o.convs ?? []) },
    message: { groupBy: vi.fn().mockResolvedValue(o.grupos ?? []) },
    notification: {
      findMany: vi.fn().mockResolvedValue(o.avisos ?? []),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      findMany: vi.fn().mockImplementation(async (args: { where: { role?: string } }) =>
        args.where.role === "ADMIN" ? (o.admins ?? []) : (o.personas ?? [{ id: "luis", plaza: "CUN" }]),
      ),
    },
  };
}

const entra = (conversationId: string, at: Date) => ({ conversationId, direction: "INBOUND", _max: { createdAt: at } });
const sale = (conversationId: string, at: Date) => ({ conversationId, direction: "OUTBOUND", _max: { createdAt: at } });

beforeEach(() => {
  gerenciaDeLaPlaza.mockReset().mockResolvedValue(["gerente"]);
  destinatariosHiloSinDueno.mockReset().mockResolvedValue({ userIds: ["admin"], via: "admins", detalle: null });
});

describe("revisarConversacionesEsperando", () => {
  it("nivel 1: avisa al responsable, con UNA consulta de conversaciones, UNA agrupada y UNA de avisos", async () => {
    const db = fakeDb({ convs: [conv(), conv({ id: "c2" })], grupos: [entra("c1", LUN_10), entra("c2", LUN_10)] });
    const r = await revisarConversacionesEsperando(db as never, LUN_12);

    expect(db.conversation.findMany).toHaveBeenCalledTimes(1);
    expect(db.message.groupBy).toHaveBeenCalledTimes(1);
    expect(db.notification.findMany).toHaveBeenCalledTimes(1);
    expect(db.notification.createMany).toHaveBeenCalledTimes(1);
    const { data } = db.notification.createMany.mock.calls[0][0];
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      userId: "luis",
      type: "conversation_waiting_1",
      title: "Cliente esperando respuesta",
      link: "/inbox?c=c1",
    });
    expect(data[0].message).toContain("Ana Pérez (WhatsApp, Yaxnáh) escribió hace 2 h");
    expect(r).toMatchObject({ esperando: 2, nivel1: 2, nivel2: 0, notificaciones: 2 });
    // El filtro de la consulta pide HUMAN, sin posponer y contactos vivos.
    const where = db.conversation.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toMatchObject({ status: "HUMAN", contact: { deletedAt: null } });
    expect(where.AND[1]).toHaveProperty("lastInboundAt.lte"); // umbral de reloj del cron
    expect(where.AND[1]).toHaveProperty("lastInboundAt.gte"); // tope de 7 días: no avisa de hilos viejos
    // La agrupada ignora notas internas.
    expect(db.message.groupBy.mock.calls[0][0].where.internalNote).toBe(false);
  });

  it("antes de 120 min hábiles no avisa", async () => {
    const db = fakeDb({ convs: [conv()], grupos: [entra("c1", LUN_10)] });
    const r = await revisarConversacionesEsperando(db as never, new Date(LUN_12.getTime() - 60000));
    expect(db.notification.createMany).not.toHaveBeenCalled();
    expect(r.notificaciones).toBe(0);
  });

  it("si ya contestamos (lo último no interno es saliente) no avisa; la nota interna no cuenta", async () => {
    const db = fakeDb({
      convs: [conv()],
      // El groupBy ya excluye notas internas: la nota posterior al mensaje no aparece aquí.
      grupos: [entra("c1", LUN_10), sale("c1", new Date(LUN_10.getTime() + 60000))],
    });
    const r = await revisarConversacionesEsperando(db as never, MAR_0930);
    expect(r.esperando).toBe(0);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("candado: ya hay aviso del nivel 1 posterior al mensaje → no repite", async () => {
    const db = fakeDb({
      convs: [conv()],
      grupos: [entra("c1", LUN_10)],
      avisos: [{ userId: "luis", type: "conversation_waiting_1", link: "/inbox?c=c1", createdAt: LUN_12 }],
    });
    await revisarConversacionesEsperando(db as never, new Date(LUN_12.getTime() + 600000));
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });

  it("nivel 2: gerencia de la plaza del cliente, sin repetir al responsable que ya recibió el nivel 1", async () => {
    const db = fakeDb({
      convs: [conv()],
      grupos: [entra("c1", LUN_10)],
      avisos: [{ userId: "luis", type: "conversation_waiting_1", link: "/inbox?c=c1", createdAt: LUN_12 }],
    });
    gerenciaDeLaPlaza.mockResolvedValue(["luis", "gerente"]);
    const r = await revisarConversacionesEsperando(db as never, MAR_0930);
    expect(gerenciaDeLaPlaza).toHaveBeenCalledWith("CUN");
    const { data } = db.notification.createMany.mock.calls[0][0];
    expect(data.map((d: { userId: string }) => d.userId)).toEqual(["gerente"]);
    expect(data[0]).toMatchObject({ type: "conversation_waiting_2", title: "Cliente sin respuesta desde hace un día" });
    expect(r.nivel2).toBe(1);
  });

  it("nivel 2 sin plaza ni gerencia → administradores", async () => {
    const db = fakeDb({
      convs: [conv({ contact: { firstName: "Ana", lastName: "Pérez", assignedToId: null, targetPlaza: null } })],
      grupos: [entra("c1", LUN_10)],
      personas: [{ id: "luis", plaza: null }],
      admins: [{ id: "admin" }],
      avisos: [{ userId: "luis", type: "conversation_waiting_1", link: "/inbox?c=c1", createdAt: LUN_12 }],
    });
    await revisarConversacionesEsperando(db as never, MAR_0930);
    expect(gerenciaDeLaPlaza).not.toHaveBeenCalled();
    const { data } = db.notification.createMany.mock.calls[0][0];
    expect(data.map((d: { userId: string }) => d.userId)).toEqual(["admin"]);
  });

  it("sin responsable persona usa la cadena de «sin dueño»; las consultas de usuarios excluyen cuentas técnicas", async () => {
    const db = fakeDb({
      convs: [conv({ controlledById: "agentes", contact: { firstName: "Ana", lastName: "Pérez", assignedToId: null, targetPlaza: "CUN" } })],
      grupos: [entra("c1", LUN_10)],
      personas: [], // `agentes@propyte.local` no sale de la consulta de personas
    });
    await revisarConversacionesEsperando(db as never, LUN_12);
    expect(destinatariosHiloSinDueno).toHaveBeenCalledWith({ connectorId: "cn1", plaza: "CUN" });
    const { data } = db.notification.createMany.mock.calls[0][0];
    expect(data.map((d: { userId: string }) => d.userId)).toEqual(["admin"]);
    const whereUsuarios = db.user.findMany.mock.calls[0][0].where;
    expect(whereUsuarios).toMatchObject({ isActive: true, deletedAt: null, NOT: { email: { endsWith: ".local" } } });
  });

  it("fuera de horario hábil (domingo) no consulta la bandeja", async () => {
    const db = fakeDb({ convs: [conv()] });
    const r = await revisarConversacionesEsperando(db as never, new Date("2026-11-15T17:00:00Z"));
    expect(r.omitido).toBe("fuera_de_horario");
    expect(db.conversation.findMany).not.toHaveBeenCalled();
  });
});

describe("revisarConversacionesEsperando — horario", () => {
  it("el nivel vencido al cierre no se avisa de noche: espera a que abra la oficina", async () => {
    const db = fakeDb({ convs: [conv()], grupos: [entra("c1", LUN_10)], avisos: [] });
    await revisarConversacionesEsperando(db as never, LUN_18);
    expect(db.notification.createMany).not.toHaveBeenCalled();
  });
});

describe("antigüedad máxima del recordatorio", () => {
  it("solo revisa clientes que escribieron en los últimos 7 días", () => {
    expect(DIAS_MAXIMOS_RECORDATORIO).toBe(7);
  });
});
