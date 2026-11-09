// Cliente Claude mínimo via fetch (sin SDK — la dep se retiró en T6).
// Voz Sage: pedagógico, anti-hype, data-grounded (Playbook Comercial, §6.0).
import type { BotConfigResolved } from "./config";
import { getTonePreset } from "./tone-presets";
import { catalogBrief } from "./hub-catalog";
import { ESCALATE_MARKETING_TOKEN } from "./marketing-routing";
import { resolveBotModel } from "./model";
import { isPlaceholderFirstName } from "@/lib/messaging/lead-form-summary";

const API_URL = "https://api.anthropic.com/v1/messages";

export interface BotMessage {
  role: "user" | "assistant";
  content: string;
}

// @deprecated Ya nadie importa este prompt fijo (todos los consumidores — bot-respond,
// ai-actions AI_DRAFT, agents/runner — migraron a buildSystemPrompt(), que resuelve
// marca+tono+objetivo+catálogo desde BotConfigResolved). Se deja sin exportar como
// único fallback interno de askClaude() cuando alguien la llama sin `system` explícito
// (hoy ningún caller lo hace). No usar en código nuevo: usa buildSystemPrompt().
const SAGE_SYSTEM_PROMPT = `Eres el asistente comercial de Propyte, comercializadora inmobiliaria con producto en Tulum, Playa del Carmen, Cancún, Mérida y Telchac.
Tu voz es Sage: pedagógica, serena, basada en datos. NUNCA usas hype, urgencia artificial,
ni prometes retornos ("plusvalía garantizada", "oportunidad única" están PROHIBIDOS).

Reglas inquebrantables (data-gate):
- NO inventes cifras. Precios, ROI o % de avance SOLO si te los dan en el contexto, citando la fuente.
- Si no tienes el dato: "ese dato lo confirmo con tu asesor" — jamás aproximes.
- Tu objetivo: ayudar a perfilar (presupuesto, zona, recámaras, plazo), responder FAQ del catálogo
  que te den en contexto, y agendar una llamada/visita con el asesor.
- Si el cliente quiere apartar, negociar precio, tiene una queja, o pregunta algo legal/fiscal:
  responde brevemente que su asesor lo atenderá de inmediato y NO sigas tú.
- Responde en el idioma del cliente (ES/EN). Mensajes cortos, estilo WhatsApp (máx ~3 líneas).
- Nunca digas que eres una IA salvo pregunta directa; entonces sé honesto.`;

export type ThinkingField = { thinking?: { type: "disabled" | "between_tools" } };

// Cómo apagar el "pensar antes de responder" según el modelo (el bot contesta WhatsApp:
// no queremos latencia ni tokens de razonamiento):
//  - Sonnet 5.5: `disabled` devuelve 400 invalid_request_error; la forma de apagarlo es
//    `between_tools`. Omitir el campo NO lo apaga (corre thinking adaptativo).
//    INCIDENTE 2026-10-12: al subir el default a 5.5 se seguía mandando `disabled` y el
//    bot dejó de contestar (la llamada fallaba con 400 y nadie respondía al cliente).
//  - Sonnet 5 / 4.6 y Opus 4.6+ aceptan `disabled`.
//  - Haiku 4.5 y modelos previos no lo usan: se omite (su default es sin thinking).
export function thinkingFieldFor(model: string): ThinkingField {
  if (/sonnet-5-5/.test(model)) return { thinking: { type: "between_tools" } };
  const adaptiveFamily = /sonnet-5|sonnet-4-6|opus-4-(6|7|8)/.test(model);
  return adaptiveFamily ? { thinking: { type: "disabled" } } : {};
}

export function buildClaudeRequestBody(opts: {
  model: string;
  system: string;
  messages: BotMessage[];
  maxTokens: number;
}) {
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    ...thinkingFieldFor(opts.model),
    messages: opts.messages,
  };
}

/**
 * Por qué askClaude no trajo texto (2026-10-12). Antes `null` significaba a la vez «no hay
 * llave» y «la API contestó vacío», y un error de la API solo llegaba al console.error de
 * quien llamó: sin acceso a los registros del servidor, el bot callado no decía por qué.
 * `detalle` ya viene recortado y sin la llave: es seguro ponerlo en una nota interna.
 */
