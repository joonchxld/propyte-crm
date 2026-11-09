// Tras el <Dial> de una entrante: si el asesor contestó, cuelga limpio;
// si no contestó o rechazó (no-answer/busy/failed/canceled), envía a buzón grabado.
import { NextRequest, NextResponse } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio/client";
import { envolverRespuesta, twimlTrasDial } from "@/lib/twilio/twiml-voz";

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

  // contestada → colgar; no-answer/busy/failed/canceled (incl. rechazo del asesor) → buzón.
  return xml(twimlTrasDial(params.DialCallStatus, appUrl));
}
