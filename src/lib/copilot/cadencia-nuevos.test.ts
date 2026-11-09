import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ULTIMO_DIA, calendarioCompleto, cuandoLlamada, modoSmsDelDia4, toquesDelDia, type PerfilCadencia } from "./__pruebas__/calendario-988";
import {
  FLUJOS_SIN_CADENCIA,
  RESULTADOS_POR_CANAL,
  RESULTADO_LABELS,
  TIPOS_SIN_CADENCIA,
  compararTareas,
  diaDeCadencia,
  esIntento,
  esRespuesta,
  esResultadoDelCanal,
  estaVencida,
  fechaCancun,
  fechaDelDia,
  horaCancun,
  paisDeTelefono,
} from "./cadencia-nuevos";

const MIGRACION = readFileSync(join(process.cwd(), "prisma/migrations-manual/2026-11-05-copilot-mi-dia.sql"), "utf8");
// #993: la definición vigente de las exclusiones (copilot_contacto_vivo) y del CHECK de resultados.
const MIGRACION_993 = readFileSync(join(process.cwd(), "prisma/migrations-manual/2026-11-09-cadencias-por-rama.sql"), "utf8");

function perfil(p: Partial<PerfilCadencia> = {}): PerfilCadencia {
  return { tipo: "NUEVOS", pais: "MX", fuente: "META_ADS", waAbierto: false, modoSms: null, horaEntrada: 10, ...p };
}

/** El calendario completo con el modo de SMS decidido el día 4, como lo hace el servicio. */
function calendario(p: PerfilCadencia) {
  const modo = modoSmsDelDia4(p.pais, p.waAbierto);
  const out = [];
  for (let d = 1; d <= ULTIMO_DIA[p.tipo]; d++) out.push(...toquesDelDia(d, d < 4 ? { ...p, modoSms: null } : { ...p, modoSms: modo }));
  return out;
}

function porCanal(ts: { canal: string }[]) {
  return ts.reduce<Record<string, number>>((acc, t) => ((acc[t.canal] = (acc[t.canal] ?? 0) + 1), acc), {});
}

function dias(ts: { canal: string; dia: number }[], canal: string) {
  return ts.filter((t) => t.canal === canal).map((t) => t.dia);
}

describe("país del teléfono", () => {
  it("+52 es México; +1 se separa en Canadá y EE. UU. por la lada; el Caribe y el resto son «otro país»", () => {
    expect(paisDeTelefono("+529841234567")).toBe("MX");
    expect(paisDeTelefono("+14165550123")).toBe("CA"); // Toronto
    expect(paisDeTelefono("+16045550123")).toBe("CA"); // Vancouver
    expect(paisDeTelefono("+13055550123")).toBe("US"); // Miami
    expect(paisDeTelefono("+17875550123")).toBe("US"); // Puerto Rico
    expect(paisDeTelefono("+18095550123")).toBe("OTRO"); // República Dominicana
    expect(paisDeTelefono("+56912345678")).toBe("OTRO"); // Chile
  });
  it("sin teléfono se toma México (mismo calendario; los toques salen como «sin teléfono»)", () => {
    expect(paisDeTelefono(null)).toBe("MX");
    expect(paisDeTelefono("")).toBe("MX");
  });
});

