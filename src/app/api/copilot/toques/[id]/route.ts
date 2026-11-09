// #988 — PATCH /api/copilot/toques/:id — el asesor marca (o desmarca) el resultado de un toque.
//   { resultado: "ENVIADO" | "CONTESTO" | … | null, variante?: string | null }
// Contestó o Respondió pausan la cadencia y dejan la tarea «Clasificar respuesta» (#993)
// (lib/copilot/cadencia-servicio.ts → marcarResultado).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { getServerSession } from "@/lib/auth/session";
import { getContactAccessInfo } from "@/server/contacts";
import { marcarResultado } from "@/lib/copilot/cadencia-servicio";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";

const cuerpoSchema = z.object({
  resultado: z.string().max(40).nullable(),
  variante: z.string().max(40).nullable().optional(),
});

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const parsed = cuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  try {
    const toque = await prisma.copilotToque.findUnique({ where: { id }, select: { contactId: true } });
    if (!toque) return NextResponse.json({ error: "El toque ya no existe (la cadencia pudo haber terminado)" }, { status: 404 });
    const acceso = await getContactAccessInfo(toque.contactId, session as never);
    if (!acceso.ok) {
      return NextResponse.json({ error: "No tienes acceso a este contacto" }, { status: acceso.reason === "not_found" ? 404 : 403 });
    }
    const r = await marcarResultado({
      toqueId: id,
      resultado: parsed.data.resultado,
      variante: parsed.data.variante,
      usuarioId: session.user.id,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, pausada: r.pausada });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Copilot todavía no está instalado (falta la migración)" }, { status: 503 });
    console.error("[copilot] marcar toque:", err);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}
