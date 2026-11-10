// #993 — POST /api/cadencias/:tipo/pasos — agregar un paso a una cadencia (módulo Cadencias).
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { puedeVerCadencias } from "@/lib/copilot/roles";
import { crearPaso } from "@/lib/copilot/cadencias-admin";
import { pasoSchema } from "@/lib/copilot/paso-schema";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";

export async function POST(req: NextRequest, props: { params: Promise<{ tipo: string }> }) {
  const { tipo } = await props.params;
  const session = await getServerSession();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!puedeVerCadencias(session.user.role)) return NextResponse.json({ error: "Solo administración, dirección y gerencia" }, { status: 403 });
  const parsed = pasoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    const r = await crearPaso(tipo, parsed.data, session.user.id);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ data: r.data }, { status: 201 });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Falta correr la migración de Cadencias (#993)" }, { status: 503 });
    console.error("[cadencias] crear paso:", err);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}
