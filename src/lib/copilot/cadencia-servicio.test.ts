// #988 / #993 — El servicio de cadencias con un cliente de base doblado en memoria. Las consultas
// crudas (señales, citas, vencidas, tablero) y el disparador se probaron contra un Postgres 16 real;
// aquí va la lógica de qué se escribe y en qué orden.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clasificar, marcarResultado, materializarCadencias, terminarCadenciasVencidas } from "./cadencia-servicio";
import { CADENCIAS_INICIALES } from "./cadencias-def";

type Fila = Record<string, unknown>;

const { db, cliente } = vi.hoisted(() => {
  const db = {
    defs: [] as Fila[],
    pasos: [] as Fila[],
    plantillas: [] as Fila[],
    cadencias: [] as Fila[],
    toques: [] as Fila[],
    contactos: [] as Fila[],
    clasificaciones: [] as Fila[],
    fuentes: [] as string[],
    orden: [] as string[],
    raw: [] as unknown[],
  };
  let n = 0;
  const nuevoId = (p: string) => `${p}${++n}`;

  function coincide(f: Fila, where: Fila = {}): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const o = v as { in?: unknown[]; lte?: Date; not?: unknown };
        if (o.in) return o.in.includes(f[k]);
        if (o.lte) return new Date(f[k] as string) <= o.lte;
      }
      return (f[k] ?? null) === v;
    });
  }
  function tabla(nombre: keyof typeof db, prefijo: string) {
    const filas = () => db[nombre] as Fila[];
    return {
      findUnique: vi.fn(async ({ where }: { where: Fila }) => filas().find((x) => coincide(x, where)) ?? null),
      findFirst: vi.fn(async ({ where }: { where?: Fila } = {}) => filas().find((x) => coincide(x, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where?: Fila } = {}) => filas().filter((x) => coincide(x, where))),
      create: vi.fn(async ({ data }: { data: Fila }) => {
        db.orden.push(`${String(nombre)}:crear`);
        const f = { id: nuevoId(prefijo), estado: "ACTIVA", resultado: null, createdAt: new Date(), ...data };
        filas().push(f);
        return f;
      }),
      update: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
        db.orden.push(`${String(nombre)}:${String(data.estado ?? "update")}`);
        const f = filas().find((x) => coincide(x, where))!;
        return Object.assign(f, data);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
        const fs = filas().filter((x) => coincide(x, where));
        if (fs.length) db.orden.push(`${String(nombre)}:${String(data.estado ?? "updateMany")}`);
        fs.forEach((f) => Object.assign(f, data));
        return { count: fs.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Fila }) => {
        db.orden.push(`${String(nombre)}:borrar`);
        const antes = filas().length;
        (db[nombre] as Fila[]) = filas().filter((x) => !coincide(x, where));
        return { count: antes - filas().length };
      }),
      createMany: vi.fn(async ({ data }: { data: Fila[] }) => {
        let c = 0;
        for (const d of data) {
          if (filas().some((x) => x.cadenciaId === d.cadenciaId && x.codigo === d.codigo)) continue;
          filas().push({ id: nuevoId(prefijo), resultado: null, ...d });
          c++;
        }
        return { count: c };
      }),
    };
  }

  const cliente = {
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, fuente: string) => {
      db.fuentes.push(fuente);
      return 1;
    }),
    $queryRaw: vi.fn(async () => db.raw),
    $transaction: vi.fn(async (x: unknown) => (typeof x === "function" ? (x as (tx: unknown) => unknown)(cliente) : Promise.all(x as unknown[]))),
    copilotCadenciaDef: tabla("defs", "d"),
    copilotCadenciaPaso: tabla("pasos", "p"),
    copilotPlantilla: tabla("plantillas", "pl"),
    copilotCadencia: tabla("cadencias", "k"),
    copilotToque: tabla("toques", "t"),
    copilotClasificacion: tabla("clasificaciones", "c"),
    contact: tabla("contactos", "x"),
  };
  return { db, cliente };
});

vi.mock("@/lib/db", () => ({ default: cliente }));

