// TwiML de ENTRADA: rutea la llamada entrante al Client del asesor asignado;
// si no hay asesor / no contesta → buzón grabado. Auto-log Activity(CALL_INBOUND).
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateTwilioSignature } from "@/lib/twilio/client";
import { findContactByPhone } from "@/lib/twilio/utils";
import { destinatariosHiloSinDueno } from "@/lib/messaging/aviso-sin-dueno";
import {
  buzonTwiml,
  clientesTwiml,
  envolverRespuesta,
  escapeXml,
  parametrosLlamanteTwiml,
} from "@/lib/twilio/twiml-voz";

/** Máximo de navegadores que suenan a la vez cuando el contacto no tiene asesor. */
const MAX_DESTINATARIOS_SIN_ASESOR = 5;

/**
 * Contacto sin asesor: suena al responsable (marca de su última conversación → gerencia de
 * su plaza → administradores), la misma cadena de los hilos sin dueño. No asigna nada.
 * Nunca lanza: si falla, la llamada va a buzón como antes.
 */
async function destinatariosSinAsesor(contactId: string): Promise<string[]> {
  try {
    const [c, conv] = await Promise.all([
      prisma.contact.findUnique({ where: { id: contactId }, select: { targetPlaza: true } }),
      prisma.conversation.findFirst({
        where: { contactId, connectorId: { not: null } },
        orderBy: { lastMessageAt: "desc" },
        select: { connectorId: true },
      }),
    ]);
    const r = await destinatariosHiloSinDueno({
      connectorId: conv?.connectorId ?? null,
      plaza: c?.targetPlaza ?? null,
    });
    return r.userIds.slice(0, MAX_DESTINATARIOS_SIN_ASESOR);
  } catch (e) {
    console.error("[voice/incoming] no se pudo resolver al responsable:", e);
    return [];
  }
}

function xml(body: string) {
  return new NextResponse(envolverRespuesta(body), { headers: { "Content-Type": "text/xml" } });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => (params[k] = v.toString()));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (
    !(await validateTwilioSignature(
      `${appUrl}/api/webhooks/twilio/voice/incoming`,
      params
    ))
  ) {
    return new NextResponse("Firma inválida", { status: 403 });
  }

  const from = params.From ?? "";

  // Tipo reducido para evitar conflicto entre el tipo completo de Prisma y el
  // objeto parcial que construimos tras captureLead.
  let contact: { id: string; assignedToId: string | null; nombre: string; esNuevo: boolean } | null = null;

  const found = await findContactByPhone(from);
  if (found) {
    contact = {
      id: found.id,
      assignedToId: found.assignedToId,
      nombre: [found.firstName, found.lastName].filter(Boolean).join(" ").trim(),
      esNuevo: false,
    };
  } else {
    const { captureLead } = await import("@/lib/intake/capture-lead");
    const r = await captureLead({
      source: "LLAMADA_ENTRANTE",
      firstName: "Llamada",
      lastName: "(entrante)",
      phone: from,
    });
    if (r.contactId) {
      // Recién creado como «Llamada (entrante)»: sin nombre real, el panel muestra «Número nuevo».
      contact = { id: r.contactId, assignedToId: r.assignedToId, nombre: "", esNuevo: r.isNew };
    } else {
      // #892: antes este fallo no dejaba rastro (la llamada se iba al buzón sin contacto).
      // Sin el teléfono en el log (dato personal): el CallSid basta para encontrarla en Twilio.
      console.error(`[voice/incoming] no se pudo dar de alta la llamada ${params.CallSid ?? "(sin CallSid)"}:`, r.error);
    }
  }

  // Con asesor suena solo a él; sin asesor, a la vez a los responsables (sin asignar el contacto).
  const sinAsesor = !!contact && !contact.assignedToId;
  const destinatarios = !contact
    ? []
    : contact.assignedToId
      ? [contact.assignedToId]
      : await destinatariosSinAsesor(contact.id);

  if (contact && destinatarios.length > 0 && params.CallSid) {
    await prisma.activity
      .create({
        data: {
          contactId: contact.id,
          userId: destinatarios[0],
          activityType: "CALL_INBOUND",
          subject: "Llamada entrante",
          status: "PENDIENTE",
          callSid: params.CallSid,
        },
      })
      .catch((e: unknown) => {
        if ((e as { code?: string })?.code !== "P2002")
          console.error("[voice/incoming] activity.create:", e);
      });
  } else if (contact && sinAsesor) {
    console.warn(
      `[voice/incoming] llamada entrante sin asesor y sin responsable a quien atribuirla, contacto ${contact.id} — Activity no registrada`
    );
  }

  const recordingCb = escapeXml(`${appUrl}/api/webhooks/twilio/voice/recording`);
  const notice = `<Say language="es-MX">Esta llamada puede ser grabada con fines de calidad.</Say>`;

  if (contact && destinatarios.length > 0) {
    // El navegador NO contesta solo: timbra 20 s y, si nadie contesta o rechazan, Twilio llama
    // a dial-action, que manda la llamada al buzón.
    return xml(
      notice +
        `<Dial timeout="20" record="record-from-answer-dual" recordingStatusCallback="${recordingCb}" recordingStatusCallbackEvent="completed" action="${escapeXml(`${appUrl}/api/webhooks/twilio/voice/dial-action`)}">` +
        clientesTwiml(destinatarios, { contactId: contact.id, nombre: contact.nombre, esNuevo: contact.esNuevo, sinAsesor }) +
        `</Dial>`
    );
  }

  return xml(notice + buzonTwiml(appUrl));
}