describe("calendario maestro del PDF (cadencia de nuevos, 15 días)", () => {
  it("México: 7 llamadas (días 1×2, 2, 4, 7, 10, 13), 5 WhatsApp, 5 correos, sin SMS ni buzón", () => {
    const c = calendario(perfil());
    expect(porCanal(c)).toEqual({ LLAMADA: 7, WHATSAPP: 5, CORREO: 5 });
    expect(dias(c, "LLAMADA")).toEqual([1, 1, 2, 4, 7, 10, 13]);
    expect(dias(c, "WHATSAPP")).toEqual([1, 4, 7, 10, 13]);
    expect(dias(c, "CORREO")).toEqual([2, 5, 8, 11, 15]);
    // Un ángulo por día: el correo del ángulo N cae el día siguiente al WhatsApp (anti-eco).
    expect(c.filter((t) => t.dia === 4).map((t) => t.codigo)).toEqual(["L4", "WA2"]);
    expect(c.filter((t) => t.dia === 5).map((t) => t.codigo)).toEqual(["CORREO2"]);
  });

  it("día 1 en México: L1 en menos de 5 min, WA1 y L2 en la franja opuesta", () => {
    const d1 = toquesDelDia(1, perfil({ horaEntrada: 10 }));
    expect(d1.map((t) => t.codigo)).toEqual(["L1", "WA1", "L2"]);
    expect(d1[0].cuando).toMatch(/menos de 5 min/);
    expect(d1[2].cuando).toMatch(/^Tarde/);
    expect(d1.map((t) => t.orden)).toEqual([1, 2, 3]);
  });

  it("Canadá: igual + SMS complementario (días 1, 6, 12) y 2 buzones (tras L2 y L6)", () => {
    const c = calendario(perfil({ pais: "CA" }));
    expect(porCanal(c)).toEqual({ LLAMADA: 7, WHATSAPP: 5, CORREO: 5, SMS: 3, BUZON: 2 });
    expect(dias(c, "SMS")).toEqual([1, 6, 12]);
    expect(c.filter((t) => t.canal === "SMS").map((t) => t.plantilla)).toEqual(["SMS_C1_CON_WA", "SMS_C2", "SMS_C3"]);
    expect(dias(c, "BUZON")).toEqual([1, 10]);
    // Ronda 4: «día 1 de nuevos: L1, WA1, SMS1 y L2».
    expect(toquesDelDia(1, perfil({ pais: "CA" })).map((t) => t.codigo)).toEqual(["L1", "WA1", "SMS1", "L2", "BUZON1"]);
  });

  it("EE. UU. sin WhatsApp: sin WA, Correo 1 sube al día 1 y el SMS pasa a robusto el día 4 (días 1, 4, 8, 13)", () => {
    const c = calendario(perfil({ pais: "US" }));
    expect(porCanal(c)).toEqual({ LLAMADA: 7, CORREO: 5, SMS: 4, BUZON: 2 });
    expect(dias(c, "CORREO")).toEqual([1, 5, 8, 11, 15]);
    expect(dias(c, "SMS")).toEqual([1, 4, 8, 13]);
    expect(c.filter((t) => t.canal === "SMS").map((t) => t.plantilla)).toEqual(["SMS_C1_SIN_WA", "SMS_R2", "SMS_R3", "SMS_R4"]);
    expect(modoSmsDelDia4("US", false)).toBe("ROBUSTO");
  });

  it("EE. UU. con WhatsApp abierto por el lead: WA y SMS complementario", () => {
    const c = calendario(perfil({ pais: "US", waAbierto: true }));
    expect(porCanal(c)).toEqual({ LLAMADA: 7, WHATSAPP: 5, CORREO: 5, SMS: 3, BUZON: 2 });
    expect(c.find((t) => t.codigo === "SMS1")?.plantilla).toBe("SMS_C1_CON_WA");
    expect(modoSmsDelDia4("US", true)).toBe("COMPLEMENTARIO");
  });

  it("otro país (Luis, ronda 4): versión México sin SMS, WhatsApp primero y máximo 4 llamadas", () => {
    const c = calendario(perfil({ pais: "OTRO" }));
    expect(porCanal(c)).toEqual({ LLAMADA: 4, WHATSAPP: 5, CORREO: 5 });
    expect(toquesDelDia(1, perfil({ pais: "OTRO" })).map((t) => t.codigo)).toEqual(["WA1", "L1"]);
  });

  it("Base de datos (Luis, ronda 4): WhatsApp el día 1, correo el día 7 y WhatsApp de cierre el día 14", () => {
    const c = calendario(perfil({ tipo: "BASE_DE_DATOS", fuente: "BASE_DE_DATOS" }));
    expect(c.map((t) => `${t.dia}:${t.codigo}:${t.plantilla}`)).toEqual(["1:WA1:WA1_BASE_DE_DATOS", "7:CORREO2:CORREO2", "14:WA5:WA5"]);
    expect(ULTIMO_DIA.BASE_DE_DATOS).toBe(14);
    expect(calendario(perfil({ tipo: "BASE_DE_DATOS", pais: "US" })).map((t) => t.plantilla)).toEqual(["SMS_C1_SIN_WA", "CORREO2", "SMS_R4"]);
  });

  it("el primer WhatsApp cambia según la fuente (Self-Gen, Walk-in, Evento)", () => {
    expect(toquesDelDia(1, perfil({ fuente: "SELF_GEN" })).find((t) => t.codigo === "WA1")?.plantilla).toBe("WA1_SELF_GEN");
    expect(toquesDelDia(1, perfil({ fuente: "WALK_IN" })).find((t) => t.codigo === "WA1")?.plantilla).toBe("WA1_WALK_IN");
    expect(toquesDelDia(1, perfil({ fuente: "EVENTO" })).find((t) => t.codigo === "WA1")?.plantilla).toBe("WA1_EVENTO");
    expect(toquesDelDia(1, perfil({ fuente: "WEBSITE" })).find((t) => t.codigo === "WA1")?.plantilla).toBe("WA1");
  });

  it("fuera de rango no hay toques; los códigos no se repiten en toda la cadencia", () => {
    expect(toquesDelDia(0, perfil())).toEqual([]);
    expect(toquesDelDia(16, perfil())).toEqual([]);
    for (const p of [perfil(), perfil({ pais: "CA" }), perfil({ pais: "US" }), perfil({ pais: "US", waAbierto: true }), perfil({ pais: "OTRO" })]) {
      const codigos = calendario(p).map((t) => t.codigo);
      expect(new Set(codigos).size).toBe(codigos.length);
    }
    expect(calendarioCompleto(perfil()).length).toBe(17);
  });

  it("las franjas se rotan: L1 ya, y de ahí alternan mañana y tarde", () => {
    expect(cuandoLlamada(1, 22)).toMatch(/fuera del horario/);
    expect(cuandoLlamada(2, 10)).toMatch(/^Tarde/);
    expect(cuandoLlamada(3, 10)).toMatch(/^Mañana/);
    expect(cuandoLlamada(2, 16)).toMatch(/^Mañana/);
  });
});