const ANTES = new Date("2026-01-01T00:00:00Z"); // los pasos sembrados ya existían
const AHORA = new Date("2026-11-06T16:00:00Z"); // día 2 de una cadencia que empezó el 05-nov

function sembrarCatalogo() {
  db.defs = CADENCIAS_INICIALES.map((d) => ({
    tipo: d.tipo,
    nombre: d.nombre,
    rama: d.rama,
    descripcion: d.descripcion,
    disparador: d.disparador,
    anclaTipo: d.anclaTipo,
    estados: d.estados,
    respuestaTermina: d.respuestaTermina,
    terminaConCita: d.terminaConCita,
    ignoraNoContactar: d.ignoraNoContactar,
    finDias: d.finDias,
    finAncla: d.finAncla,
    finEstado: d.fin.estado,
    finSubestado: d.fin.subestado,
    finRazon: d.fin.razon,
    finSiguiente: d.fin.siguiente,
    activa: d.activa,
    orden: d.orden,
    updatedAt: ANTES,
  }));
  db.pasos = CADENCIAS_INICIALES.flatMap((d) => d.pasos.map((p, i) => ({ id: `${d.tipo}-${i}`, tipo: d.tipo, ...p, createdAt: ANTES })));
  db.plantillas = ["WA1", "CORREO1", "R_A1", "R_B2a", "R_B1"].map((codigo) => ({ codigo }));
}

beforeEach(() => {
  sembrarCatalogo();
  db.cadencias = [
    {
      id: "k1",
      contactId: "c1",
      tipo: "NUEVOS",
      estado: "ACTIVA",
      inicio: new Date("2026-11-05T15:00:00Z"),
      anclaAt: new Date("2026-11-05T15:00:00Z"),
      diaInicio: new Date("2026-11-05T00:00:00Z"),
      horaEntrada: 10,
      primerIntentoAt: null,
    },
  ];
  const p = new Date("2026-11-05T15:00:00Z");
  db.toques = [
    { id: "L1", cadenciaId: "k1", contactId: "c1", dia: 1, codigo: "L1", canal: "LLAMADA", resultado: null, programadoAt: p },
    { id: "WA1", cadenciaId: "k1", contactId: "c1", dia: 1, codigo: "WA1", canal: "WHATSAPP", resultado: null, programadoAt: p },
    { id: "L2", cadenciaId: "k1", contactId: "c1", dia: 1, codigo: "L2", canal: "LLAMADA", resultado: "NO_CONTESTO", programadoAt: p },
  ];
  db.contactos = [
    {
      id: "c1",
      estado: "NUEVO",
      subestado: null,
      phone: "+529841234567",
      leadSource: "META_ADS",
      whatsappOptOut: false,
      fechaRecontacto: null,
      doNotContact: false,
      deletedAt: null,
      reactivaciones: 0,
    },
  ];
  db.clasificaciones = [];
  db.fuentes = [];
  db.orden = [];
  db.raw = [];
});

