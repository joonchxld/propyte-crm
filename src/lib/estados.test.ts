import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESTADO_ORDER,
  ESTADO_LABELS,
  ESTADO_COLORS,
  RAZON_SALIDA_ORDER,
  RAZON_SALIDA_LABELS,
  RAZONES_POR_SALIDA,
  SUBESTADOS,
  ESTADO_A_LEGACY,
  TRANSICIONES,
  destinosPermitidos,
  estadoAplicaAlFlujo,
  validarCambioDeEstado,
  subestadosDe,
  subestadoPorDefecto,
  whereEstado,
  pideFormulario,
  opcionesDeEstado,
  etiquetaEstado,
  ESTADO_SIN_ESTADO,
} from "./estados";
import { CONTACT_STATUS_ORDER } from "@/lib/constants";
import { CORE_FIELDS } from "@/lib/metadata/core-fields-catalogo";
import { fieldChangeTitle } from "@/lib/timeline/format";
import { CAMPOS_EXPORTACION } from "@/lib/contacts/exportar";

// #953. La lista vive en estados.ts y tiene que decir lo mismo que el enum de Prisma y que la
// migración que crea los tipos, las funciones de validación y el espejo del estado viejo. Si uno de
// los tres se mueve solo, la base rechaza lo que la API acepta (o al revés).
const raiz = join(__dirname, "..", "..");
const migracion = readFileSync(join(raiz, "prisma", "migrations-manual", "2026-11-03-estado-subestado.sql"), "utf8");
// #993: agrega YA_COMPRO y NUMERO_EQUIVOCADO (ALTER TYPE … ADD VALUE) y redefine razon_salida_valida.
const migracion993 = readFileSync(join(raiz, "prisma", "migrations-manual", "2026-11-09-cadencias-por-rama.sql"), "utf8");

function valoresDelEnumPrisma(nombre: string): string[] {
  const schema = readFileSync(join(raiz, "prisma", "schema.prisma"), "utf8");
  const m = schema.match(new RegExp(`enum ${nombre} \\{([\\s\\S]*?)\\}`));
  if (!m) throw new Error(`enum ${nombre} no está en schema.prisma`);
  return m[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())
    .filter((l) => l && !l.startsWith("@@"));
}
function valoresDelTipo(nombre: string): string[] {
  const m = migracion.match(new RegExp(`CREATE TYPE propyte_crm\\."${nombre}" AS ENUM \\(([\\s\\S]*?)\\);`));
  if (!m) throw new Error(`la migración no crea ${nombre}`);
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}
/** «WHEN 'X' THEN s IN ('A', 'B')» de una función de la migración → { X: [A, B] }. */
function valoresAgregados(nombre: string, sql: string): string[] {
  return [...sql.matchAll(new RegExp(`ALTER TYPE propyte_crm\\."${nombre}" ADD VALUE IF NOT EXISTS '([A-Z_]+)'`, "g"))].map((x) => x[1]);
}
function listasDeLaFuncion(funcion: string, sql: string = migracion): Record<string, string[]> {
  const cuerpo = sql.split(`FUNCTION propyte_crm.${funcion}(`)[1].split("$$;")[0];
  const out: Record<string, string[]> = {};
  for (const m of cuerpo.matchAll(/WHEN '([A-Z_]+)'\s+THEN [a-z:]+ IN \(([^)]*)\)/g)) {
    out[m[1]] = [...m[2].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  }
  return out;
}

const HOY = new Date("2026-11-03T12:00:00Z");

