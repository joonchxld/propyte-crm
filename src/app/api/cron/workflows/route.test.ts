import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const processPendingEvents = vi.fn();
const runQueue = vi.fn();
const recuperarEncalladas = vi.fn();
const checkSlaBreaches = vi.fn();
const reasignarSinPrimerContacto = vi.fn();
const runEnrollments = vi.fn();
const runInactivityRules = vi.fn();
const emitEvent = vi.fn();
const limpiarOtpVencidos = vi.fn();
const sincronizarCorreoEntranteTick = vi.fn();
const recalcularScores = vi.fn();
const recalcularTemperaturas = vi.fn();
const tickCadencias = vi.fn();
const completarPerfilDesdeHub = vi.fn();
const paymentFindMany = vi.fn();
const paymentUpdate = vi.fn();
/** Ejecuta el callback de `$transaction` con un `tx` mínimo. */
const transaction = vi.fn(
  async (fn: (tx: unknown) => unknown, tx: unknown) => await fn(tx),
);

vi.mock("@/lib/db", () => ({
  default: {
    paymentSchedule: {
      findMany: (...a: unknown[]) => paymentFindMany(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
    },
    // El estado y el evento de una parcialidad vencida van juntos desde la auditoría
    // 2026-09-10: si `emitEvent` fallaba, la parcialidad quedaba VENCIDA y el aviso no
    // salía nunca. El doble ejecuta el callback como lo haría Postgres.
    $transaction: (fn: (tx: unknown) => unknown) =>
      transaction(fn, { paymentSchedule: { update: (...a: unknown[]) => paymentUpdate(...a) } }),
  },
}));
vi.mock("@/lib/workflows/events", () => ({
  processPendingEvents: (...a: unknown[]) => processPendingEvents(...a),
  emitEvent: (...a: unknown[]) => emitEvent(...a),
}));
vi.mock("@/lib/workflows/queue", () => ({
  runQueue: (...a: unknown[]) => runQueue(...a),
  // Etapa añadida en la auditoría 2026-09-10: rescata las acciones que se quedaron en
  // RUNNING cuando el proceso murió a mitad de un envío. Ver lib/workflows/queue.ts.
  recuperarEncalladas: (...a: unknown[]) => recuperarEncalladas(...a),
}));
vi.mock("@/lib/workflows/sla", () => ({ checkSlaBreaches: (...a: unknown[]) => checkSlaBreaches(...a) }));
// Reasignación por falta de primer contacto: su lógica se prueba en
// lib/workflows/sla-reasignacion.test.ts; aquí solo cuenta que sea una etapa más del tick.
vi.mock("@/lib/workflows/sla-reasignacion", () => ({
  reasignarSinPrimerContacto: (...a: unknown[]) => reasignarSinPrimerContacto(...a),
}));
// #699 (defecto 2): etapa que retira los códigos de un solo uso ya vencidos. Se dobla
// aquí como las demás para que este archivo siga probando el AISLAMIENTO del tick y no la
// consulta del barrido, que tiene sus propias pruebas en lib/auth/otp-limpieza.test.ts.
vi.mock("@/lib/auth/otp-limpieza", () => ({
  limpiarOtpVencidos: (...a: unknown[]) => limpiarOtpVencidos(...a),
}));
// #889: etapa del correo entrante. Se dobla para probar su aislamiento en el tick; la
// lógica por cuenta tiene sus pruebas en lib/google/gmail-sync.test.ts.
vi.mock("@/lib/google/gmail-sync", () => ({
  sincronizarCorreoEntranteTick: (...a: unknown[]) => sincronizarCorreoEntranteTick(...a),
}));
// Lead scoring en sombra: se dobla para probar su aislamiento; el cálculo tiene sus pruebas en
// lib/scoring/calcular.test.ts.
vi.mock("@/lib/scoring/recalcular", () => ({
  recalcularScores: (...a: unknown[]) => recalcularScores(...a),
}));
vi.mock("@/lib/copilot/temperatura-recalcular", () => ({
  recalcularTemperaturas: (...a: unknown[]) => recalcularTemperaturas(...a),
}));
vi.mock("@/lib/copilot/cadencia-servicio", () => ({
  tickCadencias: (...a: unknown[]) => tickCadencias(...a),
}));
vi.mock("@/lib/intake/perfil-desde-hub", () => ({
  completarPerfilDesdeHub: (...a: unknown[]) => completarPerfilDesdeHub(...a),
}));
// Acuerdo de actividad (E8): se dobla para probar el aislamiento del tick; la logica tiene sus
// pruebas en lib/workflows/acuerdo-actividad.test.ts.
// #990: igual que el acuerdo de actividad: su lógica se prueba en messaging/esperando-respuesta.test.ts.
vi.mock("@/lib/messaging/esperando-respuesta", () => ({
  revisarConversacionesEsperando: async () => ({ revisadas: 0, esperando: 0, nivel1: 0, nivel2: 0, notificaciones: 0 }),
}));
vi.mock("@/lib/workflows/acuerdo-actividad", () => ({
  revisarAcuerdoDeActividad: async () => ({ asesores: 0, incumplidos: 0, notificaciones: 0 }),
}));
vi.mock("@/lib/workflows/scheduler", () => ({
  runEnrollments: (...a: unknown[]) => runEnrollments(...a),
  runInactivityRules: (...a: unknown[]) => runInactivityRules(...a),
}));

import { GET } from "./route";

const SECRET = "secreto_de_prueba";

function pedir(headers: Record<string, string> = {}, query = "") {
  return {
    headers: { get: (h: string) => headers[h] ?? null },
    nextUrl: new URL(`http://t/api/cron/workflows${query}`),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  processPendingEvents.mockResolvedValue({ procesados: 3 });
  runQueue.mockResolvedValue({ corridas: 2 });
  recuperarEncalladas.mockResolvedValue({ reencoladas: 0, agotadas: 0 });
  checkSlaBreaches.mockResolvedValue({ marcados: 1 });
  reasignarSinPrimerContacto.mockResolvedValue({ revisados: 0, reasignados: 0, omitidos: {} });
  runEnrollments.mockResolvedValue({ inscritos: 0 });
  runInactivityRules.mockResolvedValue({ disparadas: 0 });
  paymentFindMany.mockResolvedValue([]);
  paymentUpdate.mockResolvedValue({});
  limpiarOtpVencidos.mockResolvedValue(0);
  sincronizarCorreoEntranteTick.mockResolvedValue({ cuentas: 1, registrados: 0, omitidos: 0, desconectadas: 0, errores: [] });
  recalcularScores.mockResolvedValue({ calculados: 0, activo: false });
  recalcularTemperaturas.mockReset();
  recalcularTemperaturas.mockResolvedValue({ calculados: 0, cambiados: 0 });
  tickCadencias.mockReset();
  tickCadencias.mockResolvedValue({ cadencias: 0, toques: 0 });
  completarPerfilDesdeHub.mockResolvedValue({ revisados: 0, completados: 0, campos: 0 });
});

describe("etapa perfilMeta", () => {
  it("corre antes de leadScoring, para que el score vea el perfil recién llenado", async () => {
    const orden: string[] = [];
    completarPerfilDesdeHub.mockImplementation(async () => {
      orden.push("perfilMeta");
      return { revisados: 1, completados: 1, campos: 3 };
    });
    recalcularScores.mockImplementation(async () => {
      orden.push("leadScoring");
      return { calculados: 1, activo: false };
    });
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(orden).toEqual(["perfilMeta", "leadScoring"]);
  });

  it("si revienta, sale con su nombre y no tumba al score", async () => {
    completarPerfilDesdeHub.mockRejectedValue(new Error("hub caído"));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["perfilMeta"]);
    expect(recalcularScores).toHaveBeenCalled();
  });
});

