// #993 — POST /api/copilot/clasificaciones/:id — el asesor clasifica la respuesta del lead (R2).
//   { resultado: "INTERESADO" | "AHORA_NO" | … | "NO_ERA_RESPUESTA", fechaRecontacto?: "AAAA-MM-DD" }
// Fija estado, subestado y razón y abre la cadencia de la rama (lib/copilot/clasificacion.ts).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { getServerSession } from "@/lib/auth/session";
import { getContactAccessInfo } from "@/server/contacts";
import { clasificar } from "@/lib/copilot/cadencia-servicio";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";

const cuerpoSchema = z.object({
  resultado: z.string().max(40),
  fechaRecontacto: z.string().max(10).nullable().optional(),
});

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const parsed = cuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  try {
    const c = await prisma.copilotClasificacion.findUnique({ where: { id }, select: { contactId: true } });
    if (!c) return NextResponse.json({ error: "La clasificación ya no existe" }, { status: 404 });
    const acceso = await getContactAccessInfo(c.contactId, session as never);
    if (!acceso.ok) {
      return NextResponse.json({ error: "No tienes acceso a este contacto" }, { status: acceso.reason === "not_found" ? 404 : 403 });
    }
    const r = await clasificar({
      clasificacionId: id,
      resultado: parsed.data.resultado,
      fechaRecontacto: parsed.data.fechaRecontacto ?? null,
      usuarioId: session.user.id,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, cadencia: r.cadencia });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Falta correr la migración de Cadencias (#993)" }, { status: 503 });
    console.error("[copilot] clasificar:", err);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}