export type ClaudeSinRespuesta =
  | { motivo: "sin_api_key" }
  | { motivo: "respuesta_vacia"; stopReason: string | null }
  /** `status` null = la llamada no se completó (tiempo agotado o fallo de red). */
  | { motivo: "error_api"; status: number | null; detalle: string };

/** Lo llena askClaude cuando no devuelve texto (o justo antes de lanzar). */
export interface DiagnosticoClaude {
  sinRespuesta?: ClaudeSinRespuesta;
}

/**
 * `diagnostico` es un segundo argumento opcional y no una función nueva: el contrato de
 * askClaude (texto o null; lanza ante un error de la API) no cambia para ninguno de sus
 * llamadores, y los dobles de prueba que la sustituyen entera siguen sirviendo. Quien quiere
 * saber por qué no hubo texto lo pasa y lo lee después.
 */
export async function askClaude(
  opts: {
    system?: string;
    messages: BotMessage[];
    maxTokens?: number;
    model?: string;
  },
  diagnostico?: DiagnosticoClaude,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    // sin llave → quien llama decide el fallback
    if (diagnostico) diagnostico.sinRespuesta = { motivo: "sin_api_key" };
    return null;
  }

  const model = resolveBotModel(opts.model);
  const system = opts.system ?? SAGE_SYSTEM_PROMPT;
  const body = buildClaudeRequestBody({
    model,
    system,
    messages: opts.messages,
    maxTokens: opts.maxTokens ?? 400,
  });

  let res: Response;
  try {
    res = await pedirAClaude(body, apiKey);
  } catch (err) {
    if (diagnostico) {
      diagnostico.sinRespuesta = { motivo: "error_api", status: null, detalle: describirFalloDeLlamada(err, apiKey) };
    }
    throw err;
  }

  if (!res.ok) {
    const detail = ocultarLlave(await res.text().catch(() => ""), apiKey);
    if (diagnostico) {
      diagnostico.sinRespuesta = { motivo: "error_api", status: res.status, detalle: resumirErrorDeApi(detail) };
    }
    throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
  }
  let data: { content?: Array<{ type: string; text?: string }>; stop_reason?: string | null };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    if (diagnostico) {
      diagnostico.sinRespuesta = { motivo: "error_api", status: res.status, detalle: "la respuesta de la API no es JSON válido" };
    }
    throw err;
  }
  const text = data.content?.find((b) => b.type === "text")?.text?.trim();
  if (!text) {
    if (diagnostico) diagnostico.sinRespuesta = { motivo: "respuesta_vacia", stopReason: data.stop_reason ?? null };
    return null;
  }
  return text;
}

/** La llave nunca sale de aquí: ni en el error que se lanza ni en el diagnóstico. */
function ocultarLlave(text: string, apiKey: string): string {
  return text.split(apiKey).join("[oculto]").replace(/sk-ant-[\w-]+/g, "[oculto]");
}

/**
 * `tipo: mensaje` del cuerpo de error de la API ({"type":"error","error":{…},"request_id":…}).
 * Sin el request_id a propósito: cambia en cada llamada, y la nota se deduplica por texto.
 */
function resumirErrorDeApi(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: { type?: unknown; message?: unknown } } | null;
    const tipo = typeof parsed?.error?.type === "string" ? parsed.error.type : null;
    const mensaje = typeof parsed?.error?.message === "string" ? parsed.error.message : null;
    if (tipo || mensaje) return [tipo, mensaje].filter(Boolean).join(": ").slice(0, 300);
  } catch {
    // no era JSON: va el texto tal cual, recortado
  }
  return detail.trim().slice(0, 300) || "sin detalle";
}

function describirFalloDeLlamada(err: unknown, apiKey: string): string {
  if (err instanceof Error && err.name === "AbortError") {
    return `sin respuesta en ${TIMEOUT_MS / 1000} s, tampoco en el reintento (tiempo agotado)`;
  }
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return ocultarLlave(text, apiKey).slice(0, 300);
}

