import { describe, it, expect } from "vitest";
import { CADENCIAS_INICIALES, type CadenciaDef } from "./cadencias-def";
import { finDeCadencia, planDeCadencia, programadoDelPaso, puedeWhatsApp, type ContextoContacto } from "./motor";
import { toquesDelDia, modoSmsDelDia4, ULTIMO_DIA, type PerfilCadencia } from "./__pruebas__/calendario-988";
import type { Pais } from "./cadencia-nuevos";

const def = (tipo: string): CadenciaDef => CADENCIAS_INICIALES.find((d) => d.tipo === tipo)!;
const PLANTILLAS = new Set(["WA1", "WA1_SELF_GEN", "WA1_WALK_IN", "WA1_EVENTO", "WA1_BASE_DE_DATOS"]);

/** El calendario viejo (#988) completo, con el modo de SMS decidido el día 4. */
function viejo(p: PerfilCadencia) {
  const modo = modoSmsDelDia4(p.pais, p.waAbierto);
  const out = [];
  for (let d = 1; d <= ULTIMO_DIA[p.tipo]; d++) out.push(...toquesDelDia(d, d < 4 ? { ...p, modoSms: null } : { ...p, modoSms: modo }));
  return out.map((t) => `${t.dia}:${t.codigo}:${t.canal}:${t.plantilla}:${t.cuando}`);
}

function nuevo(tipo: "NUEVOS" | "BASE_DE_DATOS", ctx: ContextoContacto, ancla: Date) {
  const d = def(tipo);
  return planDeCadencia(d, d.pasos, ctx, ancla, PLANTILLAS).map((t) => `${t.dia}:${t.codigo}:${t.canal}:${t.plantilla}:${t.cuando}`);
}

describe("paridad: la siembra de la cadencia general da lo mismo que el calendario de la #988", () => {
  const paises: Pais[] = ["MX", "US", "CA", "OTRO"];
  const fuentes = ["META_ADS", "SELF_GEN", "WALK_IN", "EVENTO"];
  for (const pais of paises)
    for (const waAbierto of [false, true])
      for (const fuente of fuentes)
        for (const hora of [10, 16, 22])
          it(`NUEVOS · ${pais} · WA ${waAbierto ? "abierto" : "cerrado"} · ${fuente} · ${hora} h`, () => {
            // hora local de Cancún → UTC +5
            const ancla = new Date(Date.UTC(2026, 10, 5, hora + 5, 30));
            const ctx: ContextoContacto = { pais, waAbierto, whatsappOptOut: false, fechaRecontacto: null, fuente };
            expect(nuevo("NUEVOS", ctx, ancla)).toEqual(viejo({ tipo: "NUEVOS", pais, fuente, waAbierto, modoSms: null, horaEntrada: hora }));
          });
  for (const pais of paises)
    it(`BASE_DE_DATOS · ${pais}`, () => {
      const ancla = new Date(Date.UTC(2026, 10, 5, 15, 0));
      const ctx: ContextoContacto = { pais, waAbierto: false, whatsappOptOut: false, fechaRecontacto: null, fuente: "BASE_DE_DATOS" };
      expect(nuevo("BASE_DE_DATOS", ctx, ancla)).toEqual(viejo({ tipo: "BASE_DE_DATOS", pais, fuente: "BASE_DE_DATOS", waAbierto: false, modoSms: null, horaEntrada: 10 }));
    });
});

