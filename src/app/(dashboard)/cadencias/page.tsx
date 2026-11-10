// Página: /cadencias (#993) — módulo «Cadencias» (Desempeño): el catálogo de secuencias que sigue
// Copilot, la clasificación de respuestas y cuántos contactos van en cada una. Solo ADMIN,
// DIRECTOR y GERENTE (CADENCIAS_ROLES).
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";
import { puedeVerCadencias } from "@/lib/copilot/roles";
import { resumenCadencias, type ResumenModulo } from "@/lib/copilot/cadencias-admin";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import { CLASIFICACIONES, ORDEN_CLASIFICACIONES } from "@/lib/copilot/clasificacion";
import { etiquetaEstado, etiquetaRazon } from "@/lib/estados";
import { MOTIVO_FIN_LABELS } from "@/components/cadencias/textos";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cadencias | Propyte CRM",
};

export default async function CadenciasPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  if (!puedeVerCadencias(session.user.role)) redirect("/hoy");

  let data: ResumenModulo | null = null;
  try {
    data = await resumenCadencias();
  } catch (err) {
    if (!esTablaSinMigrar(err)) throw err;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cadencias</h1>
        <p className="text-[13px] text-muted-foreground">
          Las secuencias de seguimiento que sigue Copilot. Cada asesor ve sus toques en Copilot → Mi día; aquí se definen. Los textos están en
          Mi Configuración → Plantillas → «Copilot (generales)».
        </p>
      </div>

      {!data ? (
        <div className="crm-card text-[13px] text-[color:var(--text-secondary)]">Falta correr la migración de Cadencias (#993).</div>
      ) : (
        <>
          <section className="crm-card">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[14px] font-semibold text-[color:var(--text-primary)]">Clasificación de respuestas</h2>
              <span className="text-[12px] text-[color:var(--text-secondary)]">
                {data.porClasificar} por clasificar
              </span>
            </div>
            <p className="mt-1 text-[12px] text-[color:var(--text-tertiary)]">
              Cuando el lead responde, su cadencia se pausa y el asesor elige uno de estos botones en Mi día (PDF «Cadencias por Rama», R2).
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="text-left text-[color:var(--text-tertiary)]">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Botón</th>
                    <th className="py-1 pr-3 font-medium">El contacto queda en</th>
                    <th className="py-1 pr-3 font-medium">Abre la cadencia</th>
                    <th className="py-1 text-right font-medium">Usado</th>
                  </tr>
                </thead>
                <tbody>
                  {ORDEN_CLASIFICACIONES.map((r) => {
                    const e = CLASIFICACIONES[r];
                    const cad = e.cadencia ? data!.cadencias.find((c) => c.def.tipo === e.cadencia)?.def : null;
                    return (
                      <tr key={r} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                        <td className="py-1.5 pr-3">
                          <span className="font-medium text-[color:var(--text-primary)]">{e.etiqueta}</span>
                          <span className="block text-[color:var(--text-tertiary)]">{e.ayuda}</span>
                        </td>
                        <td className="py-1.5 pr-3 text-[color:var(--text-secondary)]">
                          {e.estado ? `${etiquetaEstado(e.estado)}${e.razon ? ` · ${etiquetaRazon(e.razon)}` : ""}` : "Sigue donde iba"}
                        </td>
                        <td className="py-1.5 pr-3">
                          {cad ? (
                            <Link href={`/cadencias/${cad.tipo}`} className="hover:underline">
                              {cad.nombre}
                            </Link>
                          ) : (
                            <span className="text-[color:var(--text-tertiary)]">{r === "NO_ERA_RESPUESTA" ? "Reanuda la que iba" : "Ninguna"}</span>
                          )}
                        </td>
                        <td className="py-1.5 text-right">{data!.clasificaciones[r] ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {data.cadencias.map(({ def, activas, pausadas, terminadas }) => {
              const totalTerm = Object.values(terminadas).reduce((a, b) => a + b, 0);
              return (
                <Link key={def.tipo} href={`/cadencias/${def.tipo}`} className="crm-card block transition-colors hover:bg-[color:var(--bg-card-hover)]">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[14px] font-semibold text-[color:var(--text-primary)]">{def.nombre}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${def.activa ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"}`}>
                      {def.activa ? "Encendida" : "Apagada"}
                    </span>
                  </div>
                  <p className="text-[12px] text-[color:var(--text-tertiary)]">{def.rama}</p>
                  <p className="mt-1 text-[12px] text-[color:var(--text-secondary)]">{def.descripcion}</p>
                  <p className="mt-2 text-[12px] text-[color:var(--text-secondary)]">
                    {def.pasos.filter((p) => p.activo).length} pasos · {def.finDias} días{def.finAncla === "FECHA_RECONTACTO" ? " después de la fecha" : ""} ·{" "}
                    <strong>{activas}</strong> en curso{pausadas ? ` · ${pausadas} por clasificar` : ""}
                    {totalTerm > 0 && (
                      <>
                        {" "}
                        · terminadas:{" "}
                        {Object.entries(terminadas)
                          .map(([m, n]) => `${MOTIVO_FIN_LABELS[m] ?? m} ${n}`)
                          .join(", ")}
                      </>
                    )}
                  </p>
                </Link>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