describe("Lista única de estados (#953)", () => {
  it("son los 16 estados (11 activos, 3 salidas, 2 especiales) y coinciden con Prisma y con la migración", () => {
    expect(ESTADO_ORDER).toHaveLength(16);
    expect(valoresDelEnumPrisma("EstadoContacto")).toEqual([...ESTADO_ORDER]);
    expect(valoresDelTipo("EstadoContacto")).toEqual([...ESTADO_ORDER]);
    expect(Object.keys(ESTADO_LABELS)).toEqual([...ESTADO_ORDER]);
    expect(Object.keys(ESTADO_COLORS)).toEqual([...ESTADO_ORDER]);
  });

  it("las razones coinciden con Prisma, con la migración y con las listas por salida", () => {
    expect(valoresDelEnumPrisma("RazonSalida")).toEqual([...RAZON_SALIDA_ORDER]);
    // En la base, ADD VALUE agrega al final; el orden del enum no importa, los valores sí.
    expect([...valoresDelTipo("RazonSalida"), ...valoresAgregados("RazonSalida", migracion993)].sort()).toEqual([...RAZON_SALIDA_ORDER].sort());
    expect(Object.keys(RAZON_SALIDA_LABELS)).toEqual([...RAZON_SALIDA_ORDER]);
    // La definición vigente de razon_salida_valida es la última (#993).
    const enLaBase = listasDeLaFuncion("razon_salida_valida", migracion993);
    expect(enLaBase).toEqual(Object.fromEntries(Object.entries(RAZONES_POR_SALIDA).map(([k, v]) => [k, [...v]])));
    // Toda razón pertenece a alguna salida.
    const usadas = new Set(Object.values(RAZONES_POR_SALIDA).flat());
    expect(RAZON_SALIDA_ORDER.filter((r) => !usadas.has(r))).toEqual([]);
  });

  it("los subestados coinciden con la función de la base", () => {
    const enLaBase = listasDeLaFuncion("subestado_valido");
    const enCodigo = Object.fromEntries(Object.entries(SUBESTADOS).map(([k, v]) => [k, v!.map((o) => o.valor)]));
    expect(enLaBase).toEqual(enCodigo);
  });

  it("el espejo del estado viejo coincide con estado_a_legacy() y solo usa valores que existen", () => {
    const cuerpo = migracion.split("FUNCTION propyte_crm.estado_a_legacy(")[1].split("$$;")[0];
    const enLaBase = Object.fromEntries([...cuerpo.matchAll(/WHEN '([A-Z_]+)'\s+THEN '([A-Z_]+)'/g)].map((m) => [m[1], m[2]]));
    expect(enLaBase).toEqual(ESTADO_A_LEGACY);
    for (const v of Object.values(ESTADO_A_LEGACY)) expect(CONTACT_STATUS_ORDER as readonly string[]).toContain(v);
  });

  it("el estado se puede gatear por rol y se lee en la cronología y en la exportación", () => {
    expect(CORE_FIELDS.contact.find((c) => c.key === "estado")?.label).toBe("Estado");
    expect(CORE_FIELDS.contact.find((c) => c.key === "ticketEstimado")).toBeTruthy();
    expect(fieldChangeTitle("estado", "NUEVO", "CONTACTADO")).toBe("Estado se actualizó de Nuevo a Contactado");
    expect(fieldChangeTitle("subestado", "AGENDADA", "NO_SHOW")).toBe("Subestado se actualizó de Agendada a No-show");
    expect(fieldChangeTitle("razonSalida", null, "NO_CONTACTAR")).toBe("Razón de salida se actualizó de — a Pidió no ser contactado");
    expect(fieldChangeTitle("estado", null, "DEMO")).toBe("Estado se actualizó de — a Demo");
    const estado = CAMPOS_EXPORTACION.find((c) => c.key === "estado")!;
    expect(estado.valor({ estado: null } as never)).toBe("Por clasificar");
    expect(estado.valor({ estado: "NEGOCIO_PERDIDO" } as never)).toBe("Negocio Perdido");
  });
});

