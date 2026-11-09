/**
 * Qué falló cuando un correo del CRM no salió, y qué decirle al administrador (#839).
 *
 * EL FALLO. El 2026-10-07 Gmail empezó a rechazar el usuario y la clave del SMTP del CRM
 * (`535-5.7.8 BadCredentials`). Desde ese minuto no salió NINGÚN correo del sistema —ni el
 * código para restablecer la contraseña, ni el de acceso, ni la solicitud de acceso— y el
 * único rastro era una línea en el log del servidor. Nadie se enteró hasta que una persona se
 * quedó atorada en «¿Olvidaste tu contraseña?» con un «Error al procesar la solicitud».
 *
 * Este archivo es PURO (sin base, sin red): decide la causa a partir del error de nodemailer
 * y arma el texto del aviso. El efecto —guardarlo en la campana de los administradores— vive
 * en `avisar-fallo-smtp.ts`.
 *
 * LO QUE NO HACE: no reintenta ni cambia de proveedor. Una clave rechazada no se arregla
 * reintentando; se arregla poniendo una clave nueva en el servidor, y eso lo hace una persona.
 */

export type CausaFalloSmtp = "credenciales" | "no_configurado" | "conexion" | "otro";

/** Qué correo se intentaba mandar. Solo cambia el texto del aviso. */
export type CorreoQueFallo = "restablecer_contrasena" | "codigo_acceso" | "solicitud_acceso" | "automatizacion";

export const TIPO_AVISO_SMTP = "smtp_fallo";

/** Lo que el mailer lanza cuando no salió el correo. */
export const MENSAJE_SMTP_NO_CONFIGURADO = "SMTP no configurado (SMTP_HOST/USER/PASS)";

const CODIGOS_CONEXION = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]);

function campo(err: unknown, nombre: string): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[nombre] : undefined;
}

function mensajeDe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

/**
 * La causa, mirando primero los campos que nodemailer rellena (`code`, `responseCode`) y solo
 * después el texto, que cambia de un proveedor a otro.
 */
export function causaFalloSmtp(err: unknown): CausaFalloSmtp {
  const mensaje = mensajeDe(err);
  if (mensaje.includes(MENSAJE_SMTP_NO_CONFIGURADO)) return "no_configurado";

  const code = campo(err, "code");
  const responseCode = Number(campo(err, "responseCode"));
  // 535: credenciales rechazadas (Gmail lo acompaña de 5.7.8 BadCredentials). 534: Google pide
  // clave de aplicación o iniciar sesión en el navegador. Las dos se arreglan con una clave nueva.
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534 || /\b53[45][ -]5\.7\.\d/.test(mensaje)) {
    return "credenciales";
  }
  if (typeof code === "string" && CODIGOS_CONEXION.has(code)) return "conexion";
  return "otro";
}

/**
 * Primer renglón del error, recortado y sin la clave. Nodemailer no incluye la clave en sus
 * mensajes, pero el aviso se guarda en la base y lo leen personas: si algún día un proveedor
 * la repitiera, aquí se tacha.
 */
export function detalleSeguro(err: unknown, clave: string | undefined): string {
  let texto = mensajeDe(err).split("\n")[0].trim();
  if (clave && clave.length >= 4) texto = texto.split(clave).join("***");
  return texto.length > 160 ? `${texto.slice(0, 157)}...` : texto;
}

/** `fernanda@propyte.com` → `fe***@propyte.com`. Basta para que el administrador sepa a quién ayudar. */
export function enmascararCorreo(correo: string | null | undefined): string | null {
  if (!correo) return null;
  const [local, dominio] = correo.trim().split("@");
  if (!dominio) return null;
  return `${local.slice(0, 2)}***@${dominio}`;
}

const QUE_SE_INTENTABA: Record<CorreoQueFallo, string> = {
  restablecer_contrasena: "el código para restablecer la contraseña",
  codigo_acceso: "el código de acceso",
  solicitud_acceso: "la solicitud de acceso al CRM",
  automatizacion: "un correo de automatización",
};

export function armarAvisoFalloSmtp(input: {
  causa: CausaFalloSmtp;
  que: CorreoQueFallo;
  destinatario: string | null;
  detalle: string;
  host: string | undefined;
}): { title: string; message: string; type: string } {
  const servidor = input.host || "el servidor de correo";
  const causa = (() => {
    switch (input.causa) {
      case "credenciales":
        return (
          `${servidor} rechazó el usuario y la clave configurados. Hay que generar una clave de ` +
          `aplicación nueva en esa cuenta de Google, ponerla en SMTP_PASS del .env del VPS ` +
          `(/opt/propyte/crm/shared/.env) y redesplegar el CRM con deploy.sh.`
        );
      case "no_configurado":
        return "Faltan SMTP_HOST, SMTP_USER o SMTP_PASS en las variables del servidor (/opt/propyte/crm/shared/.env en el VPS).";
      case "conexion":
        return `No se pudo conectar con ${servidor}. Puede ser una caída momentánea, o el host o el puerto (SMTP_PORT) están mal.`;
      case "otro":
        return `${servidor} devolvió un error: ${input.detalle}`;
    }
  })();
  const para = input.destinatario ? ` para ${input.destinatario}` : "";
  return {
    title: "Los correos del CRM no están saliendo",
    message: `No salió ${QUE_SE_INTENTABA[input.que]}${para}. ${causa} Mientras siga así, tampoco salen los demás correos del sistema.`,
    type: TIPO_AVISO_SMTP,
  };
}
