// botRespond — pipeline del bot WhatsApp L2 con red (Anexo B §I.4).
// Contexto → RAG catálogo Hub (data-gate) → Claude (voz Sage) → brand linter →
// envía o ESCALA a humano (intención fuerte / sin confianza).
import { maxTokensDeLineas } from "./largo-respuesta";
import prisma from "@/lib/db";
import {
  askClaude,
  buildSystemPrompt,
  ESCALATE_TOKEN,
  type BotMessage,
  type BrandPromptInput,
  type ClaudeSinRespuesta,
  type DiagnosticoClaude,
} from "./claude";
import { ESCALATE_MARKETING_TOKEN, getMarketingOwnerId } from "./marketing-routing";
import { getBotConfig, type BotConfigResolved } from "./config";
import { lintBrandVoice } from "./brand-linter";
import { findMatchingDevelopments } from "./hub-catalog";
import { runPlaybookStep } from "./playbook/run";
import type { MessagingChannel } from "@/lib/messaging/types";
import { sendChannelMessage } from "@/lib/messaging/dispatcher";
import { recordBotSendFailure, recordBotSilence } from "@/lib/messaging/send-failure";
import { avisarHiloSinDueno } from "@/lib/messaging/aviso-sin-dueno";
import { applyAgentTone, composeObjective, agentPlaybookOf } from "./agent-profiles";
import { resolveBrandForConnector, isBrandScoped, type BrandResolution } from "@/lib/brands/resolve";
import { brandEnabledChannels } from "@/lib/brands/settings";
import { resolveActorUserId } from "@/lib/users/actor-sistema";
import { isAdvisorLine } from "@/lib/whatsapp/coex/advisor-line";
import { esAgenteReclutamiento, hookReclutamiento } from "@/lib/reclutamiento/hook";
import { isPlaceholderFirstName } from "@/lib/messaging/lead-form-summary";

/**
 * `enabledChannelsOverride` (2026-10-09, marcas del agente): los canales propios de la marca
 * reemplazan a `config.enabledChannels`; null/undefined = los globales. El interruptor
 * maestro `botEnabled` sigue mandando siempre.
 */
export function shouldBotRespondForChannel(
  config: BotConfigResolved,
  channel: string,
  enabledChannelsOverride?: string[] | null,
): boolean {
  return config.botEnabled && (enabledChannelsOverride ?? config.enabledChannels).includes(channel);
}

export function buildOpener(
  config: BotConfigResolved,
  contact: { firstName: string; preferredZone?: string | null },
  goal?: string,
): string {
  const interes = contact.preferredZone ? contact.preferredZone : "lo que busca";
  const goalLine = goal ? ` El objetivo de este primer mensaje es: ${goal}.` : "";
  if (config.openerStyle === "DIRECT") {
    return `Este es el primer mensaje. Preséntate breve y haz UNA pregunta para empezar a calificar (${interes}).${goalLine} No suenes a script.`;
  }
  // #989: «Messenger»/«Instagram»/@usuario no son nombres; el bot saludaba «¡Hola, Messenger!».
  const saludo = isPlaceholderFirstName(contact.firstName)
    ? "Saluda de forma cálida y natural (todavía no sabes su nombre: no uses el de su perfil)"
    : `Saluda a ${contact.firstName} por su nombre de forma cálida y natural`;
  return `Este es el primer mensaje. ${saludo}, menciona brevemente su interés (${interes}) si lo conoces, y haz UNA pregunta para empezar a calificar.${goalLine} No suenes a script.`;
}

/**
 * Con marca, cuando su guion termina de reunir los datos (#989). Antes el bot proponía la visita
 * y la conversación se quedaba en modo bot: si el cliente ya no contestaba, nadie se enteraba de
 * que había un lead con nombre, WhatsApp y forma de pago listo para llamarle. Ahora el bot le dice
 * que un asesor lo va a contactar y la conversación pasa al asesor con aviso (escalateToHuman).
 */
export function brandCompletionObjective(brandName: string): string {
  return `Ya tienes los datos que necesita el asesor. Agradécele, contesta si hizo alguna pregunta y dile que un asesor de ${brandName} lo va a contactar por WhatsApp para agendar su visita o llamada. No hagas más preguntas de calificación.`;
}