describe("plantillas sembradas", () => {
  it("toda plantilla que usa el calendario existe en la migración", () => {
    const usadas = new Set<string>();
    for (const p of [
      perfil(),
      perfil({ pais: "CA" }),
      perfil({ pais: "US" }),
      perfil({ pais: "US", waAbierto: true }),
      perfil({ pais: "OTRO" }),
      perfil({ fuente: "SELF_GEN" }),
      perfil({ fuente: "WALK_IN" }),
      perfil({ fuente: "EVENTO" }),
      perfil({ tipo: "BASE_DE_DATOS" }),
      perfil({ tipo: "BASE_DE_DATOS", pais: "US" }),
    ]) {
      for (const t of calendario(p)) if (t.plantilla) usadas.add(t.plantilla);
    }
    for (const codigo of usadas) expect(MIGRACION, codigo).toContain(`('${codigo}', '`);
  });

  it("siembra 55 plantillas: 27 en español y 28 en inglés (los SMS solo en inglés, los de fuente solo en español)", () => {
    const filas = MIGRACION.match(/^\('[A-Z0-9_]+', '(ES|EN)'/gm) ?? [];
    expect(filas.length).toBe(55);
    expect(filas.filter((f) => f.endsWith("'ES'")).length).toBe(27);
    expect(filas.filter((f) => f.endsWith("'EN'")).length).toBe(28);
  });
});

describe("a quién aplica (paridad con el SQL)", () => {
  it("los tipos y flujos excluidos son los mismos en el código y en la migración vigente (#993)", () => {
    const fn = MIGRACION_993.slice(MIGRACION_993.indexOf("copilot_contacto_vivo(c propyte_crm.contacts)"));
    const tipos = fn.match(/"contactType"::text, ''\) NOT IN \(([^)]*)\)/)?.[1] ?? "";
    const flujos = fn.match(/flujo::text, ''\) NOT IN \(([^)]*)\)/)?.[1] ?? "";
    expect(tipos.match(/'[A-Z_]+'/g)?.map((s) => s.slice(1, -1))).toEqual([...TIPOS_SIN_CADENCIA]);
    expect(flujos.match(/'[A-Z0-9_]+'/g)?.map((s) => s.slice(1, -1))).toEqual([...FLUJOS_SIN_CADENCIA]);
  });
  it("F2, F4 y F5 son de compra y sí la llevan", () => {
    for (const f of ["F2_CORRETAJE_COMPRADOR", "F4_MB", "F5_NATIVA"]) expect(FLUJOS_SIN_CADENCIA as readonly string[]).not.toContain(f);
  });
});