describe("etapa leadScoring", () => {
  it("con contact_scores sin migrar (P2021) no tumba el tick", async () => {
    recalcularScores.mockRejectedValue(Object.assign(new Error("tabla no existe"), { code: "P2021" }));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect((await res.json()).leadScoring).toEqual({ calculados: 0, sinMigrar: true });
  });

  it("cualquier otro error sale con su nombre y el tick responde 500", async () => {
    recalcularScores.mockRejectedValue(new Error("conexión caída"));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(500);
    expect((await res.json()).fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["leadScoring"]);
  });
});

describe("etapa temperatura (#973)", () => {
  it("corre en cada tick con un lote de 200", async () => {
    recalcularTemperaturas.mockResolvedValue({ calculados: 12, cambiados: 3 });
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(recalcularTemperaturas).toHaveBeenCalledWith(200);
    expect((await res.json()).temperatura).toEqual({ calculados: 12, cambiados: 3 });
  });

  it("con contact_temperaturas sin migrar (P2021) no tumba el tick", async () => {
    recalcularTemperaturas.mockRejectedValue(Object.assign(new Error("tabla no existe"), { code: "P2021" }));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect((await res.json()).temperatura).toEqual({ calculados: 0, sinMigrar: true });
  });

  it("cualquier otro error sale con su nombre y el tick responde 500", async () => {
    recalcularTemperaturas.mockRejectedValue(new Error("conexión caída"));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(500);
    expect((await res.json()).fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["temperatura"]);
  });
});