export async function escalateToHuman(
  conversationId: string,
  reason: string,
  opts: { routeToUserId?: string | null } = {},
): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!conv) return;

  // Resumen del hilo para que el asesor retome en segundos (§I.5)
  const history = await prisma.message.findMany({
    where: { conversationId, internalNote: false },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  const transcript = history
    .reverse()
    .map((m) => `${m.direction === "INBOUND" ? "Cliente" : "Bot/Asesor"}: ${m.body}`)
    .join("\n");
  const summary =
    (await askClaude({
      system: "Resume esta conversación de WhatsApp en 2-3 líneas para el asesor que la va a tomar. Incluye: qué busca el cliente, datos capturados, y el motivo de escalamiento. Español.",
      messages: [{ role: "user", content: `Motivo: ${reason}\n\n${transcript}` }],
      maxTokens: 200,
    }).catch(() => null)) ?? `Escalado: ${reason}`;

  // `routeToUserId` gana sobre el asesor del contacto: es el caso de las propuestas de
  // marketing (siempre a Luis Flores, ver marketing-routing.ts), que no son un lead de
  // ningún asesor. No se reasigna el contacto —solo quién controla el hilo y a quién se
  // le avisa—: tocar la asignación del contacto es decisión humana desde el inbox.
  const assigneeId = opts.routeToUserId ?? conv.contact.assignedToId;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: "HUMAN",
      controlledById: assigneeId,
      takeoverAt: new Date(),
      aiSummary: summary,
    },
  });

  if (assigneeId) {
    await prisma.notification.create({
      data: {
        userId: assigneeId,
        title: "El bot te pasó una conversación",
        message: `${conv.contact.firstName} ${conv.contact.lastName}: ${summary.slice(0, 180)}`,
        type: "bot_escalation",
        link: `/inbox?c=${conversationId}`,
      },
    });
    return;
  }

  // #858 (2026-10-14): sin asesor no había a quién avisar y aquí terminaba todo — el bot ya
  // le había dicho al cliente que pasaba su mensaje a la persona responsable, y esa persona
  // no existía (caso real: el valuador de BBVA de la conversación 9c1379d8, dos días sin
  // respuesta). Ahora avisa a quien corresponda según la marca de la cuenta y la plaza del
  // contacto (ver lib/messaging/aviso-sin-dueno.ts). `controlledById` se queda en null a
  // propósito: con varios destinatarios no hay uno que elegir, lo toma quien conteste.
  // El escalamiento ya quedó escrito arriba; un fallo del aviso no lo deshace.
  try {
    await avisarHiloSinDueno({
      conversationId,
      connectorId: conv.connectorId ?? null,
      plaza: conv.contact.targetPlaza ?? null,
      title: "El bot pasó una conversación sin asesor",
      message: `${conv.contact.firstName} ${conv.contact.lastName}: ${summary.slice(0, 180)}`,
      type: "bot_escalation",
    });
  } catch (err) {
    console.error(`[bot-respond] aviso del escalamiento sin dueño falló (${conversationId}):`, err);
  }
}

// ─────────────── Por qué se calló el agente (2026-10-12) ───────────────
//
// Dos WhatsApp al número general se quedaron sin respuesta y sin rastro: ni saliente, ni nota,
// la conversación en BOT, el canal activo, el contacto sin baja. Sin acceso a los registros del
// servidor, cada `return false` de botRespond se veía igual. Ahora los que delatan algo mal o
// mal configurado dejan una nota interna «El agente no contestó: …» (recordBotSilence). Los
// silencios NORMALES no la dejan, a propósito: interruptor maestro apagado, contacto dado de
// baja, hilo en manos de un humano o con el bot apagado, la ráfaga que contesta otro disparo,
// el agente de la marca apagado (ya escala) y el contacto que es solo de otra marca.

/** Objetivo mínimo cuando el playbook no dio paso ni hay ruta A, pero sí hay contexto que anexar. */
const OBJETIVO_SIN_PASO = "Continúa la conversación con naturalidad y retoma la pregunta pendiente del guion.";

const CHANNEL_NAMES: Record<MessagingChannel, string> = {
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
};

function channelList(channels: string[]): string {
  return channels.length > 0
    ? channels.map((c) => CHANNEL_NAMES[c as MessagingChannel] ?? c).join(", ")
    : "ninguno";
}

/** Motivo de la nota cuando la marca de la cuenta no se puede usar. */
function brandUnavailableReason(brandId: string): string {
  return brandId === "?"
    ? "no se pudo leer la cuenta por la que llegó el mensaje para saber de qué marca es; " +
        "por seguridad no se contesta con una marca sin confirmar."
    : `la cuenta por la que llegó el mensaje está asignada a una marca que fue borrada o no se pudo leer (marca ${brandId}). ` +
        "Revisa la marca de la cuenta en Conexiones.";
}

function accountLabel(connectorId: string | null, res: BrandResolution): string {
  if (!connectorId) return "el número general";
  const marca = res.kind === "brand" ? ` (marca «${res.brand.name}»)` : res.kind === "unavailable" ? " (marca no disponible)" : "";
  return `la cuenta ${connectorId}${marca}`;
}

