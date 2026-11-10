import { describe, it, expect } from "vitest";
import { CLASIFICACIONES, ORDEN_CLASIFICACIONES, esReactivacion, esResultadoClasificacion, fechaRecontactoValida } from "./clasificacion";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const M993 = readFileSync(join(process.cwd(), "prisma/migrations-manual/2026-11-09-cadencias-por-rama.sql"), "utf8");

describe("clasificación de respuestas (R2)", () => {
  it("son los botones del PDF y la migración acepta todos", () => {
    expect(ORDEN_CLASIFICACIONES.map((r) => CLASIFICACIONES[r].etiqueta)).toEqual([
      "Interesado",
      "Ahora no",
      "No es lo que busca",
      "No le interesa",
      "Baja",
      "Ya compró",
      "Datos incorrectos",
      "Equivocado / no es el lead",
      "No era respuesta",
    ]);
    const check = M993.match(/"resultado" IN \('INTERESADO'[^)]*\)/)?.[0] ?? "";
    for (const r of ORDEN_CLASIFICACIONES) expect(check).toContain(`'${r}'`);
  });
  it("cada rama abre su cadencia (sección 3 del PDF)", () => {
    expect(CLASIFICACIONES.INTERESADO.cadencia).toBe("AGENDAR");
    expect(CLASIFICACIONES.AHORA_NO.cadencia).toBe("POSPUSO");
    expect(CLASIFICACIONES.AHORA_NO.pideFecha).toBe(true);
    expect(CLASIFICACIONES.NO_ES_LO_QUE_BUSCA.cadencia).toBe("REPERFILAR");
    expect(CLASIFICACIONES.BAJA).toMatchObject({ razon: "NO_CONTACTAR", cadencia: "BAJA" });
    expect(CLASIFICACIONES.YA_COMPRO).toMatchObject({ razon: "YA_COMPRO", cadencia: "YA_COMPRO" });
    expect(CLASIFICACIONES.NO_ERA_RESPUESTA.estado).toBeNull();
  });
  it("valida el resultado y la fecha de recontacto (de mañana a 2 años)", () => {
    expect(esResultadoClasificacion("INTERESADO")).toBe(true);
    expect(esResultadoClasificacion("OTRA")).toBe(false);
    expect(fechaRecontactoValida("2026-11-10", "2026-11-09")).toBe("2026-11-10");
    expect(fechaRecontactoValida("2026-11-09", "2026-11-09")).toBeNull();
    expect(fechaRecontactoValida("2029-01-01", "2026-11-09")).toBeNull();
    expect(fechaRecontactoValida("10/11/2026", "2026-11-09")).toBeNull();
  });
  it("salir de una salida a un estado activo es una reactivación", () => {
    expect(esReactivacion("PERDIDO", "CONTACTADO")).toBe(true);
    expect(esReactivacion("PERDIDO", "CONTACTADO_PERDIDO")).toBe(false);
    expect(esReactivacion("NUEVO", "CONTACTADO")).toBe(false);
  });
});