/** Una parcialidad vencida tal como la selecciona `checkOverduePayments`. */
function parcialidad(id: string) {
  return {
    id,
    number: 1,
    amount: "1000",
    dueDate: new Date("2026-01-01"),
    plan: { quote: { dealId: `deal-${id}` } },
  };
}

afterEach(() => {
  delete process.env.CRON_SECRET;
});

/**
 * #664 — el tick corría sus siete etapas bajo UN solo try/catch.
 *
 * Si la primera tropezaba, las seis siguientes no llegaban a correr: entre ellas la que
 * marca fuera de tiempo las respuestas a prospectos nuevos y la que dispara los seguimientos
 * programados. El sistema no se cae ni avisa — simplemente deja de pasar el tiempo para todo
 * lo que depende del reloj, y desde fuera se ve igual que un día tranquilo.
 */
describe("GET /api/cron/workflows — aislamiento por etapa", () => {
  it("con todo en orden corre todas las etapas y responde ok", async () => {
    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body).toMatchObject({
      events: { procesados: 3 },
      encalladas: { reencoladas: 0, agotadas: 0 },
      queue: { corridas: 2 },
      slaBreaches: { marcados: 1 },
      slaReasignacion: { revisados: 0, reasignados: 0 },
    });
    expect(typeof body.ms).toBe("number");
  });

  it("la reasignación corre DESPUÉS de marcar los vencimientos y su fallo no tumba a las demás", async () => {
    const orden: string[] = [];
    checkSlaBreaches.mockImplementation(async () => { orden.push("slaBreaches"); return { marcados: 0 }; });
    reasignarSinPrimerContacto.mockImplementation(async () => { orden.push("slaReasignacion"); throw new Error("boom"); });
    runEnrollments.mockImplementation(async () => { orden.push("enrollments"); return { inscritos: 0 }; });

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(orden).toEqual(["slaBreaches", "slaReasignacion", "enrollments"]);
    expect(r.status).toBe(500);
    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["slaReasignacion"]);
  });

  /**
   * #699 (defecto 2). La etapa NO lleva `try` propio, a diferencia de las que tocan tablas
   * que pueden no estar migradas: `users` existe desde el init, así que un fallo suyo es un
   * fallo de verdad y tiene que verse. Estas dos pruebas son lo que impide que alguien
   * "arregle" el ruido envolviéndola en un catch que devuelva 0 — que es literalmente el
   * defecto que la auditoría del 2026-09-10 encontró en `overduePayments`.
   */
  it("el barrido de códigos vencidos corre y reporta cuántos retiró", async () => {
    limpiarOtpVencidos.mockResolvedValue(3);

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(limpiarOtpVencidos).toHaveBeenCalledTimes(1);
    expect(body.otpVencidos).toBe(3);
    expect(r.status).toBe(200);
  });

  it("si el barrido revienta, sale con su nombre y el tick responde 500", async () => {
    limpiarOtpVencidos.mockRejectedValue(new Error("boom en el barrido"));

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toContain("otpVencidos");
    // Y no se lleva por delante a las demás: eso es el #664.
    expect(body).toMatchObject({ events: { procesados: 3 }, queue: { corridas: 2 } });
  });

  it("#889: el correo entrante se revisa en cada tick y reporta lo que registró", async () => {
    sincronizarCorreoEntranteTick.mockResolvedValue({ cuentas: 1, registrados: 2, omitidos: 0, desconectadas: 0, errores: [] });

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(sincronizarCorreoEntranteTick).toHaveBeenCalledTimes(1);
    expect(body.correoEntrante).toMatchObject({ registrados: 2 });
    expect(r.status).toBe(200);
  });

  it("#889: si la revisión de correo revienta, sale con su nombre y no tumba a las demás", async () => {
    sincronizarCorreoEntranteTick.mockRejectedValue(new Error("correo entrante: 1 cuenta(s) con error"));

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["correoEntrante"]);
    expect(body).toMatchObject({ events: { procesados: 3 }, queue: { corridas: 2 }, otpVencidos: 0 });
  });

  it("el rescate de encalladas corre ANTES de la cola, para que entren en la misma pasada", async () => {
    const orden: string[] = [];
    recuperarEncalladas.mockImplementation(async () => {
      orden.push("encalladas");
      return { reencoladas: 1, agotadas: 0 };
    });
    runQueue.mockImplementation(async () => {
      orden.push("queue");
      return { corridas: 2 };
    });

    await GET(pedir({ "x-cron-secret": SECRET }));

    expect(orden).toEqual(["encalladas", "queue"]);
  });

  /**
   * 🚨 El caso del hallazgo: revienta la PRIMERA etapa. Antes eso cancelaba las seis
   * siguientes; ahora todas corren igual.
   */
  it("si la primera etapa revienta, las seis siguientes SÍ corren", async () => {
    processPendingEvents.mockRejectedValue(new Error("boom en eventos"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    // Las que importan para que el tiempo siga pasando:
    expect(checkSlaBreaches).toHaveBeenCalled();
    expect(runEnrollments).toHaveBeenCalled();
    expect(runInactivityRules).toHaveBeenCalled();
    expect(runQueue).toHaveBeenCalled();
    // Y su trabajo aparece en la respuesta, no se pierde.
    expect(body.slaBreaches).toEqual({ marcados: 1 });
    err.mockRestore();
  });

  it("el fallo se reporta con el NOMBRE de la etapa que lo produjo", async () => {
    checkSlaBreaches.mockRejectedValue(new Error("la base dijo que no"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = await (await GET(pedir({ "x-cron-secret": SECRET }))).json();

    expect(body.fallos).toHaveLength(1);
    expect(body.fallos[0].etapa).toBe("slaBreaches");
    expect(body.fallos[0].error).toMatch(/la base dijo que no/);
    err.mockRestore();
  });

  /**
   * Un 200 con los fallos escondidos en el cuerpo sería peor que el bug original: este
   * endpoint corre cada minuto sin que nadie lea su respuesta, y cualquier monitor externo
   * mira el status.
   */
  it("con una etapa caída responde 500, aunque las otras seis hayan ido bien", async () => {
    runEnrollments.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.events).toEqual({ procesados: 3 }); // lo que sí corrió viaja igual
    err.mockRestore();
  });

  it("varias etapas caídas se reportan todas, no solo la primera", async () => {
    processPendingEvents.mockRejectedValue(new Error("uno"));
    runInactivityRules.mockRejectedValue(new Error("dos"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = await (await GET(pedir({ "x-cron-secret": SECRET }))).json();

    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["events", "inactivity"]);
    err.mockRestore();
  });

  // Control: la guardia de autorización no se toca.
  it("sin el secreto sigue siendo 401 y no corre nada", async () => {
    const r = await GET(pedir({}));

    expect(r.status).toBe(401);
    expect(processPendingEvents).not.toHaveBeenCalled();
  });
});

// Auditoría 2026-09-10: `checkOverduePayments` envolvía TODO su cuerpo en un
// `catch { return 0 }`. Un fallo real —una restricción violada, la conexión caída a mitad
// del lote— se veía desde fuera igual que «hoy no había parcialidades vencidas»: la etapa
// reportaba 0 y el tick salía 200. Justo el fallo silencioso que la etapa existe para
// evitar.
describe("GET /api/cron/workflows — parcialidades vencidas", () => {
  it("marca cada parcialidad y emite su evento", async () => {
    paymentFindMany.mockResolvedValue([parcialidad("p1"), parcialidad("p2")]);

    const body = await (await GET(pedir({ "x-cron-secret": SECRET }))).json();

    expect(body.overduePayments).toBe(2);
    expect(paymentUpdate).toHaveBeenCalledTimes(2);
    expect(emitEvent).toHaveBeenCalledWith(
      "payment.overdue",
      "deal",
      "deal-p1",
      expect.objectContaining({ scheduleId: "p1" }),
    );
  });

  it("el estado y el evento van en la MISMA transacción", async () => {
    paymentFindMany.mockResolvedValue([parcialidad("p1")]);

    await GET(pedir({ "x-cron-secret": SECRET }));

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("una parcialidad que falla no impide las demás, y sólo cuenta las que sí se marcaron", async () => {
    paymentFindMany.mockResolvedValue([parcialidad("p1"), parcialidad("p2"), parcialidad("p3")]);
    emitEvent.mockRejectedValueOnce(new Error("el motor de eventos falló"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    // Dos de tres. Antes devolvía `overdue.length` (3) aunque el lote entero fallara.
    expect(body.overduePayments).toBe(2);
    // Y la etapa no tumba el tick: el fallo es de una fila, no de la etapa.
    expect(r.status).toBe(200);
    err.mockRestore();
  });

  it("🚨 un error real de la base ya NO se disfraza de «no había vencidas»", async () => {
    paymentFindMany.mockRejectedValue(new Error("connection refused"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(500);
    expect(body.fallos.map((f: { etapa: string }) => f.etapa)).toContain("overduePayments");
    err.mockRestore();
  });

  it("pero la tabla sin migrar (P2021) sigue perdonándose con 0", async () => {
    // Es la ÚNICA condición que el `try` original venía a cubrir.
    paymentFindMany.mockRejectedValue(Object.assign(new Error("no existe"), { code: "P2021" }));

    const r = await GET(pedir({ "x-cron-secret": SECRET }));
    const body = await r.json();

    expect(r.status).toBe(200);
    expect(body.overduePayments).toBe(0);
  });
});

describe("etapa cadencias (#988)", () => {
  it("corre en cada tick, después de la temperatura", async () => {
    const orden: string[] = [];
    recalcularTemperaturas.mockImplementation(async () => (orden.push("temperatura"), { calculados: 0, cambiados: 0 }));
    tickCadencias.mockImplementation(async () => (orden.push("cadencias"), { cadencias: 2, toques: 9 }));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect(orden).toEqual(["temperatura", "cadencias"]);
    expect((await res.json()).cadencias).toEqual({ cadencias: 2, toques: 9 });
  });

  it("con las tablas de Copilot sin migrar (P2021, o 42P01 en una consulta cruda) no tumba el tick", async () => {
    tickCadencias.mockRejectedValueOnce(Object.assign(new Error("tabla no existe"), { code: "P2021" }));
    let res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
    expect((await res.json()).cadencias).toEqual({ cadencias: 0, sinMigrar: true });

    tickCadencias.mockRejectedValueOnce(
      Object.assign(new Error('relation "propyte_crm.copilot_cadencias" does not exist'), { code: "P2010", meta: { code: "42P01" } }),
    );
    res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(200);
  });

  it("cualquier otro error sale con su nombre y el tick responde 500", async () => {
    tickCadencias.mockRejectedValue(new Error("conexión caída"));
    const res = await GET(pedir({ "x-cron-secret": SECRET }));
    expect(res.status).toBe(500);
    expect((await res.json()).fallos.map((f: { etapa: string }) => f.etapa)).toEqual(["cadencias"]);
  });
});
