// Servicio de SMS via Twilio — envío y recepción
import { prisma } from "@/lib/db";
import { getTwilioClient } from "./client";
import { findContactByPhone, normalizePhone } from "./utils";

/**
 * Envía un SMS a un contacto y registra el mensaje + actividad.
 */
export async function sendSMS(
  to: string,
  body: string,
  contactId: string,
  userId: string
) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_PHONE_NUMBER;
  // Messaging Service de Twilio: su Sender Pool incluye el Alpha Sender "Propyte" y el
  // número. Twilio elige el remitente por país del destinatario: donde se soporta Sender
  // ID alfanumérico el cliente ve "Propyte"; en el resto (p. ej. EE. UU./Canadá) usa el
  // número del pool. Si no está configurado, se conserva el comportamiento anterior.
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!messagingServiceSid && !from) {
    throw new Error("Configura TWILIO_MESSAGING_SERVICE_SID o TWILIO_PHONE_NUMBER");
  }

  const normalized = normalizePhone(to);

  // Enviar via Twilio
  const twilioMsg = await client.messages.create({
    body,
    to: normalized,
    ...(messagingServiceSid ? { messagingServiceSid } : { from: from as string }),
  });

  // Crear registro de mensaje
  const message = await prisma.message.create({
    data: {
      contactId,
      userId,
      channel: "SMS",
      direction: "OUTBOUND",
      body,
      twilioSid: twilioMsg.sid,
      status: "SENT",
      externalPhone: normalized,
    },
  });

  // Crear actividad asociada
  await prisma.activity.create({
    data: {
      contactId,
      userId,
      activityType: "SMS_OUT",
      subject: `SMS enviado`,
      description: body.length > 100 ? body.substring(0, 100) + "..." : body,
      status: "COMPLETADA",
      completedAt: new Date(),
    },
  });

  // #731: un SMS al contacto es un toque saliente real, así que detiene su reloj de SLA
  // igual que el dispatcher. Sin esto, contestar por SMS dejaba el FIRST_TOUCH corriendo
  // hasta vencerse y el CRM registraba un incumplimiento donde sí hubo respuesta.
  const { meetSlaTimers } = await import("@/lib/workflows/sla");
  await meetSlaTimers(contactId);

  return message;
}

/**
 * Procesa un SMS entrante desde el webhook de Twilio.
 * Busca el contacto por teléfono y crea el registro.
 */
export async function handleInboundSMS(payload: {
  From: string;
  Body: string;
  MessageSid: string;
  NumMedia?: string;
  MediaUrl0?: string;
}) {
  const contact = await findContactByPhone(payload.From);

  if (!contact) {
    // Registrar como mensaje sin contacto asociado — se puede vincular después
    console.warn(`SMS entrante de número desconocido: ${payload.From}`);
    return null;
  }

  // Crear registro de mensaje
  const message = await prisma.message.create({
    data: {
      contactId: contact.id,
      userId: contact.assignedToId,
      channel: "SMS",
      direction: "INBOUND",
      body: payload.Body,
      twilioSid: payload.MessageSid,
      mediaUrl: payload.MediaUrl0 || null,
      status: "DELIVERED",
      externalPhone: normalizePhone(payload.From),
    },
  });

  // Crear actividad — best-effort: Activity.userId es NOT NULL (FK a users); el viejo
  // fallback `contact.id` era una FK violada garantizada con contacto sin asignar
  // (misma clase del BUG 2026-07-24 en core.ts) y mataba la ingesta del SMS.
  try {
    const activityUserId =
      contact.assignedToId ??
      (await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true }, select: { id: true } }))?.id;
    if (activityUserId) {
      await prisma.activity.create({
        data: {
          contactId: contact.id,
          userId: activityUserId,
          activityType: "SMS_IN",
          subject: `SMS recibido de ${contact.firstName} ${contact.lastName}`,
          description: payload.Body.length > 100
            ? payload.Body.substring(0, 100) + "..."
            : payload.Body,
          status: "COMPLETADA",
          completedAt: new Date(),
        },
      });
    }
  } catch (err) {
    console.error("[twilio-sms] activity inbound falló:", err);
  }

  // Notificar al asesor asignado
  if (contact.assignedToId) {
    await prisma.notification.create({
      data: {
        userId: contact.assignedToId,
        title: "SMS recibido",
        message: `${contact.firstName} ${contact.lastName}: ${payload.Body.substring(0, 80)}`,
        type: "sms_inbound",
        link: `/dashboard/contacts/${contact.id}`,
      },
    });
  }

  return message;
}
