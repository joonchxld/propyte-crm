/**
 * El efecto del aviso de SMTP caído (#839): lo guarda en la campana de los ADMIN que son
 * personas. Texto y causa viven en `fallo-smtp.ts` (puro).
 *
 * A QUIÉN: los ADMIN con `usuarioRuteableWhere()` (activos, no borrados, sin correo `.local`).
 * Son quienes pueden tocar el servidor (el .env del VPS) o pedir que se toque; avisarle a una cuenta técnica sería
 * repetir el silencio con otro nombre.
 *
 * DEDUP: un aviso por administrador mientras tenga uno SIN LEER de este tipo de las últimas
 * horas. Con la clave rechazada falla cada correo, y sin esto la campana se llenaría de copias
 * del mismo problema. Si lo leyó y vuelve a fallar, sí se le avisa otra vez: sigue roto.
 *
 * NUNCA LANZA. Lo llama el mailer cuando un correo ya falló; si el aviso también falla, se
 * queda en el log y el mailer sigue con su error original.
 */
import prisma from "@/lib/db";
import { usuarioRuteableWhere } from "@/lib/workflows/ruteables";
import {
  armarAvisoFalloSmtp,
  causaFalloSmtp,
  detalleSeguro,
  enmascararCorreo,
  TIPO_AVISO_SMTP,
  type CausaFalloSmtp,
  type CorreoQueFallo,
} from "./fallo-smtp";

export const VENTANA_DEDUP_AVISO_SMTP_MS = 6 * 60 * 60 * 1000;

export async function avisarFalloSmtp(input: {
  err: unknown;
  que: CorreoQueFallo;
  destinatario?: string | null;
}): Promise<{ causa: CausaFalloSmtp; avisados: string[] }> {
  const causa = causaFalloSmtp(input.err);
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", ...usuarioRuteableWhere() },
      select: { id: true },
    });
    if (admins.length === 0) {
      console.warn(`[smtp] fallo (${causa}) sin ningún ADMIN que sea persona a quien avisar`);
      return { causa, avisados: [] };
    }

    const ids = admins.map((a) => a.id);
    const ya = await prisma.notification.findMany({
      where: {
        userId: { in: ids },
        type: TIPO_AVISO_SMTP,
        isRead: false,
        createdAt: { gte: new Date(Date.now() - VENTANA_DEDUP_AVISO_SMTP_MS) },
      },
      select: { userId: true },
    });
    const yaAvisados = new Set(ya.map((n) => n.userId));
    const nuevos = ids.filter((id) => !yaAvisados.has(id));
    if (nuevos.length === 0) return { causa, avisados: [] };

    const aviso = armarAvisoFalloSmtp({
      causa,
      que: input.que,
      destinatario: enmascararCorreo(input.destinatario),
      detalle: detalleSeguro(input.err, process.env.SMTP_PASS),
      host: process.env.SMTP_HOST,
    });
    await prisma.notification.createMany({ data: nuevos.map((userId) => ({ userId, ...aviso })) });
    return { causa, avisados: nuevos };
  } catch (e) {
    console.error("[smtp] no se pudo avisar a los administradores del fallo de correo", e);
    return { causa, avisados: [] };
  }
}
