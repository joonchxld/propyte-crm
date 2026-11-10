// Página: /copilot/vencidas (#988) — tablero de tareas de «Mi día» con 24 h o más sin marcar, por
// asesor. Dirección, gerencia y Admin ven a todos; el líder de equipo, a su equipo.
import Link from "next/link";
import { redirect } from "next/navigation";
import prisma from "@/lib/db";
import { getServerSession } from "@/lib/auth/session";
import { resolveActivityScope } from "@/lib/activities/scope";
import { puedeVerVencidas } from "@/lib/copilot/roles";
import { tableroVencidas, type FilaTablero } from "@/lib/copilot/cadencia-servicio";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import { ANCHO_COPILOT, ANCHO_LECTURA, CopilotNav } from "@/components/copilot/copilot-nav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vencidas · Copilot | Propyte CRM",
};

function haceCuanto(iso: string): string {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h >= 48 ? `hace ${Math.floor(h / 24)} días` : `hace ${h} h`;
}

export default async function VencidasPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  if (!puedeVerVencidas(session.user.role)) redirect("/copilot");

  const scope = resolveActivityScope(session.user.role);
  let owners: string[] | undefined;
  if (scope === "TEAM") {
    const equipo = await prisma.user.findMany({ where: { teamLeaderId: session.user.id }, select: { id: true } });
    owners = [session.user.id, ...equipo.map((u) => u.id)];
  } else if (scope !== "ALL") {
    owners = [session.user.id];
  }

  let filas: FilaTablero[] = [];
  let sinMigrar = false;
  try {
    filas = await tableroVencidas(owners);
  } catch (err) {
    if (!esTablaSinMigrar(err)) throw err;
    sinMigrar = true;
  }

  return (
    <div className={ANCHO_COPILOT}>
      <CopilotNav actual="vencidas" role={session.user.role} />
      <div className={ANCHO_LECTURA}>
        <h1 className="mb-1 text-lg font-semibold text-[color:var(--text-primary)]">Vencidas por asesor</h1>
        <p className="mb-4 text-[12px] text-[color:var(--text-tertiary)]">
          Tareas de Copilot con 24 h o más sin marcar. Al vencer se avisa al gerente; no se reasignan.
        </p>
        {sinMigrar ? (
          <div className="crm-card text-[13px] text-[color:var(--text-secondary)]">Falta correr la migración de «Mi día» (#988).</div>
        ) : filas.length === 0 ? (
          <div className="crm-card text-[13px] text-[color:var(--text-secondary)]">No hay tareas vencidas.</div>
        ) : (
          <div className="space-y-3">
            {filas.map((f) => (
              <div key={f.asesorId} className="crm-card">
                <div className="flex items-baseline justify-between">
                  <span className="text-[14px] font-semibold text-[color:var(--text-primary)]">{f.asesor}</span>
                  <span className="text-[13px] text-red-600">
                    {f.tareasVencidas} {f.tareasVencidas === 1 ? "tarea vencida" : "tareas vencidas"}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-[13px]">
                  {f.contactos.map((c) => (
                    <li key={`${c.id}:${c.dia}`} className="flex justify-between gap-2">
                      <Link href={`/contacts/${c.id}`} className="text-[color:var(--text-primary)] hover:underline">
                        {c.nombre}
                      </Link>
                      <span className="text-[color:var(--text-tertiary)]">
                        {c.cadencia} · día {c.dia} · {haceCuanto(c.desde)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
