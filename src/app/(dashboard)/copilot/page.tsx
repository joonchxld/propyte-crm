// ============================================================
// Página: /copilot (#947, #988, #993, #997) — la actividad que toca ahora, en grande y una a la vez
// (respuestas por clasificar y toques de las cadencias del módulo Cadencias).
// `?vista=lista` conserva la vista anterior de «Mi día», con todo en una lista.
// ============================================================
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";
import { miDia, type ClasificacionPendiente } from "@/lib/copilot/cadencia-servicio";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import type { MiDia } from "@/lib/copilot/mi-dia";
import { MiDiaView } from "@/components/copilot/mi-dia-view";
import { CopilotFoco } from "@/components/copilot/copilot-foco";
import { CopilotNav } from "@/components/copilot/copilot-nav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Copilot | Propyte CRM",
};

const VACIO: MiDia & { clasificar: ClasificacionPendiente[] } = { tareas: [], fueraDelTope: 0, hechasHoy: [], vencidas: 0, clasificar: [] };

export default async function CopilotPage({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  let data: MiDia & { clasificar: ClasificacionPendiente[] } = VACIO;
  let sinMigrar = false;
  try {
    data = await miDia(session.user.id);
  } catch (err) {
    if (!esTablaSinMigrar(err)) throw err;
    sinMigrar = true;
  }

  const enLista = (await searchParams).vista === "lista";
  const plano = JSON.parse(JSON.stringify(data));

  if (enLista) {
    return (
      <div className="mx-auto max-w-4xl">
        <CopilotNav actual="mi-dia" role={session.user.role} />
        <p className="mb-3 text-[12px]">
          <Link href="/copilot" className="text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]">
            ← Volver a una a la vez
          </Link>
        </p>
        <MiDiaView data={plano} userId={session.user.id} sinMigrar={sinMigrar} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <CopilotNav actual="mi-dia" role={session.user.role} />
      <CopilotFoco data={plano} userId={session.user.id} sinMigrar={sinMigrar} />
    </div>
  );
}