describe("marcarResultado", () => {
  it("un intento (no contestó) pasa Nuevo → Sin respuesta y guarda el primer intento", async () => {
    const r = await marcarResultado({ toqueId: "L1", resultado: "NO_CONTESTO", usuarioId: "u1", ahora: AHORA });
    expect(r).toEqual({ ok: true, pausada: false });
    expect(db.contactos[0].estado).toBe("SIN_RESPUESTA");
    expect(db.cadencias[0].primerIntentoAt).toEqual(AHORA);
    expect(db.fuentes).toEqual(["copilot_cadencia"]);
  });

  it("contestó una persona: la cadencia se PAUSA, queda «Clasificar respuesta» y el contacto pasa a Contactado; lo pendiente se guarda", async () => {
    const r = await marcarResultado({ toqueId: "L1", resultado: "CONTESTO", usuarioId: "u1", ahora: AHORA });
    expect(r).toEqual({ ok: true, pausada: true });
    expect(db.cadencias[0]).toMatchObject({ estado: "PAUSADA", respuestaAt: AHORA });
    expect(db.clasificaciones).toHaveLength(1);
    expect(db.clasificaciones[0]).toMatchObject({ contactId: "c1", cadenciaId: "k1", estadoAntes: "NUEVO", resultado: null });
    expect(db.contactos[0]).toMatchObject({ estado: "CONTACTADO", subestado: "EN_CONVERSACION" });
    expect(db.toques.map((t) => t.codigo)).toEqual(["L1", "WA1", "L2"]);
  });

  it("en una cadencia que no se detiene con la respuesta (Agendar), «respondió» solo se registra", async () => {
    db.cadencias[0].tipo = "AGENDAR";
    db.contactos[0].estado = "CONTACTADO";
    const r = await marcarResultado({ toqueId: "WA1", resultado: "RESPONDIO", usuarioId: "u1", ahora: AHORA });
    expect(r).toEqual({ ok: true, pausada: false });
    expect(db.cadencias[0].estado).toBe("ACTIVA");
    expect(db.clasificaciones).toHaveLength(0);
  });

  it("rechaza un resultado de otro canal, un toque que todavía no toca y una cadencia que no está activa", async () => {
    expect(await marcarResultado({ toqueId: "L1", resultado: "ENVIADO", usuarioId: "u1", ahora: AHORA })).toMatchObject({ ok: false, status: 400 });
    db.toques.push({ id: "L4", cadenciaId: "k1", contactId: "c1", dia: 4, codigo: "L4", canal: "LLAMADA", resultado: null, programadoAt: new Date("2026-11-08T05:00:00Z") });
    expect(await marcarResultado({ toqueId: "L4", resultado: "NO_CONTESTO", usuarioId: "u1", ahora: AHORA })).toMatchObject({ ok: false, status: 409 });
    db.cadencias[0].estado = "PAUSADA";
    expect(await marcarResultado({ toqueId: "L1", resultado: "NO_CONTESTO", usuarioId: "u1", ahora: AHORA })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("clasificar (R2)", () => {
  async function pausar() {
    await marcarResultado({ toqueId: "L1", resultado: "CONTESTO", usuarioId: "u1", ahora: AHORA });
    return db.clasificaciones[0].id as string;
  }

  it("Interesado: cierra la general, deja al contacto en Contactado y abre «Agendar cita» desde la respuesta, con su A1 ya creado", async () => {
    const id = await pausar();
    const r = await clasificar({ clasificacionId: id, resultado: "INTERESADO", usuarioId: "u1", ahora: new Date(AHORA.getTime() + 60_000) });
    expect(r).toEqual({ ok: true, cadencia: "AGENDAR" });
    expect(db.cadencias.find((k) => k.id === "k1")).toMatchObject({ estado: "TERMINADA", motivoFin: "RESPONDIO" });
    // Lo pendiente de la general se quita; lo hecho queda.
    expect(db.toques.filter((t) => t.cadenciaId === "k1").map((t) => t.codigo)).toEqual(["L1", "L2"]);
    const agendar = db.cadencias.find((k) => k.tipo === "AGENDAR")!;
    expect(agendar).toMatchObject({ estado: "ACTIVA", anclaAt: AHORA, anclaTipo: "RESPUESTA", origenId: "k1" });
    expect(db.contactos[0]).toMatchObject({ estado: "CONTACTADO", subestado: "EN_CONVERSACION" });
    expect(db.toques.filter((t) => t.cadenciaId === agendar.id).map((t) => t.codigo)).toEqual(["A1"]);
    expect(db.clasificaciones[0]).toMatchObject({ resultado: "INTERESADO", resueltaPorId: "u1" });
  });

  it("Ahora no sin fecha: 90 días, Contactado perdido · Pospuso y abre «Ahora no» con su B2a", async () => {
    const id = await pausar();
    const r = await clasificar({ clasificacionId: id, resultado: "AHORA_NO", usuarioId: "u1", ahora: AHORA });
    expect(r).toEqual({ ok: true, cadencia: "POSPUSO" });
    expect(db.contactos[0]).toMatchObject({ estado: "CONTACTADO_PERDIDO", razonSalida: "POSPUSO" });
    expect((db.contactos[0].fechaRecontacto as Date).toISOString().slice(0, 10)).toBe("2027-02-04");
    const k = db.cadencias.find((x) => x.tipo === "POSPUSO")!;
    expect(db.toques.filter((t) => t.cadenciaId === k.id).map((t) => t.codigo)).toEqual(["B2A"]);
  });

  it("Ahora no con fecha inválida no guarda nada", async () => {
    const id = await pausar();
    expect(await clasificar({ clasificacionId: id, resultado: "AHORA_NO", fechaRecontacto: "2026-11-01", usuarioId: "u1", ahora: AHORA })).toMatchObject({ ok: false, status: 400 });
    expect(db.clasificaciones[0].resultado).toBeNull();
  });

  it("No era respuesta: reanuda la cadencia donde iba (sin perder lo pendiente) y regresa el estado anterior", async () => {
    const id = await pausar();
    const r = await clasificar({ clasificacionId: id, resultado: "NO_ERA_RESPUESTA", usuarioId: "u1", ahora: AHORA });
    expect(r).toEqual({ ok: true, cadencia: null });
    expect(db.cadencias[0]).toMatchObject({ estado: "ACTIVA", respuestaAt: null, ignorarAntesDe: AHORA });
    expect(db.contactos[0].estado).toBe("NUEVO");
    expect(db.toques.map((t) => t.codigo)).toEqual(["L1", "WA1", "L2"]);
    // Primero se reactiva la cadencia y luego el estado, para que el disparador no abra otra general.
    expect(db.orden.indexOf("cadencias:ACTIVA")).toBeLessThan(db.orden.lastIndexOf("contactos:NUEVO"));
  });

  it("No le interesa: Contactado perdido sin cadencia; Baja: No contactar y abre la confirmación", async () => {
    const id = await pausar();
    expect(await clasificar({ clasificacionId: id, resultado: "NO_LE_INTERESA", usuarioId: "u1", ahora: AHORA })).toEqual({ ok: true, cadencia: null });
    expect(db.contactos[0]).toMatchObject({ estado: "CONTACTADO_PERDIDO", razonSalida: "NO_LE_INTERESA" });
    expect(db.cadencias.filter((k) => k.estado === "ACTIVA")).toHaveLength(0);

    db.clasificaciones.push({ id: "c-b", contactId: "c1", cadenciaId: null, respuestaAt: AHORA, resultado: null });
    // El disparador del #953 pone «No contactar» con la razón NO_CONTACTAR; la confirmación sale igual.
    db.contactos[0].doNotContact = true;
    expect(await clasificar({ clasificacionId: "c-b", resultado: "BAJA", usuarioId: "u1", ahora: AHORA })).toEqual({ ok: true, cadencia: "BAJA" });
    expect(db.contactos[0]).toMatchObject({ razonSalida: "NO_CONTACTAR" });
  });

  it("no se clasifica dos veces", async () => {
    const id = await pausar();
    await clasificar({ clasificacionId: id, resultado: "NO_LE_INTERESA", usuarioId: "u1", ahora: AHORA });
    expect(await clasificar({ clasificacionId: id, resultado: "INTERESADO", usuarioId: "u1", ahora: AHORA })).toMatchObject({ ok: false, status: 409 });
  });

  it("un lead en nutrición que responde y es Interesado vuelve a Contactado y cuenta una reactivación", async () => {
    db.cadencias[0] = { ...db.cadencias[0], tipo: "NUTRICION", estado: "PAUSADA" };
    db.contactos[0].estado = "PERDIDO";
    db.clasificaciones.push({ id: "c-n", contactId: "c1", cadenciaId: "k1", respuestaAt: AHORA, estadoAntes: "PERDIDO", resultado: null });
    await clasificar({ clasificacionId: "c-n", resultado: "INTERESADO", usuarioId: "u1", ahora: AHORA });
    expect(db.contactos[0]).toMatchObject({ estado: "CONTACTADO", reactivaciones: 1 });
    expect(db.cadencias.find((k) => k.tipo === "AGENDAR")?.estado).toBe("ACTIVA");
  });
});

describe("materializarCadencias", () => {
  it("crea los toques que ya llegaron (día 2: L3 y Correo 1) al empezar su día, y no repite", async () => {
    db.toques = db.toques.map((t) => ({ ...t })); // día 1 ya creado
    await materializarCadencias({ ahora: AHORA });
    const d2 = db.toques.filter((t) => t.dia === 2);
    expect(d2.map((t) => t.codigo)).toEqual(["L3", "CORREO1"]);
    expect(d2[0].programadoAt).toEqual(new Date("2026-11-06T05:00:00Z"));
    const antes = db.toques.length;
    await materializarCadencias({ ahora: AHORA });
    expect(db.toques.length).toBe(antes);
  });

  it("un paso agregado hoy no crea toques que debieron salir antes", async () => {
    db.pasos.push({ id: "nuevo", tipo: "NUEVOS", codigo: "EXTRA", canal: "LLAMADA", offset: 0, unidad: "DIA", ancla: "CADENCIA", plantilla: null, paises: [], whatsapp: "SIEMPRE", cuando: "x", nota: null, orden: 5, activo: true, createdAt: AHORA });
    await materializarCadencias({ ahora: AHORA });
    expect(db.toques.some((t) => t.codigo === "EXTRA")).toBe(false);
  });
});

describe("terminarCadenciasVencidas", () => {
  it("el día 16 sin respuesta: Perdido · Sin respuesta tras cadencia, lo pendiente queda «no se hizo» y abre Nutrición desde el fin", async () => {
    const r = await terminarCadenciasVencidas(new Date("2026-11-20T16:00:00Z"));
    expect(r).toEqual({ terminadas: 1, cambiosDeEstado: 1, siguientes: 1 });
    expect(db.contactos[0]).toMatchObject({ estado: "PERDIDO", razonSalida: "SIN_RESPUESTA_TRAS_CADENCIA" });
    expect(db.cadencias[0]).toMatchObject({ estado: "TERMINADA", motivoFin: "SIN_RESPUESTA" });
    expect(db.toques.map((t) => t.resultado)).toEqual(["NO_HECHO", "NO_HECHO", "NO_CONTESTO"]);
    const nutri = db.cadencias.find((k) => k.tipo === "NUTRICION")!;
    // Ancla = fin de la general: inicio del día 16 (20-nov 00:00 en Cancún).
    expect(nutri).toMatchObject({ estado: "ACTIVA", anclaTipo: "FIN_CADENCIA", anclaAt: new Date("2026-11-20T05:00:00Z"), origenId: "k1" });
  });

  it("el día 15 todavía no termina", async () => {
    expect(await terminarCadenciasVencidas(new Date("2026-11-19T16:00:00Z"))).toEqual({ terminadas: 0, cambiosDeEstado: 0, siguientes: 0 });
  });

  it("«Agendar cita» sin cita en 5 días pasa a «Dejó de responder» contada desde el último mensaje del lead", async () => {
    db.cadencias[0] = { ...db.cadencias[0], tipo: "AGENDAR" };
    db.contactos[0].estado = "CONTACTADO";
    const ultimo = new Date("2026-11-07T18:00:00Z");
    db.raw = [{ at: ultimo }];
    const r = await terminarCadenciasVencidas(new Date("2026-11-10T16:00:00Z"));
    expect(r).toMatchObject({ terminadas: 1, cambiosDeEstado: 0, siguientes: 1 });
    expect(db.cadencias.find((k) => k.tipo === "GHOSTING")).toMatchObject({ anclaAt: ultimo, anclaTipo: "ULTIMO_INBOUND" });
    expect(db.contactos[0].estado).toBe("CONTACTADO");
  });

  it("si el contacto ya no está en un estado de la cadencia, no se mueve ni se abre la siguiente", async () => {
    db.contactos[0].estado = "REUNION";
    const r = await terminarCadenciasVencidas(new Date("2026-11-20T16:00:00Z"));
    expect(r).toEqual({ terminadas: 1, cambiosDeEstado: 0, siguientes: 0 });
  });

  it("una cadencia apagada en el módulo no se abre al encadenar", async () => {
    db.defs.find((d) => d.tipo === "NUTRICION")!.activa = false;
    const r = await terminarCadenciasVencidas(new Date("2026-11-20T16:00:00Z"));
    expect(r.siguientes).toBe(0);
  });
});