/** Texto de la nota cuando la IA no trajo respuesta. Sin diagnóstico (doble de prueba), lo genérico. */
export function describeAiSilence(motivo: ClaudeSinRespuesta | undefined, err?: unknown): string {
  const base = "la IA no devolvió respuesta";
  if (motivo?.motivo === "sin_api_key") {
    return `${base}: falta la llave de la API de Claude (ANTHROPIC_API_KEY) en el servidor.`;
  }
  if (motivo?.motivo === "respuesta_vacia") {
    return `${base}: la API de Claude contestó sin texto${motivo.stopReason ? ` (stop_reason: ${motivo.stopReason})` : ""}.`;
  }
  if (motivo?.motivo === "error_api") {
    return motivo.status !== null
      ? `${base}: la API de Claude respondió con error HTTP ${motivo.status} (${motivo.detalle}).`
      : `${base}: la llamada a la API de Claude no se completó (${motivo.detalle}).`;
  }
  if (err !== undefined) {
    return `${base}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
  }
  return `${base}.`;
}

/**
 * ¿El contacto pertenece SOLO a otra marca (no predeterminada, no borrada)? Es decir: tiene fila
 * en contact_brands de una marca no predeterminada y NO tiene la fila de la predeterminada.
 *
 * Revisión final I2 (2026-10-09), spec marcas-agente §2.3: un contacto que ya existía y escribe a
 * otra marca pertenece a AMBAS —attachBrand escribe la fila de la predeterminada justo para eso—,
 * así que sigue siendo de Propyte y el AI_REPLY desde el número global es legítimo. Antes bastaba
 * una fila de otra marca para bloquear, y desde que existe la atribución todo contacto existente
 * de Propyte que escribía a una marca quedaba con las dos filas y sus workflows se saltaban en
 * silencio. La consulta de la predeterminada solo corre cuando hay fila de otra marca (el caso
 * común, sin filas, sigue costando una sola lectura).
 *
 * Tabla o columna inexistente (P2021/P2022: migración sin aplicar) = sin filas. Cualquier otro
 * error de lectura (en cualquiera de las dos consultas) falla cerrado (true): mismo criterio que
 * la marca "no disponible" de resolveBrandForConnector.
 */
async function contactBelongsOnlyToOtherBrand(contactId: string): Promise<boolean> {
  try {
    const otra = await prisma.contactBrand.findFirst({
      where: { contactId, brand: { isDefault: false, deletedAt: null } },
      select: { brandId: true },
    });
    if (!otra) return false;
    const predeterminada = await prisma.contactBrand.findFirst({
      where: { contactId, brand: { isDefault: true } },
      select: { brandId: true },
    });
    if (predeterminada) return false; // compartido: también es de Propyte
    console.warn("[bot-respond] contacto de otra marca sin cuenta: no se abre conversación desde el número global", contactId);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2021" || code === "P2022") return false;
    console.error("[bot-respond] no se pudieron leer las marcas del contacto; no se abre conversación", contactId, err);
    return true;
  }
}

export async function botRespond(
  contactId: string,
  opts: { goal?: string; createConversation?: boolean; channel?: MessagingChannel; connectorId?: string | null } = {}
): Promise<boolean> {
  const channel: MessagingChannel = opts.channel ?? "WHATSAPP";
  const config = await getBotConfig();
  // Atajo barato y sin cambio de conducta: con el master switch apagado nadie contesta.
  if (!config.botEnabled) return false;

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact || contact.doNotContact || (channel === "WHATSAPP" && contact.whatsappOptOut)) return false;

  const { ensureConversation, findConversationForChannel } = await import("@/lib/messaging/conversations");
  // `null` EXPLÍCITO ≠ `undefined` (2026-10-09, revisión final C2): `null` = el llamador SABE que
  // el mensaje llegó al número global (los webhooks pasan la cuenta resuelta o null) y no se
  // infiere nada — inferir podía tomar la cuenta del hilo de otra marca y contestar como ella a
  // un mensaje que el cliente mandó al número de Propyte. `undefined` = el llamador no lo sabe
  // (workflow, ingesta sin cuenta) → la cuenta del hilo más reciente, igual que siempre.
  const connectorId =
    opts.connectorId !== undefined
      ? opts.connectorId
      : ((await findConversationForChannel(contactId, channel))?.connectorId ?? null);

  // Número de asesor (2026-10-14, decisión 2 del dueño): en el WhatsApp propio de un asesor el bot
  // NUNCA contesta, solo él (desde el teléfono o la bandeja). Va antes que todo lo demás y sin nota:
  // callar aquí es lo normal, no un fallo. Sin cuenta (número global) no cuesta ni una consulta.
  if (await isAdvisorLine(connectorId)) return false;

  // El hilo de esta cuenta (ver el comentario de `conv` más abajo). Función para poder usarla
  // también en los silencios que ocurren ANTES de resolver la conversación.
  const findThread = async () =>
    opts.connectorId !== undefined
      ? ((await prisma.conversation.findFirst({ where: { contactId, channel, connectorId: opts.connectorId } })) ??
        (await findConversationForChannel(contactId, channel)))
      : await findConversationForChannel(contactId, channel);

  // Nota de un silencio previo a resolver la conversación (marca, canal). Solo lectura: nunca
  // crea un hilo. Sin hilo, o con un humano al mando (ahí callar es lo normal), no hay nota y
  // queda solo el console.warn de recordBotSilence.
  const noteEarlySilence = async (reason: string) => {
    const thread = await findThread().catch(() => null);
    const conversationId = thread && thread.status === "BOT" && thread.botEnabled ? thread.id : null;
    await recordBotSilence({ contactId, conversationId, channel, reason });
  };

  // Marca de la cuenta (2026-10-09, spec marcas-agente §3.2). Solo una marca NO
  // predeterminada cambia algo; "unavailable" = la cuenta tiene marca pero no se puede
  // usar → NO contestar (mejor callado que responder como otra marca). El chequeo de
  // canal va DESPUÉS de resolver la marca porque los canales pueden ser propios de la marca.
  const brandRes = await resolveBrandForConnector(connectorId);
  if (brandRes.kind === "unavailable") {
    await noteEarlySilence(brandUnavailableReason(brandRes.brandId));
    return false;
  }
  const brand = isBrandScoped(brandRes) ? brandRes.brand : null;
  const brandChannels = brand ? brandEnabledChannels(brand) : null;
  if (!shouldBotRespondForChannel(config, channel, brandChannels)) {
    // El interruptor maestro ya se revisó arriba: aquí solo puede faltar el canal.
    await noteEarlySilence(
      brand && brandChannels
        ? `el canal ${CHANNEL_NAMES[channel]} no está activado para la marca «${brand.name}» ` +
            `(canales de la marca: ${channelList(brandChannels)}).`
        : `el canal ${CHANNEL_NAMES[channel]} no está activado en la configuración general del agente ` +
            `(canales activos: ${channelList(config.enabledChannels)}).`,
    );
    return false;
  }

  // Abrir conversación SIN cuenta (AI_REPLY de un workflow, 2026-10-09, revisión final I3) = escribir
  // desde el número global con la voz de Propyte. Si el contacto pertenece SOLO a otra marca (fila en
  // contact_brands de una marca no predeterminada viva y sin la fila de la predeterminada; I2 de la
  // revisión final), no se abre nada: sería un mensaje de Propyte a un prospecto de esa marca. Un
  // contacto compartido (ambas filas) o sin filas de otra marca (todos los contactos de hoy) → igual que siempre.
  if (opts.createConversation && !connectorId && (await contactBelongsOnlyToOtherBrand(contactId))) return false;

  // La conversación debe ser la de ESA cuenta. `findConversationForChannel` devuelve el hilo
  // más reciente del contacto en el canal entre TODAS las cuentas: un contacto con hilos en
  // el número de Propyte y en el de Yaxnáh podría recibir la voz de una marca por el número
  // de la otra (el envío sale por `conv.connectorId`). Con `opts.connectorId` explícito se
  // busca primero el hilo de esa cuenta — también con `null` (número global): el hilo sin
  // cuenta, el mismo que eligió la ingesta en `ensureConversation` —; sin él (`undefined`),
  // igual que siempre. Si el hilo resultante es de otra cuenta y alguna de las dos tiene marca,
  // el cinturón de abajo no deja contestar (2026-10-09).
  const conv = opts.createConversation
    ? await ensureConversation({ contactId, channel, connectorId })
    : await findThread();
  if (!conv || conv.status !== "BOT" || !conv.botEnabled) return false;
  // Y si el hilo resultante es de otra cuenta, que esa tampoco sea de asesor.
  if ((conv.connectorId ?? null) !== (connectorId ?? null) && (await isAdvisorLine(conv.connectorId))) return false;
  const noteSilence = (reason: string) =>
    recordBotSilence({ contactId, conversationId: conv.id, channel, reason });

  // Cinturón: si aun así el hilo es de otra cuenta que la resuelta, y alguna de las dos tiene
  // marca (o no se puede resolver), NO se contesta — nunca como una marca por la cuenta de
  // otra. Si ambas son predeterminadas, sigue como siempre.
  if ((conv.connectorId ?? null) !== (connectorId ?? null)) {
    const convBrandRes = await resolveBrandForConnector(conv.connectorId);
    if (brandRes.kind !== "default" || convBrandRes.kind !== "default") {
      await noteSilence(
        `esta conversación es de ${accountLabel(conv.connectorId ?? null, convBrandRes)} y el mensaje llegó por ` +
          `${accountLabel(connectorId ?? null, brandRes)}; con una marca de por medio no se contesta por la cuenta de otra.`,
      );
      return false;
    }
  }

  // Agente de la marca apagado: no contesta, pero tampoco deja al cliente sin atender —
  // la conversación pasa a un humano (una sola vez: queda en HUMAN y deja de entrar aquí).
  if (brand && !brand.botEnabled) {
    await escalateToHuman(conv.id, `Agente de la marca «${brand.name}» apagado`);
    return false;
  }

  // Contexto: hilo + perfil + catálogo del Hub (data-gate: SOLO estas cifras son citables)
  const msgs = await prisma.message.findMany({
    // Con marca: solo ESTA conversación — lo hablado con el mismo cliente desde otra
    // marca no entra al contexto. Sin marca: igual que siempre (todo el contacto).
    where: brand ? { conversationId: conv.id, internalNote: false } : { contactId, internalNote: false },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // Watermark anti-burst: el mensaje más nuevo VISTO al armar el contexto. Si al terminar
  // de generar ya existe algo más nuevo (ráfaga texto+adjuntos, webhooks concurrentes u
  // otra generación que ya contestó), esta respuesta se descarta (ver guard abajo).
  const watermark = msgs[0]?.createdAt ?? null;
  const history: BotMessage[] = msgs
    .reverse()
    // Adjuntos (spec reclutamiento §6): un mensaje que es solo archivo llegaba con body vacío y
    // el bot no sabía que ya había CV. Se marca el nombre para que no lo vuelva a pedir.
    .map((m): BotMessage => ({
      role: m.direction === "INBOUND" ? "user" : "assistant",
      content: m.body?.trim()
        ? m.body
        : m.mediaFilename
          ? `[adjunto: ${m.mediaFilename}]`
          : m.mediaUrl
            ? `[adjunto: ${m.mediaType ?? "archivo"}]` // IG/Messenger suelen venir sin nombre
            : m.body,
    }))
    .reduce<BotMessage[]>((acc, m) => {
      if (acc.length === 0 && m.role === "assistant") return acc;
      if (acc.length > 0 && acc[acc.length - 1].role === m.role) {
        acc[acc.length - 1] = { role: m.role, content: acc[acc.length - 1].content + "\n" + m.content };
        return acc;
      }
      acc.push(m);
      return acc;
    }, []);

  // Hilo con mensajes pero SOLO salientes (el reduce descarta los `assistant` iniciales):
  // no hay nada del cliente que contestar. Sin `goal` se omite; con `goal` (seguimiento
  // programado) sigue abajo como primer contacto. Se distingue de "cero mensajes" (primer
  // contacto genuino), que sí debe correr siempre.
  if (history.length === 0 && msgs.length > 0 && !opts.goal) {
    console.info("[bot] el hilo solo tiene mensajes del bot; se omite el turno", { contactId });
    return false;
  }

  if (history.length === 0) {
    history.push({ role: "user", content: "(nuevo lead entrante)" });
  }

  // El historial DEBE terminar en el cliente: si dos inbound llegan con segundos de
  // diferencia, la segunda corrida puede ver el hilo terminando en la respuesta del bot y
  // Claude responde HTTP 400 ("does not support assistant message prefill"). Ese turno ya
  // quedó contestado por la corrida anterior: se omite, igual que el guard anti-burst.
  //
  // Excepción: un seguimiento programado (`opts.goal`, ai-actions.ts) corre POR DEFINICIÓN
  // cuando el hilo termina en el bot. Ahí no se omite: se agrega un turno sintético del
  // cliente para que la llamada sea válida y el modelo redacte el seguimiento.
  if (history[history.length - 1].role === "assistant") {
    if (!opts.goal) {
      console.info("[bot] historial termina en mensaje del bot; se omite el turno", { contactId });
      return false;
    }
    history.push({ role: "user", content: "(seguimiento programado: el cliente no ha respondido)" });
  }

  // Agentes por segmento (Frente 4): clasificar tipo de conversación y elegir el agente
  // (identidad + playbook + tono propios). Solo gasta clasificación si hay agentes activos.
  // Best-effort: cualquier fallo deja el flujo global de siempre intacto.
  // Con marca NO hay agentes por segmento: la marca es la identidad (agentProfile queda en
  // null). Pero SÍ se clasifica el tipo de contacto (#864): desde el #863 los contactos nacen
  // sin tipo, y sin esto los de una marca se quedaban en «—» aunque dijeran claramente que
  // son brokers o inversionistas. El resultado NO se usa para elegir agente — solo deja el
  // tipo en el CRM —, así que la voz de la marca no cambia. Mismo interruptor
  // (classifyContacts) y mismas reglas que sin marca: solo intención explícita, nunca pisa lo
  // que puso un humano. Usa el historial de ESTA conversación (lo de otra marca no entra).
  let agentProfile: import("./agent-profiles").AgentProfileWithPlaybook | null = null;
  if (brand) {
    if (config.classifyContacts) {
      try {
        const { maybeClassifyContact } = await import("./classify");
        await maybeClassifyContact(prisma, contact, history, config.model);
      } catch {
        // defensivo: maybeClassifyContact ya no lanza; un fallo aquí no debe impedir contestar
      }
    }
  } else {
    try {
      const hasAgents = (await prisma.botAgentProfile.count({ where: { isActive: true, deletedAt: null } })) > 0;
      if (hasAgents) {
        const { maybeClassifyContact } = await import("./classify");
        const { selectAgentProfile } = await import("./agent-profiles");
        const effectiveType = config.classifyContacts
          ? await maybeClassifyContact(prisma, contact, history, config.model)
          : contact.contactType;
        agentProfile = await selectAgentProfile(prisma, effectiveType);
      }
    } catch {
      // defensivo: sin agente → comportamiento global
    }
  }

  // Fallo de catálogo ≠ catálogo vacío: si la consulta al Hub falló, omitimos el brief
  // del prompt (buildSystemPrompt cae a "no cites precios") en vez de fingir que no hay
  // inventario. NO se escala solo por esto: el bot puede seguir calificando sin catálogo.
  //
  // Con marca (2026-10-09): el catálogo es SOLO el de los desarrollos de la marca (sin
  // filtrar por presupuesto/zona del contacto: ese perfil puede venir de otra marca).
  //
  // Agente de reclutamiento (2026-11-03): NO recibe el catálogo de ventas. Con él habló de
  // Ancestral y Gran Coralia como departamentos a un candidato. Su ficha (oficinas y
  // desarrollos exclusivos/co-broker) llega por el hook de reclutamiento. Por eso el
  // catálogo se consulta DESPUÉS de resolver el agente.
  const { data: catalog, error: catalogError } = brand
    ? await findMatchingDevelopments({ developmentIds: brand.developmentIds, limit: 10 })
    : esAgenteReclutamiento(agentProfile)
      ? { data: [], error: null }
      : await findMatchingDevelopments({
          budgetMin: contact.budgetMin ? Number(contact.budgetMin) : null,
          budgetMax: contact.budgetMax ? Number(contact.budgetMax) : null,
          zone: contact.preferredZone,
        });
  if (catalogError) console.error("[bot-respond] catálogo del Hub no disponible:", catalogError);

  // El tono propio de la marca reemplaza al global; sin marca (o sin tono) todo igual.
  const baseConfig = brand?.tonePreset ? { ...config, tonePreset: brand.tonePreset } : config;
  const effectiveConfig = applyAgentTone(baseConfig, agentProfile);

  const firstTouch = history.length === 1 && history[0].role === "user";
  const fallbackObjective = firstTouch
    ? buildOpener(
        effectiveConfig,
        // Con marca NO se inyecta la zona del contacto (puede venir de otra marca y
        // contradiría "no menciones otras ciudades" del prompt de la marca).
        { firstName: contact.firstName, preferredZone: brand ? null : contact.preferredZone },
        opts.goal,
      )
    : opts.goal
      ? `Objetivo de este mensaje: ${opts.goal}. Continúa la conversación con naturalidad.`
      : undefined;

  // Playbook configurable (Anexo Técnico §B-Task 8): el del agente del segmento manda;
  // si NO hay agente de segmento resuelto, el global activo. Su objective gana sobre la
  // ruta A. Cualquier error aquí cae al fallback de arriba — nunca debe impedir que el
  // bot responda.
  //
  // FIX 2026-09-21 (hallazgo de Luis): antes, `agentPlaybook ?? (global)` caía al
  // playbook global en cuanto el agente del segmento no traía uno propio — así "Agente
  // Clientes Actuales" (playbookId null, a propósito: su identidad dice "NUNCA lo
  // vuelvas a calificar") terminaba recibiendo el objective de "Calificación base" (las
  // 5 preguntas de comprador), que le ganaba a su propia identidad en el prompt
  // compuesto. El fallback al global solo debe aplicar cuando NO hay ningún agente de
  // segmento resuelto para el contacto (LEAD/PROSPECTO sin clasificar) — si sí hay
  // agente pero decidió no traer playbook, eso es intencional y se respeta.
  //
  // Con marca (2026-10-09): manda el playbook de la marca (brand.playbookId); una marca sin
  // playbook propio NO hereda el global (sus preguntas de calificación son de Propyte).
  const agentPlaybook = agentPlaybookOf(agentProfile);
  const brandPlaybookId = brand?.playbookId ?? null;
  const useGlobalPlaybook = !brand && !agentProfile && !!config.activePlaybookId;
  let playbookObjective: string | undefined;
  // #989: el guion de la marca terminó en este turno → al final, la conversación pasa al asesor.
  let brandPlaybookDone = false;
  if (agentPlaybook || useGlobalPlaybook || brandPlaybookId) {
    try {
      const pb = agentPlaybook
        ?? (await prisma.botPlaybook.findFirst({
          where: { id: (brandPlaybookId ?? config.activePlaybookId)!, isActive: true, deletedAt: null },
          include: { tasks: { where: { isActive: true }, orderBy: { order: "asc" } } },
        }));
      if (pb && pb.tasks.length > 0) {
        const pr = await runPlaybookStep(prisma, {
          playbook: { id: pb.id, tasks: pb.tasks as any },
          conversationId: conv.id,
          contact,
          messages: history,
          model: config.model,
          // Con marca, el estado de OTRO playbook en este hilo (p. ej. el global, que corrió antes
          // de asignarle la marca a la cuenta) no cuenta como avance de este: se reinicia para el
          // playbook de la marca (mismo criterio que AI_DRAFT). Sin marca: argumentos de siempre.
          ...(brand ? { ignoreForeignState: true } : {}),
        });
        if (pr.objective) playbookObjective = pr.objective;
        if (brand && pr.recienCompletado) {
          brandPlaybookDone = true;
          playbookObjective = brandCompletionObjective(brand.name);
        }
        // Reclutamiento (spec 2026-11-02): al terminar el guion se evalúa al candidato y el
        // cierre reemplaza al objetivo genérico; mientras sigue, se suma la ficha de la vacante.
        // Solo con el guion nuevo (tiene actitud_3): si el playbook sembrado sigue siendo el viejo
        // (puesto/experiencia/ciudad/correo), evaluar daría NO_APTO sin ninguna respuesta.
        const guionNuevo = pb.tasks.some((t: { key: string }) => t.key === "actitud_3");
        if (!brand && guionNuevo && esAgenteReclutamiento(agentProfile)) {
          const hr = await hookReclutamiento({
            contact,
            conversationId: conv.id,
            channel,
            model: config.model,
            messages: history,
            playbook: { status: pr.status },
          });
          // Tras el cierre llegan los dos: el cierre manda y la ficha va detrás (preguntas por la empresa).
          if (hr.objetivo) playbookObjective = hr.contexto ? `${hr.objetivo}\n\n${hr.contexto}` : hr.objetivo;
          else if (hr.contexto) {
            // También cuando el paso del playbook no dio objetivo (su catch defensivo): sin las
            // reglas del guion el modelo cerraba la charla por su cuenta (prueba 2026-11-03).
            const base = playbookObjective ?? fallbackObjective ?? OBJETIVO_SIN_PASO;
            playbookObjective = `${base}\n\n${hr.contexto}`;
          }
        }
      }
    } catch {
      // defensivo: cae al objective de la ruta A
    }
  }

  // La identidad del agente antecede al objetivo del playbook/ruta A en la capa "objetivo"
  const baseObjective = playbookObjective ?? fallbackObjective;
  const objective = composeObjective(agentProfile?.identity, baseObjective);

  // Spread condicional: sin marca los argumentos son idénticos a los de siempre
  // (`brand` ausente, no `brand: undefined`) y el prompt no cambia ni un byte.
  const brandPrompt: BrandPromptInput | undefined = brand
    ? { name: brand.name, persona: brand.persona, knowledge: brand.knowledge, slug: brand.slug }
    : undefined;
  const system = buildSystemPrompt({
    config: effectiveConfig,
    // phone/email (#989): el prompt dice qué datos ya tenemos, para que pida el WhatsApp si falta
    // (Instagram/Messenger) y no lo vuelva a pedir si ya está (formularios, WhatsApp).
    contact: {
      firstName: contact.firstName,
      preferredLanguage: contact.preferredLanguage,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
    },
    catalog,
    objective,
    ...(brandPrompt ? { brand: brandPrompt } : {}),
  });

  // El diagnóstico dice por qué no hubo texto (sin llave, respuesta vacía o error de la API).
  // Ante un error se deja la nota y se relanza igual que siempre: quien llamó lo sigue
  // registrando y el flujo no cambia.
  const diagnostico: DiagnosticoClaude = {};
  let reply: string | null;
  try {
    reply = await askClaude({ system, messages: history, maxTokens: maxTokensDeLineas(effectiveConfig.maxLines), model: config.model }, diagnostico);
  } catch (err) {
    await noteSilence(describeAiSilence(diagnostico.sinRespuesta, err));
    throw err;
  }
  if (!reply) {
    await noteSilence(describeAiSilence(diagnostico.sinRespuesta));
    return false;
  }

  // Guard anti-burst (BUG 2026-07-24: texto + 2 PDFs → 3 respuestas): si mientras
  // generábamos llegó CUALQUIER mensaje nuevo (inbound del cliente, respuesta de otra
  // generación concurrente, o un humano tomando el hilo), se descarta esta respuesta.
  // El trigger del mensaje más nuevo responde con el contexto completo — nada se pierde.
  const newer = await prisma.message.findFirst({
    where: {
      contactId,
      internalNote: false,
      ...(watermark ? { createdAt: { gt: watermark } } : {}),
    },
    select: { id: true },
  });
  if (newer) {
    // #989: el guion de la marca ya quedó COMPLETO en la base; la corrida que conteste el mensaje
    // nuevo ya no lo verá «recién completado» y nadie pasaría el hilo al asesor. Se pasa aquí.
    if (brandPlaybookDone) await escalateToHuman(conv.id, brandHandoffReason(brand!.name));
    return false;
  }

  const shouldEscalateMarketing = reply.includes(ESCALATE_MARKETING_TOKEN);
  const shouldEscalate = reply.includes(ESCALATE_TOKEN);
  // Los dos tokens se quitan SIEMPRE: ninguno debe llegarle al cliente.
  const clean = reply.replaceAll(ESCALATE_MARKETING_TOKEN, "").replaceAll(ESCALATE_TOKEN, "").trim();

  // Brand linter: si bloquea, NO se envía y se escala (mejor humano que hype)
  const lint = lintBrandVoice(clean);
  if (!lint.ok) {
    await escalateToHuman(conv.id, `Linter bloqueó respuesta del bot (${lint.violations.join(", ")})`);
    return false;
  }

  if (!clean) {
    // La respuesta traía solo los tokens: el cliente no recibe nada, aunque el hilo sí pase a
    // un humano. Sin ningún token (solo espacios; askClaude ya recorta, así que no debería
    // pasar) nadie se enteraría → `false`: antes devolvía `true` sin haber enviado nada.
    const escalates = shouldEscalate || shouldEscalateMarketing || brandPlaybookDone;
    await noteSilence(
      `la respuesta de la IA quedó vacía al quitarle las marcas internas (${ESCALATE_TOKEN} / ${ESCALATE_MARKETING_TOKEN})` +
        (escalates ? "; la conversación pasa a un humano." : "."),
    );
    if (!escalates) return false;
  }

  if (clean) {
    // A nombre de quién sale la respuesta (2026-10-12): firmaba el asignado tal cual o «el
    // primer ADMIN activo» sin orden, y así la cronología se llenó de mensajes del bot hechos
    // «por Audit Temp (Claude)» o por `agentes@propyte.local`. Ahora decide el helper común
    // (asesor persona → responsable de la marca de la cuenta del hilo → ADMIN persona más
    // antiguo). Solo cambia la firma: el contacto conserva su `assignedToId` y los avisos no
    // se mueven. `ultimoRecurso`: sin ninguna persona a mano se firma como antes, porque un
    // nombre técnico en la cronología es mejor que un cliente sin respuesta. Por lo mismo,
    // si la lectura de la firma falla se firma con el asignado: la respuesta ya está escrita
    // y no se pierde por un hipo de la base en algo que es cosmético.
    const ownerId = await resolveActorUserId(
      { assignedToId: contact.assignedToId, connectorId: conv.connectorId ?? null },
      { ultimoRecurso: true },
    ).catch((err: unknown) => {
      console.error("[bot-respond] no se pudo resolver la firma; se usa el asesor asignado:", err);
      return contact.assignedToId;
    });
    if (!ownerId) {
      await noteSilence(
        "no hay a nombre de quién enviar la respuesta: el contacto no tiene asesor asignado y no hay ningún usuario ADMIN activo.",
      );
      return false;
    }

    // sendChannelMessage con opts.bot=true marca sender=BOT, aiGenerated=true, aiAutonomy=L2.
    try {
      await sendChannelMessage(channel, contact.id, clean, ownerId, { bot: true, connectorId: conv.connectorId });
    } catch (err) {
      // 2026-10-10: si Meta rechaza el envío (p. ej. otra app es la dueña del
      // hilo), el error moría en el console.error de quien llamó y el bot se
      // quedaba callado sin rastro. Se deja una nota interna con el motivo y se
      // relanza igual: el flujo (qué se manda, cuándo, y que no se escale tras
      // un envío fallido) no cambia.
      // 2026-10-12: también WhatsApp. Era justo el canal que se quedó callado sin
      // rastro; su transporte lanza Error con el código de Meta en el texto y
      // describeBotSendFailure lo reconoce.
      await recordBotSendFailure({ contactId: contact.id, conversationId: conv.id, channel, err });
      throw err;
    }
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() },
    });
  }

  if (shouldEscalateMarketing) {
    // Sin responsable válido (null) escala igual que cualquier otro caso — nunca se pierde.
    // Con marca, primero su responsable de marketing (si está activo); si no, la cadena de siempre.
    await escalateToHuman(conv.id, "Propuesta comercial / de marketing: no busca propiedad", {
      routeToUserId: await getMarketingOwnerId(brand?.marketingOwnerUserId ?? null),
    });
  } else if (shouldEscalate) {
    await escalateToHuman(conv.id, "Intención fuerte detectada por el bot");
  } else if (brandPlaybookDone) {
    await escalateToHuman(conv.id, brandHandoffReason(brand!.name));
  }
  return true;
}

function brandHandoffReason(brandName: string): string {
  return `El bot de ${brandName} ya reunió los datos del cliente (nombre, WhatsApp y lo que busca): falta que un asesor lo contacte para agendar visita o llamada`;
}
