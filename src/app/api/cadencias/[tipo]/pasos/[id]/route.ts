// #993 — PATCH / DELETE /api/cadencias/:tipo/pasos/:id — editar o quitar un paso (módulo Cadencias).
// Los toques que ya se crearon no cambian; el cambio aplica a los que faltan.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth/session";
import { puedeVerCadencias } from "@/lib/copilot/roles";
import { actualizarPaso, borrarPaso } from "@/lib/copilot/cadencias-admin";
import { pasoSchema } from "@/lib/copilot/paso-schema";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";

type Props = { params: Promise<{ tipo: string; id: string }> };

async function sesionConPermiso() {
  const session = await getServerSession();
  if (!session?.user) return { error: NextResponse.json({ error: "No autorizado" }, { status: 401 }) };
  if (!puedeVerCadencias(session.user.role)) return { error: NextResponse.json({ error: "Solo administración, dirección y gerencia" }, { status: 403 }) };
  return { session };
}

export async function PATCH(req: NextRequest, props: Props) {
  const { tipo, id } = await props.params;
  const s = await sesionConPermiso();
  if (s.error) return s.error;
  const parsed = pasoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  try {
    const r = await actualizarPaso(tipo, id, parsed.data, s.session.user.id);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ data: r.data });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Falta correr la migración de Cadencias (#993)" }, { status: 503 });
    console.error("[cadencias] editar paso:", err);
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, props: Props) {
  const { tipo, id } = await props.params;
  const s = await sesionConPermiso();
  if (s.error) return s.error;
  try {
    const r = await borrarPaso(tipo, id);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (esTablaSinMigrar(err)) return NextResponse.json({ error: "Falta correr la migración de Cadencias (#993)" }, { status: 503 });
    console.error("[cadencias] quitar paso:", err);
    return NextResponse.json({ error: "No se pudo quitar" }, { status: 500 });
  }
}
