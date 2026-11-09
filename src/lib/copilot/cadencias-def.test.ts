import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CADENCIAS_INICIALES, momentoDelPaso, sqlDeSiembra, validarPaso, type PasoDef } from "./cadencias-def";
import { CLASIFICACIONES } from "./clasificacion";
import { ESTADO_ORDER, RAZONES_POR_SALIDA, SUBESTADOS } from "@/lib/estados";

const raiz = process.cwd();
const M988 = readFileSync(join(raiz, "prisma/migrations-manual/2026-11-05-copilot-mi-dia.sql"), "utf8");
const M993 = readFileSync(join(raiz, "prisma/migrations-manual/2026-11-09-cadencias-por-rama.sql"), "utf8");

describe("siembra del catálogo (#993)", () => {
  it("la migración trae exactamente sqlDeSiembra() entre las marcas", () => {
    const bloque = M993.split("-- <siembra>\n")[1].split("\n-- </siembra>")[0];
    expect(bloque).toBe(sqlDeSiembra());
  });

  it("son las 9 cadencias de esta entrega, con tipos únicos", () => {
    expect(CADENCIAS_INICIALES.map((d) => d.tipo)).toEqual(["NUEVOS", "BASE_DE_DATOS", "AGENDAR", "GHOSTING", "REPERFILAR", "POSPUSO", "NUTRICION", "BAJA", "YA_COMPRO"]);
  });

  it("toda plantilla que usa un paso existe en las migraciones (#988 o #993)", () => {
    for (const d of CADENCIAS_INICIALES)
      for (const p of d.pasos) if (p.plantilla) expect(M988 + M993, `${d.tipo}/${p.codigo}`).toContain(`('${p.plantilla}', '`);
  });

  it("todos los pasos sembrados pasan la validación del editor", () => {
    for (const d of CADENCIAS_INICIALES) for (const p of d.pasos) expect(validarPaso(p), `${d.tipo}/${p.codigo}`).toEqual([]);
  });

  it("estados, salidas y siguientes apuntan a cosas que existen", () => {
    const tipos = new Set(CADENCIAS_INICIALES.map((d) => d.tipo));
    for (const d of CADENCIAS_INICIALES) {
      for (const e of d.estados) expect(ESTADO_ORDER as readonly string[]).toContain(e);
      if (d.fin.estado) expect(ESTADO_ORDER as readonly string[]).toContain(d.fin.estado);
      if (d.fin.razon) expect(RAZONES_POR_SALIDA[d.fin.estado as keyof typeof RAZONES_POR_SALIDA]).toContain(d.fin.razon);
      if (d.fin.siguiente) {
        expect(tipos.has(d.fin.siguiente), d.tipo).toBe(true);
        // La siguiente acepta el estado en el que queda el contacto.
        const sig = CADENCIAS_INICIALES.find((x) => x.tipo === d.fin.siguiente)!;
        const queda = d.fin.estado ? [d.fin.estado] : d.estados;
        expect(queda.some((e) => sig.estados.includes(e)), `${d.tipo} → ${sig.tipo}`).toBe(true);
      }
    }
  });

  it("cada botón de la clasificación deja al contacto en un estado que su cadencia acepta", () => {
    for (const [r, e] of Object.entries(CLASIFICACIONES)) {
      if (e.razon) expect(RAZONES_POR_SALIDA[e.estado as keyof typeof RAZONES_POR_SALIDA], r).toContain(e.razon);
      if (e.subestado) expect(SUBESTADOS[e.estado as keyof typeof SUBESTADOS]?.map((o) => o.valor), r).toContain(e.subestado);
      if (!e.cadencia) continue;
      const d = CADENCIAS_INICIALES.find((x) => x.tipo === e.cadencia);
      expect(d, r).toBeDefined();
      expect(d!.estados, r).toContain(e.estado);
    }
  });

  it("el CHECK de canales de la migración es la lista del código", () => {
    const check = M993.match(/copilot_cadencia_pasos[\s\S]*?"canal" IN \(([^)]*)\)/)?.[1] ?? "";
    expect(check.match(/'[A-Z_]+'/g)?.map((s) => s.slice(1, -1))).toEqual(["LLAMADA", "WHATSAPP", "SMS", "CORREO", "BUZON", "MISMO_CANAL"]);
  });
});

describe("validarPaso y momentoDelPaso", () => {
  const ok: PasoDef = { codigo: "X1", canal: "WHATSAPP", offset: 2, unidad: "DIA", ancla: "CADENCIA", plantilla: "WA1", paises: [], whatsapp: "CON_WA", cuando: "ya", nota: null, orden: 10, activo: true };
  it("acepta un paso bien formado y explica los errores en palabras", () => {
    expect(validarPaso(ok)).toEqual([]);
    expect(validarPaso({ ...ok, codigo: "a b" })[0]).toMatch(/mayúsculas/);
    expect(validarPaso({ ...ok, plantilla: null })).toEqual(["Los mensajes necesitan una plantilla."]);
    expect(validarPaso({ ...ok, canal: "LLAMADA", plantilla: null })).toEqual([]);
    expect(validarPaso({ ...ok, offset: -1 })[0]).toMatch(/0 a 730/);
    expect(validarPaso({ ...ok, unidad: "MIN", offset: -1440 })).toEqual([]);
    expect(validarPaso({ ...ok, cuando: " " })).toEqual(["Falta «cuándo»."]);
  });
  it("muestra el momento en palabras cortas", () => {
    expect(momentoDelPaso({ offset: 0, unidad: "MIN", ancla: "CADENCIA" })).toBe("+0 min");
    expect(momentoDelPaso({ offset: 120, unidad: "MIN", ancla: "CADENCIA" })).toBe("+2 h");
    expect(momentoDelPaso({ offset: -1440, unidad: "MIN", ancla: "CADENCIA" })).toBe("−1 d");
    expect(momentoDelPaso({ offset: 4, unidad: "DIA", ancla: "CADENCIA" })).toBe("+4 d");
    expect(momentoDelPaso({ offset: 5, unidad: "DIA", ancla: "FECHA_RECONTACTO" })).toBe("Fecha de recontacto +5 d");
  });
});