describe("ramas (#993)", () => {
  const ctx: ContextoContacto = { pais: "MX", waAbierto: false, whatsappOptOut: false, fechaRecontacto: null, fuente: "META_ADS" };
  const R = new Date("2026-11-09T16:00:00Z"); // 09-nov 11:00 en Cancún

  it("Agendar: A1 en la respuesta, A2 a las 2 h exactas, y llamada, correo y A5 por días", () => {
    const d = def("AGENDAR");
    const plan = planDeCadencia(d, d.pasos, ctx, R);
    expect(plan.map((t) => `${t.codigo}@${t.programadoAt.toISOString()}`)).toEqual([
      "A1@2026-11-09T16:00:00.000Z",
      "A2@2026-11-09T18:00:00.000Z",
      "A3L@2026-11-10T05:00:00.000Z",
      "A3@2026-11-10T05:00:00.000Z",
      "A4@2026-11-11T05:00:00.000Z",
      "A5@2026-11-13T05:00:00.000Z",
    ]);
    // EE. UU. sin WhatsApp: el A3 y el A5 van por SMS.
    expect(planDeCadencia(d, d.pasos, { ...ctx, pais: "US" }, R).filter((t) => t.codigo === "A3" || t.codigo === "A5").map((t) => t.canal)).toEqual(["SMS", "SMS"]);
  });

  it("Ahora no: B2a al clasificar, correos cada 90 días solo antes de la fecha, y B2c/llamada en la fecha que pidió", () => {
    const d = def("POSPUSO");
    const cerca = planDeCadencia(d, d.pasos, { ...ctx, fechaRecontacto: "2026-12-15" }, R);
    expect(cerca.map((t) => `${t.codigo}:${t.fecha}`)).toEqual(["B2A:2026-11-09", "B2C:2026-12-15", "B2CC:2026-12-15", "B2L:2026-12-20"]);
    const lejos = planDeCadencia(d, d.pasos, { ...ctx, fechaRecontacto: "2027-08-01" }, R);
    expect(lejos.map((t) => t.codigo)).toEqual(["B2A", "B2B", "B2B2", "B2C", "B2CC", "B2L"]);
    // Fin: 6 días después de la fecha.
    expect(finDeCadencia(d, R, "2026-12-15").toISOString()).toBe("2026-12-21T05:00:00.000Z");
  });

  it("Nutrición: un toque al mes; la llamada del día 77 está apagada (falta medir aperturas)", () => {
    const d = def("NUTRICION");
    const plan = planDeCadencia(d, d.pasos, ctx, R);
    expect(plan.map((t) => `${t.codigo}+${t.dia - 1}`)).toEqual(["C1A+15", "C1B+45", "C1C+75", "C1CC+75", "C1A2+105", "C1B2+135", "C1D+165"]);
    expect(finDeCadencia(d, R, null).toISOString()).toBe("2027-05-08T05:00:00.000Z");
  });

  it("R5: con opt-out de WhatsApp no salen toques de WhatsApp (en EE. UU. salen por SMS)", () => {
    const d = def("NUEVOS");
    const mx = planDeCadencia(d, d.pasos, { ...ctx, whatsappOptOut: true }, R);
    expect(mx.some((t) => t.canal === "WHATSAPP")).toBe(false);
    expect(mx.filter((t) => t.canal === "LLAMADA")).toHaveLength(7);
    expect(puedeWhatsApp({ pais: "CA", waAbierto: false, whatsappOptOut: false })).toBe(true);
    expect(puedeWhatsApp({ pais: "US", waAbierto: true, whatsappOptOut: true })).toBe(false);
  });

  it("un paso que depende de la fecha de recontacto no sale si el contacto no la tiene", () => {
    expect(programadoDelPaso({ offset: 0, unidad: "DIA", ancla: "FECHA_RECONTACTO" }, R, null)).toBeNull();
  });

  it("un paso creado después no genera lo que ya debió salir; lo que falta sí", () => {
    const d = def("NUEVOS");
    const creado = new Date("2026-11-11T00:00:00Z");
    const pasos = d.pasos.map((p) => ({ ...p, createdAt: creado }));
    const plan = planDeCadencia(d, pasos, ctx, R);
    expect(plan.every((t) => t.programadoAt.getTime() >= creado.getTime())).toBe(true);
    expect(plan.map((t) => t.codigo)).toContain("L4");
    expect(plan.map((t) => t.codigo)).not.toContain("L1");
  });

  it("un paso apagado no sale", () => {
    const d = def("NUEVOS");
    const pasos = d.pasos.map((p) => (p.codigo === "L2" ? { ...p, activo: false } : p));
    expect(planDeCadencia(d, pasos, ctx, R).some((t) => t.codigo === "L2")).toBe(false);
  });
});