// ─────────────────── Timeout y reintento (auditoría 2026-09-10) ───────────────────
//
// Esta era la ÚNICA de las cuatro llamadas a la API que no tenía límite de tiempo.
// `classify.ts` y `playbook/extract.ts` ya abortaban a los 4s, y el comentario de
// extract.ts nombra el motivo: «sin límite, una API lenta puede arrastrar la request
// completa al 502 de Hostinger». Justo el camino que le contesta al cliente
// (bot-respond.ts) era el que corría sin red.
//
// El presupuesto sale del `maxDuration = 30` de los webhooks que invocan al bot, y ahí
// dentro cabe también la ingesta del mensaje. Peor caso de esta función:
// 10s + 0.4s + 10s ≈ 20.4s, que deja margen. No se sube el timeout ni se añade un
// segundo reintento sin recalcular contra ese 30.
const TIMEOUT_MS = 10_000;
const REINTENTOS = 1; // un solo reintento: el presupuesto no da para más
const ESPERA_BASE_MS = 400;

/** 429 y 5xx son transitorios; 400/401/404 no se arreglan repitiéndolos. */
function vaAReintentar(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Un POST a la API con timeout, y reintento sólo ante fallos transitorios.
 *
 * Antes, un 429 o un 529 (sobrecarga) dejaba al prospecto sin respuesta: `askClaude`
 * lanzaba, `botRespond` propagaba y el webhook lo registraba y seguía. Desde fuera se veía
 * como un bot que simplemente no contestó ese mensaje.
 */
async function pedirAClaude(body: unknown, apiKey: string): Promise<Response> {
  let ultimoError: unknown = null;

  for (let intento = 0; intento <= REINTENTOS; intento++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (intento < REINTENTOS && vaAReintentar(res.status)) {
        // `retry-after` de la propia API manda sobre el backoff, topado para no
        // comerse el presupuesto del webhook.
        const sugerido = Number(res.headers.get("retry-after")) * 1000;
        const espera = Number.isFinite(sugerido) && sugerido > 0
          ? Math.min(sugerido, ESPERA_BASE_MS * 4)
          : ESPERA_BASE_MS * (intento + 1);
        console.warn(`[bot/claude] ${res.status} transitorio; reintento en ${espera}ms`);
        await new Promise((r) => setTimeout(r, espera));
        continue;
      }
      return res;
    } catch (err) {
      // Timeout (AbortError) o fallo de red. Se reintenta una vez; si era el último
      // intento, se propaga para que quien llama lo registre.
      ultimoError = err;
      if (intento < REINTENTOS) {
        console.warn(
          `[bot/claude] la llamada falló (${err instanceof Error ? err.name : "error"}); un reintento`,
        );
        await new Promise((r) => setTimeout(r, ESPERA_BASE_MS));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw ultimoError instanceof Error
    ? ultimoError
    : new Error("Claude API: la llamada no se pudo completar");
}

// --- Ensamblado de prompt en 4 capas (marca / tono / objetivo / catálogo) ---
// Reemplaza a SAGE_SYSTEM_PROMPT (fijo, @deprecated arriba) por un prompt construido
// según BotConfigResolved.

export const ESCALATE_TOKEN = "[ESCALAR]";

/** Datos de marca que entran al prompt (2026-10-09, spec marcas-agente §3.3). */
export interface BrandPromptInput {
  name: string;
  persona: string | null;
  knowledge: string | null;
  /** Para reglas que dependen de la marca y no de su texto (p. ej. el idioma fijo). */
  slug?: string;
}

/**
 * Marcas cuyo bot contesta SIEMPRE en español, escriba el cliente en el idioma que escriba
 * (2026-10-27). Yaxnáh vende casas con crédito INFONAVIT/FOVISSSTE en Mérida: su equipo atiende
 * en español, y el formulario en inglés de Meta hacía que el bot siguiera la conversación en
 * inglés. Va por slug y no por nombre porque el nombre se edita (ya pasó de «Yaxnáh Caucel» a
 * «Yaxnáh» y de vuelta); si alguien cambia el slug de la marca en Ajustes, hay que cambiarlo aquí.
 * Propyte (sin marca) y las demás marcas siguen contestando en el idioma del cliente.
 */
const SPANISH_ONLY_BRAND_SLUGS: ReadonlySet<string> = new Set(["yaxnah"]);

export function brandAlwaysSpanish(brand?: BrandPromptInput): boolean {
  return !!brand?.slug && SPANISH_ONLY_BRAND_SLUGS.has(brand.slug);
}

const FOLLOW_CLIENT_LANGUAGE_RULE =
  "Responde SIEMPRE en el idioma del ÚLTIMO mensaje del cliente: si escribe en inglés contesta en inglés, si escribe en español contesta en español — aunque el idioma registrado del contacto diga otra cosa.";

const SPANISH_ONLY_RULE =
  "Responde SIEMPRE en español, sin excepción: aunque el cliente escriba en inglés o en otro idioma, aunque haya llenado el formulario en inglés y aunque mensajes anteriores de esta conversación estén en inglés. Nunca cambies de idioma ni ofrezcas atenderlo en otro idioma.";

// Sin marca, la presentación es la de siempre (byte a byte): el prompt de Propyte no cambia.
const LEGACY_IDENTITY = "Eres el asistente comercial de Propyte, comercializadora inmobiliaria con producto en Tulum, Playa del Carmen, Cancún, Mérida y Telchac.";

function identityLines(brand?: BrandPromptInput): string[] {
  if (!brand) return [LEGACY_IDENTITY];
  const persona = brand.persona?.trim() || `Eres el asistente comercial de ${brand.name}.`;
  return [
    persona,
    `Representas únicamente a ${brand.name}. No menciones ni ofrezcas otras marcas, desarrollos o ciudades; si preguntan por algo fuera de ${brand.name}, ofrece que un asesor lo contacte.`,
  ];
}

export function buildBrandRules(config: BotConfigResolved, brand?: BrandPromptInput): string {
  const gate = config.dataGateStrict
    ? "NO inventes cifras. Precios, ROI o % de avance SOLO si te los dan en el contexto, citando la fuente. Si no tienes el dato: ofrécele confirmarlo con su asesor; jamás aproximes."
    : "Prioriza cifras del contexto. Si no las tienes, dilo con naturalidad y ofrece confirmarlo con su asesor.";
  const triggers = config.escalationTriggers.join(", ");
  return [
    ...identityLines(brand),
    "NUNCA usas hype, urgencia artificial ni prometes retornos.",
    gate,
    `Tu objetivo: perfilar (presupuesto, zona, recámaras, plazo), responder FAQ del catálogo que te den en contexto, y agendar una llamada/visita con el asesor.`,
    `Si detectas intención fuerte o alguno de estos temas (${triggers}), responde un mensaje breve de transición y termina con el token ${ESCALATE_TOKEN}. No sigas tú.`,
    // FIX 2026-09-22 (hallazgo #790, pruebas en vivo de #787): sin esta línea, el modelo
    // podía ofrecer "¿te parece si tu asesor te contacta?", el cliente confirmaba que sí,
    // y el bot respondía "le comparto tu interés..." SIN el token — es decir, le decía al
    // cliente que ya escaló cuando en realidad la conversación se quedaba en modo bot: sin
    // notificación al asesor, sin cambio de estado, sin resumen nuevo. El cliente se
    // quedaba esperando un contacto que nadie iba a hacer.
    `Si le ofreces al cliente conectarlo con su asesor (por presupuesto fuera de catálogo, disponibilidad, o cualquier otro motivo) y el cliente confirma que sí quiere ese contacto, ese "sí" ES intención fuerte: termina tu respuesta con el token ${ESCALATE_TOKEN} en ese mismo turno. Nunca digas "le comparto tu interés" o "tu asesor te contacta" sin incluir el token — sin él, nadie se entera y el cliente se queda esperando un contacto que no llega.`,
    // 2026-10-08: quien viene a OFRECER marketing/servicios no es comprador — no hay
    // nada que calificar. Antes el modelo le pedía una confirmación y escalaba en el mismo
    // turno: el cliente contestaba y nadie le respondía (la conversación ya estaba en
    // HUMAN, sin responsable). Ahora cierra sin preguntas y con un token propio que
    // redirige el hilo a la persona de marketing.
    `Si la persona NO busca propiedad sino que viene a ofrecer o presentar servicios, publicidad, marketing, una propuesta comercial o una alianza, o pide hablar con el equipo de marketing: responde UN mensaje breve y cálido diciendo que compartes su mensaje con la persona responsable para que se comunique con ella por este mismo chat. NO le hagas preguntas, NO le pidas confirmación, NO prometas tiempos y NO la califiques como compradora, y termina con el token ${ESCALATE_MARKETING_TOKEN} (en lugar de ${ESCALATE_TOKEN}).`,
    // BUG 2026-07-24: el "Idioma: ES" del perfil (default del intake) le ganaba a esta
    // regla y el bot contestaba en español a mensajes en inglés. El último mensaje manda.
    brandAlwaysSpanish(brand) ? SPANISH_ONLY_RULE : FOLLOW_CLIENT_LANGUAGE_RULE,
    `Mensajes cortos, estilo WhatsApp (máx ~${config.maxLines} líneas): contesta lo que preguntó y avanza un paso; no sueltes toda la información de golpe.`,
    "En WhatsApp la negrita se escribe con UN solo asterisco (*así*). NUNCA uses sintaxis markdown: ni doble asterisco (**negrita**) ni encabezados con #.",
    ...CONVERSATION_RULES,
    ...(brand ? [brandHandoffRule(brand.name)] : []),
  ].join("\n");
}

/**
 * Reglas de conversación (#989, 2026-11-09). Salieron de conversaciones reales:
 * - Propyte por Instagram: el cliente escribió «el otro mejor bull_caribbean» y luego «es un bot»;
 *   el bot repitió palabra por palabra la misma pregunta de zona con la misma lista de cinco
 *   ciudades, y no ofreció pasarlo con una persona.
 * - Yaxnáh: el bot volvía a saludar («¡Hola, Santiago!») a media conversación y cerraba mensajes
 *   con información sin pregunta, así que la plática se quedaba ahí.
 * Aplican con y sin marca. La de «¿eres un bot?» reemplaza a la línea de antes («Nunca digas que
 * eres una IA salvo pregunta directa; entonces sé honesto»), que no decía qué hacer después.
 */
const CONVERSATION_RULES: readonly string[] = [
  "Saluda solo en tu primer mensaje de la conversación. En los siguientes no vuelvas a decir «hola» ni a presentarte.",
  "Nunca repitas una pregunta con las mismas palabras. Si el cliente no la contestó o cambió de tema, atiende primero lo que dijo; si todavía necesitas ese dato, pídelo de otra forma y más fácil (por ejemplo, con dos opciones en vez de una lista larga). Si ya lo preguntaste dos veces sin respuesta, déjalo y ofrece que un asesor lo contacte.",
  "Termina cada mensaje con UNA sola pregunta o un siguiente paso concreto. Nunca cierres solo con información ni con dos preguntas a la vez.",
  "Si menciona otra inmobiliaria, otro desarrollo, otra cuenta o un nombre o @usuario que no conoces, no supongas qué es, no lo critiques ni lo compares: pregúntale qué le gustó o qué está buscando y ofrécele lo que sí tienes.",
  "Si no entiendes el mensaje, pide que te lo aclare con una frase corta, sin suponer.",
  "Nunca digas que eres una IA si no te lo preguntan. Si te pregunta si eres un bot o una persona, sé honesto: eres el asistente virtual y hay asesores de carne y hueso; ofrécele en ese momento que uno lo contacte, en lugar de repetir lo que le estabas preguntando. Si acepta, es intención fuerte.",
];

/**
 * Con marca: qué tiene que conseguir el bot antes de soltar la conversación (#989). El bot de
 * Yaxnáh contestaba dudas pero casi nunca pedía el WhatsApp, y en Instagram/Messenger sin ese dato
 * el asesor no tiene cómo buscar al cliente: la plática moría en el chat.
 */
function brandHandoffRule(brandName: string): string {
  return `Tu trabajo es que un asesor de ${brandName} pueda contactar al cliente. Si todavía no tenemos su WhatsApp, pídeselo con naturalidad en cuanto muestre interés (precio, modelos, crédito o visita), después de contestar su duda. Si ya lo tenemos, no lo vuelvas a pedir.`;
}

const DEFAULT_OBJECTIVE =
  "Saluda y avanza en calificar (zona, presupuesto, plazo) con una sola pregunta a la vez.";

/**
 * Objetivo por defecto con marca (#989). El de arriba es de Propyte: pide «zona» (las marcas
 * tienen un solo lugar) y empieza con «Saluda», que el bot de Yaxnáh obedecía en cada turno. Se
 * usa cuando la marca no tiene guion propio o el guion no dio paso.
 */
export const BRAND_DEFAULT_OBJECTIVE =
  "Contesta lo que pregunta el cliente y avanza, con una sola pregunta a la vez, hacia lo que necesita el asesor: su nombre, su WhatsApp (si aún no lo tenemos), cómo piensa pagar y qué busca. Con eso, propón agendar una visita o una llamada con un asesor.";

/**
 * La línea del cliente en el prompt. El alta de Instagram/Messenger pone «Messenger», «Instagram»
 * o el @usuario cuando el canal no da un nombre real, y el bot saludaba «¡Hola, Messenger!» (#989).
 */
function clientLine(
  contact: { firstName: string; preferredLanguage: string; phone?: string | null; email?: string | null },
  brand?: BrandPromptInput,
): string {
  const nombre = isPlaceholderFirstName(contact.firstName)
    ? "todavía no sabes su nombre (el de su perfil no es un nombre real: no lo llames así); pregúntaselo con naturalidad"
    : contact.firstName;
  const idioma = brandAlwaysSpanish(brand)
    ? "Contesta en español."
    : `Idioma registrado: ${contact.preferredLanguage} (solo referencia — responde en el idioma del último mensaje del cliente)`;
  const lines = [`Cliente: ${nombre} · ${idioma}`];
  // Solo si quien llama mandó el dato (undefined = no se sabe; los agentes de fondo no lo mandan).
  if (contact.phone !== undefined) {
    const tel = contact.phone?.trim() ? "sí" : "NO";
    const correo = contact.email?.trim() ? "sí" : "no";
    lines.push(`Datos que ya tenemos en su ficha: WhatsApp/teléfono: ${tel} · correo: ${correo}. No pidas lo que ya tenemos.`);
  }
  return lines.join("\n");
}

// contact/catalog son opcionales: el runner de agentes de fondo (Agent Studio) no
// habla con UN cliente en una conversación 1:1 — opera cross-contact vía tools — así
// que arma marca+tono+objetivo sin esos bloques (ver src/lib/agents/runner.ts).
export function buildSystemPrompt(args: {
  config: BotConfigResolved;
  /** `phone`/`email`: opcionales; si se mandan (aunque vacíos), el prompt dice qué datos ya tenemos. */
  contact?: { firstName: string; preferredLanguage: string; phone?: string | null; email?: string | null };
  catalog?: Parameters<typeof catalogBrief>[0];
  objective?: string;
  brand?: BrandPromptInput;
}): string {
  const { config, contact, catalog, brand } = args;
  const preset = getTonePreset(config.tonePreset);

  const examples = preset.fewShot
    .map((e) => `${e.role === "user" ? "Cliente" : "Tú"}: ${e.content}`)
    .join("\n");

  const catalogBlock =
    catalog && catalog.length > 0
      ? (brand
          ? catalogBrief(catalog, `Catálogo oficial de ${brand.name} (fuente oficial, puedes citar estos datos):`)
          : catalogBrief(catalog))
      : "(No tienes catálogo en contexto: NO cites precios.)";

  const parts = [
    buildBrandRules(config, brand),
    `\nTono y estilo:\n${preset.voiceGuidance}`,
  ];
  // Los ejemplos de los presets son de Tulum: con marca se omiten (se conserva la guía de estilo).
  if (!brand) parts.push(`\nEjemplos de tu estilo (imítalos en registro, no los copies literal):\n${examples}`);
  if (brand?.knowledge?.trim()) {
    parts.push(`\nInformación oficial de ${brand.name} (puedes citarla; lo que no esté aquí ni en el catálogo, no lo inventes):\n${brand.knowledge.trim()}`);
  }
  parts.push(`\nObjetivo ahora: ${args.objective ?? (brand ? BRAND_DEFAULT_OBJECTIVE : DEFAULT_OBJECTIVE)}`);
  if (contact) {
    // "registrado" + "solo referencia": el preferredLanguage suele ser el default ES del
    // intake, no una elección del cliente — no debe leerse como directiva de idioma.
    // Con idioma fijo de la marca, el registrado no se menciona: no debe abrir la puerta a otro idioma.
    parts.push(`\n${clientLine(contact, brand)}`);
  }
  parts.push(`\n${catalogBlock}`);

  return parts.join("\n");
}
