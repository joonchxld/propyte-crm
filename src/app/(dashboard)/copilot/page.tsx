// ============================================================
// Página: /copilot (#947, #988, #993) — «Mi día»: respuestas por clasificar y los toques de las
// cadencias del asesor (las del módulo Cadencias).
// ============================================================
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";
import { miDia, type ClasificacionPendiente } from "@/lib/copilot/cadencia-servicio";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import type { MiDia } from "@/lib/copilot/mi-dia";
import { MiDiaView } from "@/components/copilot/mi-dia-view";
import { CopilotNav } from "@/components/copilot/copilot-nav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Copilot | Propyte CRM",
};

const VACIO: MiDia & { clasificar: ClasificacionPendiente[] } = { tareas: [], fueraDelTope: 0, hechasHoy: [], vencidas: 0, clasificar: [] };

export default async function CopilotPage() {
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

  return (
    <div className="mx-auto max-w-4xl">
      <CopilotNav actual="mi-dia" role={session.user.role} />
      <MiDiaView data={JSON.parse(JSON.stringify(data))} userId={session.user.id} sinMigrar={sinMigrar} />
    </div>
  );
}
