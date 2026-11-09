// Configuración personal del usuario (Anexo B §J.5)
import { getServerSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import prisma from "@/lib/db";
import { SettingsView } from "@/components/settings/settings-view";
import { MiWhatsApp } from "@/components/settings/mi-whatsapp";
import { EditorPlantillas } from "@/components/copilot/editor-plantillas";
import { puedeEditarPlantillas } from "@/lib/copilot/roles";
import { esTablaSinMigrar } from "@/lib/copilot/sin-migrar";
import { embeddedSignupAvailability } from "@/lib/whatsapp/coex/public-config";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login");

  // Plantillas de la cadencia del Copilot (#988): son generales (las mismas para todo el equipo).
  // Antes vivían en /copilot/plantillas; ahora son una sección de Mi Configuración → Plantillas.
  let plantillasCopilot: Awaited<ReturnType<typeof prisma.copilotPlantilla.findMany>> = [];
  let copilotSinMigrar = false;
  try {
    plantillasCopilot = await prisma.copilotPlantilla.findMany({ orderBy: [{ orden: "asc" }, { variante: "asc" }, { idioma: "desc" }] });
  } catch (err) {
    if (!esTablaSinMigrar(err)) throw err;
    copilotSinMigrar = true;
  }

  const seccionCopilot = copilotSinMigrar ? (
    <div className="crm-card text-[13px] text-[color:var(--text-secondary)]">Falta correr la migración de «Mi día» (#988).</div>
  ) : (
    <EditorPlantillas
      plantillas={JSON.parse(JSON.stringify(plantillasCopilot))}
      editable={puedeEditarPlantillas(session.user.role)}
    />
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mi Configuración</h1>
        <p className="text-muted-foreground">Perfil, correo, tarjeta digital y plantillas</p>
      </div>
      <SettingsView plantillasCopilot={seccionCopilot} />
      {/* 2026-10-14: «Conectar mi WhatsApp» (coexistencia). La disponibilidad se lee en cada
          petición, no en el build: ver lib/whatsapp/coex/public-config.ts. */}
      <MiWhatsApp availability={embeddedSignupAvailability()} />
    </div>
  );
}