describe("días en Cancún", () => {
  it("el día cambia a las 00:00 de Cancún (05:00 UTC)", () => {
    expect(fechaCancun(new Date("2026-11-06T04:59:00Z"))).toBe("2026-11-05");
    expect(fechaCancun(new Date("2026-11-06T05:00:00Z"))).toBe("2026-11-06");
    expect(horaCancun(new Date("2026-11-05T15:30:00Z"))).toBe(10);
  });
  it("día de la cadencia y fecha de cada día", () => {
    expect(diaDeCadencia("2026-11-05", new Date("2026-11-05T23:00:00Z"))).toBe(1);
    expect(diaDeCadencia("2026-11-05", new Date("2026-11-06T06:00:00Z"))).toBe(2);
    expect(diaDeCadencia("2026-11-05", new Date("2026-11-20T06:00:00Z"))).toBe(16);
    expect(fechaDelDia("2026-11-28", 5)).toBe("2026-12-02");
  });
});

describe("resultados", () => {
  it("cada canal tiene sus resultados y NO_HECHO lo pone solo el sistema", () => {
    expect(esResultadoDelCanal("LLAMADA", "CONTESTO")).toBe(true);
    expect(esResultadoDelCanal("LLAMADA", "ENVIADO")).toBe(false);
    expect(esResultadoDelCanal("BUZON", "RESPONDIO")).toBe(false);
    for (const lista of Object.values(RESULTADOS_POR_CANAL)) expect(lista).not.toContain("NO_HECHO");
  });
  it("respuesta (detiene la cadencia) vs intento (Nuevo → Sin respuesta); el buzón no es respuesta", () => {
    expect(esRespuesta("CONTESTO")).toBe(true);
    expect(esRespuesta("RESPONDIO")).toBe(true);
    expect(esRespuesta("DEJADO")).toBe(false);
    expect(esIntento("NO_CONTESTO")).toBe(true);
    expect(esIntento("ENVIADO")).toBe(true);
    expect(esIntento("NO_SE_PUDO")).toBe(false);
  });
  it("la migración vigente (#993) acepta exactamente los resultados del código", () => {
    const check = MIGRACION_993.match(/copilot_toques_resultado_check CHECK \("resultado" IS NULL OR "resultado" IN \(([^)]*)\)/)?.[1] ?? "";
    expect(check.match(/'[A-Z_]+'/g)?.map((s) => s.slice(1, -1)).sort()).toEqual(Object.keys(RESULTADO_LABELS).sort());
  });
});

describe("orden de «Mi día» y vencidas", () => {
  const base = { dia: 3, fecha: "2026-11-05", l1Pendiente: false, inicio: "2026-11-03T15:00:00Z" };
  it("caliente → nuevo en su tiempo (L1 pendiente) → Tibio A → Tibio B → Frío", () => {
    const tareas = [
      { ...base, id: "frio", ordenTemperatura: 30 },
      { ...base, id: "tibioB", ordenTemperatura: 20 },
      { ...base, id: "nuevo", ordenTemperatura: 20, l1Pendiente: true, dia: 1 },
      { ...base, id: "caliente", ordenTemperatura: 0 },
      { ...base, id: "tibioA", ordenTemperatura: 11 },
    ];
    expect([...tareas].sort(compararTareas).map((t) => t.id)).toEqual(["caliente", "nuevo", "tibioA", "tibioB", "frio"]);
  });
  it("misma temperatura: primero la más atrasada", () => {
    const a = { ...base, ordenTemperatura: 20, fecha: "2026-11-04" };
    const b = { ...base, ordenTemperatura: 20, fecha: "2026-11-05" };
    expect(compararTareas(a, b)).toBeLessThan(0);
  });
  it("vence a las 24 h de aparecer", () => {
    const ahora = new Date("2026-11-06T15:00:00Z");
    expect(estaVencida("2026-11-05T15:00:01Z", ahora)).toBe(false);
    expect(estaVencida("2026-11-05T15:00:00Z", ahora)).toBe(true);
  });
});
