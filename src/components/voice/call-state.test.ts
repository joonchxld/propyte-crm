import { describe, it, expect } from "vitest";
import { ESTADO_INICIAL, datosDeLlamante, etiquetaLlamante, voiceReducer, type DatosEntrante } from "./call-state";

const datos: DatosEntrante = { contactId: "c1", nombre: "Ana", telefono: "+5299", esNuevo: false };

describe("voiceReducer", () => {
  it("incoming → incoming con datos (no contesta solo)", () => {
    const s = voiceReducer(ESTADO_INICIAL, { type: "incoming", datos });
    expect(s).toEqual({ state: "incoming", activeContactId: "c1", incoming: datos });
  });
  it("accept → in-call y limpia el aviso", () => {
    const s = voiceReducer(voiceReducer(ESTADO_INICIAL, { type: "incoming", datos }), { type: "accept" });
    expect(s.state).toBe("in-call");
    expect(s.incoming).toBeNull();
    expect(s.activeContactId).toBe("c1");
  });
  it.each(["reject", "cancel"] as const)("%s → idle", (type) => {
    const s = voiceReducer(voiceReducer(ESTADO_INICIAL, { type: "incoming", datos }), { type });
    expect(s).toEqual(ESTADO_INICIAL);
  });
  it("disconnect en llamada → idle", () => {
    const s = voiceReducer({ state: "in-call", activeContactId: "c1", incoming: null }, { type: "disconnect" });
    expect(s).toEqual(ESTADO_INICIAL);
  });
  it("otra entrante con la línea ocupada se ignora; cancel fuera de incoming no cuelga una llamada en curso", () => {
    const enCurso = { state: "in-call" as const, activeContactId: "c9", incoming: null };
    expect(voiceReducer(enCurso, { type: "incoming", datos })).toBe(enCurso);
    expect(voiceReducer(enCurso, { type: "cancel" })).toBe(enCurso);
  });
  it("saliente: dial → ringing → in-call", () => {
    let s = voiceReducer(ESTADO_INICIAL, { type: "dial", contactId: "c2" });
    expect(s.state).toBe("connecting");
    s = voiceReducer(s, { type: "outbound-ringing" });
    expect(s.state).toBe("ringing");
    s = voiceReducer(s, { type: "outbound-accept" });
    expect(s.state).toBe("in-call");
  });
});

describe("datosDeLlamante", () => {
  it("lee customParameters", () => {
    const d = datosDeLlamante(new Map([["contactId", "c1"], ["nombre", " Ana "], ["esNuevo", "1"]]), { From: "+52" });
    expect(d).toEqual({ contactId: "c1", nombre: "Ana", telefono: "+52", esNuevo: true });
  });
  it("respaldo en From cuando no hay parámetros", () => {
    const d = datosDeLlamante(new Map(), { From: "+5211" });
    expect(d).toEqual({ contactId: null, nombre: "", telefono: "+5211", esNuevo: false });
    expect(etiquetaLlamante(d)).toBe("+5211");
  });
});
