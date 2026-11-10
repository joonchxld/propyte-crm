import { describe, it, expect } from "vitest";
import { armarTareas, ordenarMiDia, type FilaContacto, type FilaToque } from "./mi-dia";
import type { Plantilla } from "./plantillas";

const ahora = new Date("2026-11-06T16:00:00Z"); // 06-nov 11:00 en Cancún

const plantillas: Plantilla[] = [
  { id: "1", codigo: "WA1", idioma: "ES", variante: "", canal: "WHATSAPP", nombre: "WA1", asunto: null, cuerpo: "Hola [NOMBRE], soy [ASESOR]. [ZONA]" },
  { id: "2", codigo: "WA1", idioma: "EN", variante: "", canal: "WHATSAPP", nombre: "WA1", asunto: null, cuerpo: "Hi [NOMBRE]" },
  { id: "3", codigo: "WA3", idioma: "ES", variante: "METODO", canal: "WHATSAPP", nombre: "WA3", asunto: null, cuerpo: "Método [ZONA]" },
  { id: "4", codigo: "WA3", idioma: "ES", variante: "TRACCION", canal: "WHATSAPP", nombre: "WA3", asunto: null, cuerpo: "Tracción [N] de [M]" },
  { id: "5", codigo: "LINEA_VALOR", idioma: "ES", variante: "A", canal: "DATO", nombre: "A", asunto: null, cuerpo: "Línea A" },
  { id: "6", codigo: "CIFRA", idioma: "ES", variante: "PDC", canal: "DATO", nombre: "c", asunto: null, cuerpo: "+13.5%" },
];

const contacto = (x: Partial<FilaContacto>): FilaContacto => ({
  id: "c1",
  firstName: "Ana",
  lastName: "López",
  phone: "+529841234567",
  email: null,
  preferredLanguage: "ES",
  preferredZone: null,
  targetPlaza: "PDC",
  estado: "NUEVO",
  doNotContact: false,
  assignedToId: "u1",
  ...x,
});

const toque = (x: Partial<FilaToque>): FilaToque => ({
  id: "t",
  cadenciaId: "k1",
  contactId: "c1",
  dia: 1,
  fecha: "2026-11-06",
  codigo: "L1",
  canal: "LLAMADA",
  orden: 1,
  plantilla: null,
  cuando: "ya",
  variante: null,
  resultado: null,
  resultadoAt: null,
  createdAt: "2026-11-06T15:58:00Z",
  ...x,
});

function armar(toques: FilaToque[], contactos: FilaContacto[] = [contacto({})], cadencias = ["k1"]) {
  return armarTareas({
    cadencias: cadencias.map((id, i) => ({ id, contactId: contactos[i]?.id ?? "c1", tipo: "NUEVOS", estado: "ACTIVA", motivoFin: null, inicio: "2026-11-06T15:57:00Z", diaInicio: "2026-11-06", nombre: "Cadencia de nuevos", finDias: 15 })),
    toques,
    contactos,
    asesores: [{ id: "u1", name: "Conrad Alvarado", role: "GERENTE", phone: null }],
    temperaturas: [],
    plantillas,
    ahora,
  });
}