describe("Transiciones del flujograma v0.2 (#953)", () => {
  it("son las de la pestaña «Transiciones v0.2» más las correcciones de Luis (02-nov)", () => {
    // Fila = desde; los de la v0.2 tal cual, y aparte lo que agregó Luis.
    const V02: Record<string, string[]> = {
      NUEVO: ["SIN_RESPUESTA", "CONTACTADO", "REUNION", "PERDIDO"],
      SIN_RESPUESTA: ["CONTACTADO", "REUNION", "PERDIDO"],
      CONTACTADO: ["REUNION", "CONTACTADO_PERDIDO"],
      REUNION: ["DEMO", "RECORRIDO", "CONTACTADO_PERDIDO"],
      DEMO: ["RECORRIDO", "PROPUESTA", "NEGOCIO_PERDIDO"],
      RECORRIDO: ["PROPUESTA", "NEGOCIO_PERDIDO"],
      PROPUESTA: ["APARTADO", "FIRMA", "NEGOCIO_PERDIDO"],
      APARTADO: ["FIRMA", "NEGOCIO_PERDIDO"],
      FIRMA: ["ESCRITURA", "NEGOCIO_PERDIDO"],
      ESCRITURA: ["POSTVENTA"],
      POSTVENTA: [],
    };
    const LUIS: Record<string, string[]> = {
      NUEVO: ["REGISTRADO_POR_BROKER", "DERIVADO_A_RH"],
      SIN_RESPUESTA: ["DERIVADO_A_RH"],
      CONTACTADO: ["DERIVADO_A_RH"],
      PERDIDO: ["CONTACTADO", "REUNION"],
      CONTACTADO_PERDIDO: ["CONTACTADO", "REUNION"],
      NEGOCIO_PERDIDO: ["CONTACTADO", "REUNION"],
      REGISTRADO_POR_BROKER: ["REUNION"],
      DERIVADO_A_RH: [],
    };
    for (const e of ESTADO_ORDER) {
      const esperado = [...(V02[e] ?? []), ...(LUIS[e] ?? [])].sort();
      expect([...TRANSICIONES[e]].sort(), e).toEqual(esperado);
    }
  });

  it("los saltos se respetan según el flujo", () => {
    // Propuesta → Apartado solo F1, F2, F4, F5; Propuesta → Firma en F3, F6 y F7.
    expect(destinosPermitidos("PROPUESTA", "F2_CORRETAJE_COMPRADOR")).toEqual(["APARTADO", "FIRMA", "NEGOCIO_PERDIDO"]);
    expect(destinosPermitidos("PROPUESTA", "F6_BROKER")).toEqual(["FIRMA", "NEGOCIO_PERDIDO"]);
    expect(destinosPermitidos("PROPUESTA", "F7_INMOBILIARIA")).toEqual(["FIRMA", "NEGOCIO_PERDIDO"]);
    // Firma → Escritura solo donde hay Escritura.
    expect(destinosPermitidos("FIRMA", "F3_CAPTACION_MB")).toEqual(["NEGOCIO_PERDIDO"]);
    expect(destinosPermitidos("FIRMA", "F5_NATIVA")).toEqual(["ESCRITURA", "NEGOCIO_PERDIDO"]);
    // F3 no usa Recorrido.
    expect(destinosPermitidos("REUNION", "F3_CAPTACION_MB")).toEqual(["DEMO", "CONTACTADO_PERDIDO"]);
    // F8 Empleo: solo se deriva a RH.
    expect(destinosPermitidos("NUEVO", "F8_EMPLEO")).toEqual(["SIN_RESPUESTA", "PERDIDO", "DERIVADO_A_RH"]);
    expect(estadoAplicaAlFlujo("REUNION", "F8_EMPLEO")).toBe(false);
    // Sin flujo: todo lo de la tabla.
    expect(destinosPermitidos("PROPUESTA", null)).toEqual(["APARTADO", "FIRMA", "NEGOCIO_PERDIDO"]);
  });

  it("«Por clasificar» puede pasar a cualquier estado", () => {
    expect(destinosPermitidos(null, null)).toEqual([...ESTADO_ORDER]);
  });
});

