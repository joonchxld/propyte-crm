import { describe, it, expect, vi } from "vitest";

// #989 (2026-11-09): calidad de las respuestas del bot por marca (Propyte, Yaxnáh, Avica).
// Casos reales que motivan cada prueba:
// - Propyte por Instagram: «el otro mejor bull_caribbean» → «es un bot»; el bot repitió palabra por
//   palabra la pregunta de zona con la lista de cinco ciudades y no ofreció pasarlo con una persona.
// - Yaxnáh por Messenger: «¡Hola, Messenger!» (nombre de relleno del alta), saludos a media
//   conversación, sin pedir el WhatsApp, y leads con datos completos que se quedaban con el bot.
// La parte de botRespond (paso al asesor al completar el guion de la marca) vive en
// bot-respond.brand.test.ts, junto al resto de casos con marca.

// claude.ts importa cosas de servidor solo por tipos/constantes; aquí basta el builder puro.
vi.mock("./hub-catalog", () => ({ catalogBrief: () => "CATALOGO" }));

import { buildSystemPrompt, BRAND_DEFAULT_OBJECTIVE } from "./claude";
import { DEFAULT_BOT_CONFIG } from "./config";
import { isFieldFilled, nextTask } from "./playbook/engine";
import { buildOpener, brandCompletionObjective } from "./bot-respond";

const YAX = { name: "Yaxnáh Caucel", persona: "Eres el asistente de Yaxnáh.", knowledge: "K", slug: "yaxnah" };

describe("#989 — reglas de conversación (con y sin marca)", () => {
  const sinMarca = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG, objective: "X" });
  const conMarca = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG, objective: "X", brand: YAX });

  for (const [nombre, out] of [["sin marca (Propyte)", sinMarca], ["con marca (Yaxnáh)", conMarca]] as const) {
    it(`${nombre}: no repetir la misma pregunta y cambiar de táctica`, () => {
      expect(out).toContain("Nunca repitas una pregunta con las mismas palabras");
      expect(out).toContain("Si ya lo preguntaste dos veces sin respuesta");
    });
    it(`${nombre}: «¿eres un bot?» → honesto y ofrece a un asesor`, () => {
      expect(out).toContain("Si te pregunta si eres un bot o una persona, sé honesto");
      expect(out).toContain("ofrécele en ese momento que uno lo contacte");
    });
    it(`${nombre}: mención de otra inmobiliaria o @usuario desconocido`, () => {
      expect(out).toContain("Si menciona otra inmobiliaria");
      expect(out).toMatch(/no lo critiques ni lo compares/);
    });
    it(`${nombre}: no vuelve a saludar y cierra con una pregunta o siguiente paso`, () => {
      expect(out).toContain("Saluda solo en tu primer mensaje");
      expect(out).toContain("Termina cada mensaje con UNA sola pregunta o un siguiente paso concreto");
    });
  }

  it("la regla de IA vieja (sin siguiente paso) ya no está", () => {
    expect(sinMarca).not.toContain("Nunca digas que eres una IA salvo pregunta directa; entonces sé honesto.");
  });
});

describe("#989 — con marca: conseguir el WhatsApp", () => {
  it("la marca pide el WhatsApp si no lo tenemos", () => {
    const out = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG, brand: YAX });
    expect(out).toContain("Tu trabajo es que un asesor de Yaxnáh Caucel pueda contactar al cliente");
    expect(out).toContain("pídeselo con naturalidad");
  });
  it("sin marca no se agrega la regla de la marca", () => {
    const out = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG });
    expect(out).not.toContain("Tu trabajo es que un asesor de");
  });
  it("objetivo por defecto con marca: sin «zona» ni «Saluda», con nombre/WhatsApp/pago", () => {
    const out = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG, brand: YAX });
    expect(out).toContain(`Objetivo ahora: ${BRAND_DEFAULT_OBJECTIVE}`);
    expect(BRAND_DEFAULT_OBJECTIVE).not.toMatch(/zona|Saluda/);
    expect(BRAND_DEFAULT_OBJECTIVE).toMatch(/WhatsApp/);
  });
  it("sin marca el objetivo por defecto es el de siempre", () => {
    const out = buildSystemPrompt({ config: DEFAULT_BOT_CONFIG });
    expect(out).toContain("Objetivo ahora: Saluda y avanza en calificar (zona, presupuesto, plazo)");
  });
});

