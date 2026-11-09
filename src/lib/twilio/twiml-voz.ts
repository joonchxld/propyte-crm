// Piezas de TwiML compartidas por los webhooks de voz entrante (incoming y dial-action).

/** Escapa texto para usarlo en contenido o atributos XML. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Envuelve el cuerpo en <Response>. */
export function envolverRespuesta(cuerpo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${cuerpo}</Response>`;
}

/** Buzón de voz: mensaje + grabación (la transcripción/guardado lo hace el webhook /recording). */
export function buzonTwiml(appUrl: string): string {
  const recordingCb = escapeXml(`${appUrl}/api/webhooks/twilio/voice/recording`);
  return (
    `<Say language="es-MX">En este momento no podemos atenderte. Deja tu mensaje después del tono.</Say>` +
    `<Record maxLength="120" recordingStatusCallback="${recordingCb}" />`
  );
}

/** Datos del llamante que viajan al navegador como <Parameter> dentro de <Client>. */
export interface DatosLlamante {
  contactId: string;
  nombre: string;
  esNuevo: boolean;
}

export function parametrosLlamanteTwiml(d: DatosLlamante): string {
  return (
    `<Parameter name="contactId" value="${escapeXml(d.contactId)}" />` +
    `<Parameter name="nombre" value="${escapeXml(d.nombre)}" />` +
    `<Parameter name="esNuevo" value="${d.esNuevo ? "1" : "0"}" />`
  );
}

/**
 * Qué hacer cuando termina el <Dial> hacia el asesor.
 * - completed / answered: el asesor contestó y la llamada ya terminó → colgar.
 * - no-answer / busy / failed / canceled (y cualquier otro): buzón.
 *   Según la documentación de Twilio, si el <Client> rechaza la llamada (call.reject()) el
 *   Dial termina con DialCallStatus busy (o no-answer); ambos van a buzón.
 */
export function twimlTrasDial(dialCallStatus: string | undefined, appUrl: string): string {
  if (dialCallStatus === "completed" || dialCallStatus === "answered") {
    return `<Hangup/>`;
  }
  return buzonTwiml(appUrl);
}
