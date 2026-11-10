// Página: /cadencias/:tipo (#993) — una cadencia: cómo funciona, sus pasos (editables) y los
// contactos que van en ella. Solo ADMIN, DIRECTOR y GERENTE.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";
import { puedeVerCadencias } from "@/lib/copilot/roles";
import { cargarCatalogo, codigosDePlantillas } from "@/lib/copilot/catalogo";
import { contactosEnCadencia } from "@/lib/copilot/cadencias-admin";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import { etiquetaEstado, etiquetaRazon } from "@/lib/estados";
import { EditorCadencia } from "@/components/cadencias/editor-cadencia";
import { ANCLA_LABELS } from "@/components/cadencias/textos";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cadencia | Propyte CRM",
};

export default async function CadenciaPage(props: { params: Promise<{ tipo: string }> }) {
  const { tipo } = await props.params;
  const session = await getServerSession();
  if (!session?.user) redirect("/login");
  if (!puedeVerCadencias(session.user.role)) redirect("/hoy");

  let catalogo;
  try {
    catalogo = await cargarCatalogo();
  } catch (err) {
    if (esTablaSinMigrar(err)) redirect("/cadencias");
    throw err;
  }
  const def = catalogo.get(tipo);
  if (!def) notFound();
  const [plantillas, contactos] = await Promise.all([codigosDePlantillas(), contactosEnCadencia(tipo)]);
  const siguiente = def.fin.siguiente ? catalogo.get(def.fin.siguiente) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <Link href="/cadencias" className="text-[12px] text-[color:var(--text-secondary)] hover:underline">
          ← Cadencias
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{def.nombre}</h1>
        <p className="text-[13px] text-muted-foreground">
          {def.rama} · <code className="text-[12px]">{def.tipo}</code>
        </p>
      </div>

      <div className="crm-card grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
        <div>
          <p className="text-[color:var(--text-tertiary)]">Entra</p>
          <p className="text-[color:var(--text-primary)]">{def.disparador}</p>
        </div>
        <div>
          <p className="text-[color:var(--text-tertiary)]">Se cuenta desde</p>
          <p className="text-[color:var(--text-primary)]">{ANCLA_LABELS[def.anclaTipo] ?? def.anclaTipo}</p>
        </div>
        <div>
          <p className="text-[color:var(--text-tertiary)]">Sigue viva mientras el contacto esté en</p>
          <p className="text-[color:var(--text-primary)]">{def.estados.map((e) => etiquetaEstado(e)).join(", ")}</p>
        </div>
        <div>
          <p className="text-[color:var(--text-tertiary)]">Se detiene</p>
          <p className="text-[color:var(--text-primary)]">
            {[
              def.respuestaTermina ? "cuando el lead responde (y se clasifica)" : null,
              def.terminaConCita ? "cuando se agenda una cita" : null,
              `al cumplir ${def.finDias} días${def.finAncla === "FECHA_RECONTACTO" ? " después de la fecha de recontacto" : ""}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="sm:col-span-2">
          <p className="text-[color:var(--text-tertiary)]">Al cumplir el plazo</p>
          <p className="text-[color:var(--text-primary)]">
            {def.fin.estado ? `El contacto pasa a ${etiquetaEstado(def.fin.estado)}${def.fin.razon ? ` · ${etiquetaRazon(def.fin.razon)}` : ""}` : "El contacto se queda en su estado"}
            {siguiente ? (
              <>
                {" "}
                y entra a{" "}
                <Link href={`/cadencias/${siguiente.tipo}`} className="underline">
                  {siguiente.nombre}
                </Link>
                .
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      </div>

      <EditorCadencia
        cadencia={JSON.parse(
          JSON.stringify({
            tipo: def.tipo,
            nombre: def.nombre,
            descripcion: def.descripcion,
            activa: def.activa,
            finDias: def.finDias,
            finAncla: def.finAncla,
            pasos: def.pasos,
          }),
        )}
        plantillas={[...plantillas].filter((c) => c !== "LINEA_VALOR" && c !== "CIFRA").sort()}
      />

      <div className="crm-card">
        <h2 className="text-[14px] font-semibold text-[color:var(--text-primary)]">Contactos en esta cadencia ({contactos.length})</h2>
        {contactos.length === 0 ? (
          <p className="mt-1 text-[12px] text-[color:var(--text-tertiary)]">Nadie va en esta cadencia ahora.</p>
        ) : (
          <table className="mt-2 w-full text-[12px]">
            <thead className="text-left text-[color:var(--text-tertiary)]">
              <tr>
                <th className="py-1 pr-3 font-medium">Contacto</th>
                <th className="py-1 pr-3 font-medium">Asesor</th>
                <th className="py-1 pr-3 font-medium">Desde</th>
                <th className="py-1 pr-3 text-right font-medium">Pendientes</th>
                <th className="py-1 text-right font-medium">Vencidos</th>
              </tr>
            </thead>
            <tbody>
              {contactos.map((c) => (
                <tr key={c.contactId} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                  <td className="py-1.5 pr-3">
                    <Link href={`/contacts/${c.contactId}`} className="hover:underline">
                      {c.nombre}
                    </Link>
                    {c.estado === "PAUSADA" && <span className="ml-1 text-sky-700">· por clasificar</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-[color:var(--text-secondary)]">{c.asesor ?? "Sin asesor"}</td>
                  <td className="py-1.5 pr-3 text-[color:var(--text-secondary)]">
                    {new Date(c.desde).toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "America/Cancun" })}
                  </td>
                  <td className="py-1.5 pr-3 text-right">{c.pendientes}</td>
                  <td className={`py-1.5 text-right ${c.vencidos > 0 ? "text-red-600" : ""}`}>{c.vencidos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