describe("#989 — la línea del cliente", () => {
  const prompt = (contact: Parameters<typeof buildSystemPrompt>[0]["contact"], brand?: typeof YAX) =>
    buildSystemPrompt({ config: DEFAULT_BOT_CONFIG, contact, ...(brand ? { brand } : {}) });

  it.each(["Messenger", "Instagram", "WhatsApp", "@fer.bonah"])("«%s» no se usa como nombre", (firstName) => {
    const out = prompt({ firstName, preferredLanguage: "ES" }, YAX);
    expect(out).not.toContain(`Cliente: ${firstName}`);
    expect(out).toContain("todavía no sabes su nombre");
  });
  it("un nombre real sigue igual que siempre (Yaxnáh: «Contesta en español.»)", () => {
    const out = prompt({ firstName: "Santiago", preferredLanguage: "ES" }, YAX);
    expect(out).toContain("Cliente: Santiago · Contesta en español.");
  });
  it("sin teléfono en la ficha: lo dice, para que lo pida", () => {
    const out = prompt({ firstName: "Bre", preferredLanguage: "ES", phone: "", email: null }, YAX);
    expect(out).toContain("WhatsApp/teléfono: NO");
  });
  it("con teléfono (formulario o WhatsApp): no lo vuelve a pedir", () => {
    const out = prompt({ firstName: "Bre", preferredLanguage: "ES", phone: "+529982144097", email: "b@x.mx" }, YAX);
    expect(out).toContain("WhatsApp/teléfono: sí · correo: sí. No pidas lo que ya tenemos.");
  });
  it("quien no manda el dato (agentes de fondo) no recibe la línea", () => {
    const out = prompt({ firstName: "Ana", preferredLanguage: "ES" });
    expect(out).not.toContain("Datos que ya tenemos");
  });
});

describe("#989 — opener y guion", () => {
  const cfg = { ...DEFAULT_BOT_CONFIG, openerStyle: "WARM_NAME" } as typeof DEFAULT_BOT_CONFIG;
  it("opener con nombre de relleno: no saluda «a Messenger»", () => {
    const o = buildOpener(cfg, { firstName: "Messenger" });
    expect(o).not.toContain("Saluda a Messenger");
    expect(o).toContain("todavía no sabes su nombre");
  });
  it("opener con nombre real: igual que siempre", () => {
    expect(buildOpener(cfg, { firstName: "Ana" })).toContain("Saluda a Ana por su nombre");
  });
  it("el guion NO da por capturado un nombre de relleno", () => {
    expect(isFieldFilled({ firstName: "Messenger" }, "firstName")).toBe(false);
    expect(isFieldFilled({ firstName: "@fer.bonah" }, "firstName")).toBe(false);
    expect(isFieldFilled({ firstName: "Bre" }, "firstName")).toBe(true);
    const nombre = { key: "nombre", order: 0, objective: "nombre", targetField: "firstName", required: true, skipIfFilled: true };
    expect(nextTask([nombre], [], { firstName: "Messenger" })?.key).toBe("nombre");
  });
  it("cierre del guion de la marca: avisa que un asesor lo contacta y no sigue calificando", () => {
    const o = brandCompletionObjective("Yaxnáh Caucel");
    expect(o).toContain("un asesor de Yaxnáh Caucel lo va a contactar por WhatsApp");
    expect(o).toContain("No hagas más preguntas de calificación");
  });
});