describe("validarCambioDeEstado (#953)", () => {
  const v = (actual: Parameters<typeof validarCambioDeEstado>[0], cambio: Parameters<typeof validarCambioDeEstado>[1], forzar = false) =>
    validarCambioDeEstado(actual, cambio, { forzar, hoy: HOY });

  it("cambio permitido: estado + primer subestado + razón limpia", () => {
    expect(v({ estado: "REUNION" }, { estado: "RECORRIDO", ticketEstimado: 1 })).toEqual({
      ok: true,
      datos: { estado: "RECORRIDO", subestado: "AGENDADO", razonSalida: null, razonSalidaDetalle: null, fechaRecontacto: null },
    });
  });

  it("estado inexistente, salto no permitido y estado fuera del flujo", () => {
    expect(v({ estado: "NUEVO" }, { estado: "INVENTADO" })).toMatchObject({ ok: false, campo: "estado" });
    expect(v({ estado: "NUEVO" }, { estado: "DEMO", ticketEstimado: 1 })).toMatchObject({ ok: false, error: "De Nuevo no se puede pasar a Demo" });
    expect(v({ estado: "REUNION", flujo: "F3_CAPTACION_MB" }, { estado: "RECORRIDO" })).toMatchObject({
      ok: false,
      error: "Recorrido no aplica en el flujo de este contacto",
    });
  });

  it("#957: Apartado–Postventa los marca la operación (ni se entra, ni se sale, ni se cambia el subestado a mano)", () => {
    const propuesta = { estado: "PROPUESTA", ticketEstimado: 1 };
    for (const e of ["APARTADO", "FIRMA"]) {
      expect(v(propuesta, { estado: e })).toMatchObject({ ok: false, campo: "estado", error: expect.stringContaining("lo marca la operación") });
    }
    expect(v({ estado: "APARTADO", subestado: "PAGADO" }, { estado: "NEGOCIO_PERDIDO", razonSalida: "PRECIO" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancela la operación"),
    });
    expect(v({ estado: "FIRMA", subestado: "FIRMADO" }, { subestado: "DEVENGO_ACTIVO" })).toMatchObject({ ok: false, campo: "subestado" });
    // Un administrador sí corrige.
    expect(v(propuesta, { estado: "APARTADO" }, true)).toMatchObject({ ok: true, datos: { estado: "APARTADO" } });
    expect(opcionesDeEstado("PROPUESTA", null, false).normales.map((o) => o.valor)).toEqual(["PROPUESTA", "NEGOCIO_PERDIDO"]);
    expect(opcionesDeEstado("FIRMA", null, false).normales.map((o) => o.valor)).toEqual(["FIRMA"]);
    expect(opcionesDeEstado("FIRMA", null, true).correcciones.map((o) => o.valor)).toContain("NEGOCIO_PERDIDO");
  });

  it("forzar se salta la tabla pero no los datos obligatorios", () => {
    expect(v({ estado: "NUEVO" }, { estado: "FIRMA" }, true)).toMatchObject({ ok: false, campo: "ticketEstimado" });
    expect(v({ estado: "NUEVO" }, { estado: "FIRMA", ticketEstimado: 1 }, true)).toMatchObject({ ok: true, datos: { estado: "FIRMA", subestado: "AGENDADA" } });
    expect(v({ estado: "DEMO" }, { estado: null })).toMatchObject({ ok: false });
    expect(v({ estado: "DEMO" }, { estado: null }, true)).toEqual({ ok: true, datos: { estado: null, subestado: null } });
  });

  it("salidas: razón obligatoria, de su lista; detalle para Otro y Eligió otra opción; fecha para Pospuso", () => {
    const demo = { estado: "DEMO", ticketEstimado: "1" };
    expect(v(demo, { estado: "NEGOCIO_PERDIDO" })).toMatchObject({ ok: false, campo: "razonSalida", error: "Elige la razón de pérdida" });
    expect(v({ estado: "NUEVO" }, { estado: "PERDIDO" })).toMatchObject({ ok: false, error: "Elige la razón de descarte" });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "SPAM" })).toMatchObject({ ok: false, campo: "razonSalida" });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "ELIGIO_OTRA_OPCION", razonSalidaDetalle: "  " })).toMatchObject({
      ok: false,
      campo: "razonSalidaDetalle",
    });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "ELIGIO_OTRA_OPCION", razonSalidaDetalle: "Aldea Zamá" })).toMatchObject({
      ok: true,
      datos: { razonSalida: "ELIGIO_OTRA_OPCION", razonSalidaDetalle: "Aldea Zamá", subestado: null },
    });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "POSPUSO" })).toMatchObject({ ok: false, campo: "fechaRecontacto" });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "POSPUSO", fechaRecontacto: "2026-11-02" })).toMatchObject({
      ok: false,
      error: "La fecha de recontacto no puede ser pasada",
    });
    expect(v(demo, { estado: "NEGOCIO_PERDIDO", razonSalida: "POSPUSO", fechaRecontacto: "2026-11-03" })).toMatchObject({ ok: true });
  });

  it("editar la razón estando ya en la salida conserva lo que no se mandó", () => {
    const actual = { estado: "CONTACTADO_PERDIDO", razonSalida: "POSPUSO", fechaRecontacto: new Date("2026-12-01T00:00:00Z") };
    expect(v(actual, { razonSalidaDetalle: "Después de vender su casa" })).toEqual({
      ok: true,
      datos: {
        razonSalida: "POSPUSO",
        razonSalidaDetalle: "Después de vender su casa",
        fechaRecontacto: new Date("2026-12-01T00:00:00Z"),
      },
    });
    expect(v(actual, { razonSalida: "PRECIO" })).toMatchObject({ ok: false });
  });

  it("la razón fuera de una salida se rechaza", () => {
    expect(v({ estado: "CONTACTADO" }, { razonSalida: "SPAM" })).toMatchObject({ ok: false, campo: "razonSalida" });
  });

  it("ticket desde Demo: el que ya tenía o el del mismo cambio", () => {
    expect(v({ estado: "REUNION" }, { estado: "DEMO" })).toMatchObject({ ok: false, campo: "ticketEstimado" });
    expect(v({ estado: "REUNION", ticketEstimado: "0" }, { estado: "DEMO" })).toMatchObject({ ok: false });
    expect(v({ estado: "REUNION", ticketEstimado: "2500000.00" }, { estado: "DEMO" })).toMatchObject({ ok: true });
    expect(v({ estado: "REUNION" }, { estado: "DEMO", ticketEstimado: 10 })).toMatchObject({ ok: true });
  });

  it("subestado: del estado y del flujo; solo, sin tocar el estado", () => {
    expect(v({ estado: "REUNION", subestado: "AGENDADA" }, { subestado: "CONFIRMADA" })).toEqual({ ok: true, datos: { subestado: "CONFIRMADA" } });
    expect(v({ estado: "REUNION" }, { subestado: "COTIZANDO" })).toMatchObject({ ok: false, campo: "subestado" });
    expect(v({ estado: "PROPUESTA", flujo: "F2_CORRETAJE_COMPRADOR" }, { subestado: "PAQUETE_ACTIVO" })).toMatchObject({ ok: false });
    expect(v({ estado: "PROPUESTA", flujo: "F1_CORRETAJE_VENDEDOR" }, { subestado: "PAQUETE_ACTIVO" })).toMatchObject({ ok: true });
    expect(v({ estado: "SIN_RESPUESTA" }, { subestado: "AGENDADA" })).toMatchObject({ ok: false });
    expect(v({ estado: "REUNION" }, { estado: "DEMO", subestado: "COTIZANDO", ticketEstimado: 1 })).toMatchObject({
      ok: true,
      datos: { estado: "DEMO", subestado: "COTIZANDO" },
    });
  });
});

