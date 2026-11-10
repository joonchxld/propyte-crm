// #993 — PATCH /api/cadencias/:tipo — módulo Cadencias: nombre, descripción, plazo y encendido.
// Solo ADMIN, DIRECTOR y GERENTE (CADENCIAS_ROLES).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/session";
import { puedeVerCadencias } from "@/lib/copilot/roles";
import { actualizarCadencia } from "@/lib/copilot/cadencias-admin";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";

const cuerpoSchema = z.object({
  nombre: z.string().max(80).optional(),
  descripcion: z.string().max(1000).optional(),
  activa: z.boolean().optional(),
  finDias: z.number().int().optional(),
});

export async function PATCH(req: NextRequest, props: { params: Promise<{ tipo: string }> }) {
  const { tipo } = await props.params;
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!puedeVerCadencias(session.user.role)) return NextResponse.json({ error: "Solo administración, dirección y gerencia" }, { status: 403 });
  const parsed = cuerpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    const r = await actualizarCadencia(tipo, parsed.data, session.user.id);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ data: r.data });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Falta correr la migración de Cadencias (#993)" }, { status: 503 });
    console.error("[cadencias] actualizar:", err);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}
