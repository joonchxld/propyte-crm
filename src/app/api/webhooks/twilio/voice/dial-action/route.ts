// Tras el <Dial> de una entrante: si el asesor contestó, cuelga limpio;
// si no contestó o rechazó (no-answer/busy/failed/canceled), envía a buzón grabado.
import { NextRequest, NextResponse } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio/client";
import { envolverRespuesta, twimlTrasDial } from "@/lib/twilio/twiml-voz";
import { handleCallStatus } from "@/lib/twilio/voice";

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
      `${appUrl}/api/webhooks/twilio/voice/dial-action`,
      params
    ))
  ) {
    return new NextResponse("Firma inválida", { status: 403 });
  }

  // Cierra la actividad «Llamada entrante» (creada en incoming con el CallSid PADRE, que es el que
  // llega aquí) igual que dial-action-outbound: estado, duración y resultado. Antes se quedaba
  // PENDIENTE para siempre (prueba en vivo 2026-11-09: 3 entrantes sin cerrar). «canceled» (el
  // llamante colgó mientras timbraba) cuenta como no contestada. Un fallo aquí no debe impedir
  // que la llamada llegue al buzón.
  if (params.CallSid && params.DialCallStatus) {
    const estado = params.DialCallStatus === "canceled" ? "no-answer" : params.DialCallStatus;
    await handleCallStatus({
      CallSid: params.CallSid,
      CallStatus: estado,
      CallDuration: params.DialCallDuration,
      From: "",
      To: "",
    }).catch((e: unknown) => console.error("[voice/dial-action] no se pudo cerrar la actividad:", e));
  }

  // contestada → colgar; no-answer/busy/failed/canceled (incl. rechazo del asesor) → buzón.
  return xml(twimlTrasDial(params.DialCallStatus, appUrl));
}