describe("Ayudas de pantalla y filtro (#953)", () => {
  it("subestados por flujo y el primero por defecto", () => {
    expect(subestadosDe("DEMO", "F2_CORRETAJE_COMPRADOR").map((o) => o.valor)).toEqual(["REALIZADA", "COTIZANDO"]);
    expect(subestadosDe("DEMO", "F7_INMOBILIARIA")).toHaveLength(4);
    expect(subestadoPorDefecto("POSTVENTA")).toBe("ENTREGA_PENDIENTE");
    expect(subestadoPorDefecto("NUEVO")).toBeNull();
  });

  it("el formulario se abre en salidas y desde Demo sin ticket", () => {
    expect(pideFormulario("CONTACTADO_PERDIDO", {})).toBe(true);
    expect(pideFormulario("DEMO", { ticketEstimado: null })).toBe(true);
    expect(pideFormulario("DEMO", { ticketEstimado: "1500000" })).toBe(false);
    expect(pideFormulario("REUNION", {})).toBe(false);
  });

  it("el chip ofrece solo los cambios permitidos; las correcciones, solo a un administrador", () => {
    const asesor = opcionesDeEstado("CONTACTADO", null, false);
    expect(asesor.normales.map((o) => o.valor)).toEqual(["CONTACTADO", "REUNION", "CONTACTADO_PERDIDO", "DERIVADO_A_RH"]);
    expect(asesor.correcciones).toEqual([]);
    const admin = opcionesDeEstado("CONTACTADO", null, true);
    expect(admin.correcciones.map((o) => o.valor)).toContain("PROPUESTA");
    expect(admin.correcciones.at(-1)).toEqual({ valor: "", etiqueta: "Por clasificar" });
    expect(opcionesDeEstado(null, null, false).normales[0]).toEqual({ valor: "", etiqueta: "Por clasificar" });
  });

  it("whereEstado: estado nuevo, «Por clasificar» y estado viejo de vistas guardadas", () => {
    expect(whereEstado("DEMO", CONTACT_STATUS_ORDER)).toEqual({ estado: "DEMO" });
    expect(whereEstado("NUEVO", CONTACT_STATUS_ORDER)).toEqual({ estado: "NUEVO" });
    expect(whereEstado(ESTADO_SIN_ESTADO, CONTACT_STATUS_ORDER)).toEqual({ estado: null });
    expect(whereEstado("PROSPECTO", CONTACT_STATUS_ORDER)).toEqual({ contactStatus: "PROSPECTO" });
    expect(whereEstado("INVENTADO", CONTACT_STATUS_ORDER)).toBeNull();
    expect(whereEstado(undefined, CONTACT_STATUS_ORDER)).toBeNull();
  });

  it("etiquetas", () => {
    expect(etiquetaEstado(null)).toBe("Por clasificar");
    expect(etiquetaEstado("REGISTRADO_POR_BROKER")).toBe("Registrado por broker");
  });
});