describe("armarTareas", () => {
  it("una tarea por contacto y por día, con los toques en orden y el texto llenado", () => {
    const tareas = armar([
      toque({ id: "a", codigo: "WA1", canal: "WHATSAPP", orden: 2, plantilla: "WA1" }),
      toque({ id: "b", codigo: "L1", orden: 1 }),
      toque({ id: "c", codigo: "L3", dia: 2, fecha: "2026-11-07", orden: 1 }),
    ]);
    expect(tareas.map((t) => `${t.dia}:${t.toques.map((q) => q.codigo).join(",")}`).sort()).toEqual(["1:L1,WA1", "2:L3"]);
    const d1 = tareas.find((t) => t.dia === 1)!;
    expect(d1.toques[1].texto?.texto).toBe("Hola Ana, soy Conrad Alvarado. Playa del Carmen");
    expect(d1.toques[0].texto).toBeNull(); // la llamada lleva guion, no plantilla
    expect(d1.contacto.pais).toBe("MX");
    expect(d1.ultimoDia).toBe(15);
    expect(d1.nombreCadencia).toBe("Cadencia de nuevos");
  });

  it("el idioma del lead elige la plantilla", () => {
    const [t] = armar([toque({ codigo: "WA1", canal: "WHATSAPP", plantilla: "WA1" })], [contacto({ preferredLanguage: "EN" })]);
    expect(t.toques[0].texto?.texto).toBe("Hi Ana");
  });

  it("las variantes salen todas, con la de por defecto elegida", () => {
    const [t] = armar([toque({ codigo: "WA3", canal: "WHATSAPP", plantilla: "WA3", dia: 7 })]);
    expect(t.toques[0].variante).toBe("METODO");
    expect(t.toques[0].variantes?.map((v) => v.valor)).toEqual(["METODO", "TRACCION"]);
    expect(t.toques[0].texto?.texto).toBe("Método Playa del Carmen");
    expect(t.toques[0].variantes?.[1].texto?.faltan).toEqual(["[N]", "[M]"]);
  });

  it("marca vencido el toque con 24 h sin resultado, y bloqueado sin teléfono o con No contactar", () => {
    const [t] = armar([toque({ createdAt: "2026-11-05T15:00:00Z" })], [contacto({ phone: "" })]);
    expect(t.toques[0].vencido).toBe(true);
    expect(t.vencida).toBe(true);
    expect(t.toques[0].bloqueo).toBe("Sin teléfono");
    const [n] = armar([toque({ codigo: "CORREO1", canal: "CORREO", plantilla: null })], [contacto({ doNotContact: true })]);
    expect(n.toques[0].bloqueo).toBe("Marcado como No contactar");
  });
});

describe("ordenarMiDia", () => {
  it("aplica el tope y cuenta lo que queda fuera; separa las terminadas de hoy", () => {
    const contactos = Array.from({ length: 5 }, (_, i) => contacto({ id: `c${i}` }));
    const cadencias = contactos.map((_, i) => `k${i}`);
    const toques = contactos.map((c, i) => toque({ id: `t${i}`, cadenciaId: `k${i}`, contactId: c.id, resultado: i === 4 ? "NO_CONTESTO" : null }));
    const tareas = armar(toques, contactos, cadencias);
    const orden: Record<string, number> = { c0: 30, c1: 0, c2: 20, c3: 11, c4: 0 };
    const r = ordenarMiDia(tareas, "2026-11-06", 3, (id) => orden[id] ?? null, () => "2026-11-06T15:57:00Z");
    expect(r.tareas.map((t) => t.contacto.id)).toEqual(["c1", "c3", "c2"]);
    expect(r.fueraDelTope).toBe(1);
    expect(r.hechasHoy.map((t) => t.contacto.id)).toEqual(["c4"]);
  });
});

describe("#993: ramas", () => {
  it("vencido se cuenta desde programadoAt; el aviso del paso llega al asesor", () => {
    const [t] = armar([toque({ codigo: "A2", canal: "MISMO_CANAL", plantilla: "WA1", createdAt: "2026-11-01T00:00:00Z", programadoAt: "2026-11-06T15:00:00Z", nota: "Solo si contestó sin horario" })]);
    expect(t.toques[0].vencido).toBe(false);
    expect(t.toques[0].nota).toBe("Solo si contestó sin horario");
    expect(t.toques[0].bloqueo).toBeNull();
  });
  it("con opt-out de WhatsApp el toque de WhatsApp sale bloqueado", () => {
    const [t] = armar([toque({ codigo: "WA2", canal: "WHATSAPP", plantilla: "WA1" })], [contacto({ whatsappOptOut: true })]);
    expect(t.toques[0].bloqueo).toBe("Pidió no recibir WhatsApp");
  });
  it("[MES] del B2a es el mes de la fecha de recontacto", () => {
    const pl: Plantilla[] = [...plantillas, { id: "9", codigo: "R_B2a", idioma: "ES", variante: "", canal: "WHATSAPP", nombre: "B2a", asunto: null, cuerpo: "Te escribo en [MES]" }];
    const tareas = armarTareas({
      cadencias: [{ id: "k1", contactId: "c1", tipo: "POSPUSO", estado: "ACTIVA", motivoFin: null, inicio: "2026-11-06T15:57:00Z", diaInicio: "2026-11-06" }],
      toques: [toque({ codigo: "B2A", canal: "MISMO_CANAL", plantilla: "R_B2a" })],
      contactos: [contacto({ fechaRecontacto: "2027-03-15" })],
      asesores: [],
      temperaturas: [],
      plantillas: pl,
      ahora,
    });
    expect(tareas[0].toques[0].texto?.texto).toBe("Te escribo en marzo");
  });
});
