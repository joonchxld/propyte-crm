// #996 — «Agendar cita» cuenta como cita cuando el contacto pasa a Reunión o más adelante, aunque
// el estado cambie antes de registrar la reunión. Estas pruebas cuidan que la migración solo cambie
// eso respecto a la función de la #993.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CADENCIAS_INICIALES } from "./cadencias-def";
import { ESTADO_ORDER } from "@/lib/estados";

const raiz = process.cwd();
const M993 = readFileSync(join(raiz, "prisma/migrations-manual/2026-11-09-cadencias-por-rama.sql"), "utf8");
const M996 = readFileSync(join(raiz, "prisma/migrations-manual/2026-11-10-agendar-cita-por-estado.sql"), "utf8");

function funcion(sql: string): string {
  const i = sql.indexOf("CREATE OR REPLACE FUNCTION propyte_crm.copilot_cadencia_de_contacto()");
  expect(i).toBeGreaterThanOrEqual(0);
  return sql.slice(i, sql.indexOf("$$;", i) + 3);
}

const ETAPAS_DE_CITA = ESTADO_ORDER.slice(ESTADO_ORDER.indexOf("REUNION"), ESTADO_ORDER.indexOf("POSTVENTA") + 1);
const LISTA_SQL = `ARRAY[${ETAPAS_DE_CITA.map((e) => `'${e}'`).join(", ")}]`;

describe("migración #996", () => {
  it("las etapas de cita son de Reunión a Postventa, sin salidas", () => {
    expect(ETAPAS_DE_CITA).toEqual(["REUNION", "DEMO", "RECORRIDO", "PROPUESTA", "APARTADO", "FIRMA", "ESCRITURA", "POSTVENTA"]);
  });

  it("la función nueva es la de la #993 más una sola rama CITA_AGENDADA", () => {
    const vieja = funcion(M993);
    const nueva = funcion(M996);
    const rama = nueva.slice(nueva.indexOf("THEN 'YA_NO_APLICA'") + "THEN 'YA_NO_APLICA'".length, nueva.indexOf("ELSE 'SALIO_DEL_ESTADO'"));
    expect(rama).toContain(`WHEN coalesce(def."terminaConCita", false)`);
    expect(rama).toContain(`NEW.estado::text = ANY (${LISTA_SQL})`);
    expect(rama).toContain("THEN 'CITA_AGENDADA'");
    expect(nueva.replace(rama, " ")).toBe(vieja);
  });

  it("la corrección de filas viejas usa las mismas etapas y solo toca SALIO_DEL_ESTADO de cadencias con cita", () => {
    const update = M996.slice(M996.indexOf("UPDATE propyte_crm.copilot_cadencias k"));
    expect(update).toContain(`c.estado::text = ANY (${LISTA_SQL})`);
    expect(update).toContain(`d."terminaConCita"`);
    expect(update).toContain(`k."motivoFin" = 'SALIO_DEL_ESTADO'`);
    expect(update).toContain(`k."estado" = 'TERMINADA'`);
  });

  it("es una transacción y no vuelve a crear el disparador", () => {
    expect(M996).toMatch(/^BEGIN;$/m);
    expect(M996).toMatch(/^COMMIT;$/m);
    expect(M996).not.toMatch(/CREATE TRIGGER/);
  });

  it("aplica a Agendar cita y a Ghosting, las cadencias que terminan con cita", () => {
    expect(CADENCIAS_INICIALES.filter((d) => d.terminaConCita).map((d) => d.tipo)).toEqual(["AGENDAR", "GHOSTING"]);
  });
});
