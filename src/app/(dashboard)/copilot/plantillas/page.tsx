// /copilot/plantillas (#988) se movió a Mi Configuración → Plantillas → «Copilot (generales)».
// Se conserva la ruta para que los enlaces viejos no den 404.
import { redirect } from "next/navigation";

export default function PlantillasCopilotMovidas() {
  redirect("/settings?tab=plantillas&seccion=copilot");
}
