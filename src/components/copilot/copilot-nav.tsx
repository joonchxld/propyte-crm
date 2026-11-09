// #988 — Pestañas del módulo Copilot: Mi día · Vencidas.
// Las plantillas se movieron a Mi Configuración → Plantillas → «Copilot (generales)».
import Link from "next/link";
import { puedeVerVencidas } from "@/lib/copilot/roles";

export function CopilotNav({ actual, role }: { actual: "mi-dia" | "vencidas"; role: string }) {
  const pestañas = [
    { clave: "mi-dia", href: "/copilot", texto: "Mi día" },
    ...(puedeVerVencidas(role) ? [{ clave: "vencidas", href: "/copilot/vencidas", texto: "Vencidas por asesor" }] : []),
  ];
  return (
    <nav className="mb-4 flex gap-1 border-b" style={{ borderColor: "var(--border-subtle)" }} aria-label="Copilot">
      {pestañas.map((p) => (
        <Link
          key={p.clave}
          href={p.href}
          aria-current={p.clave === actual ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
            p.clave === actual
              ? "border-[color:var(--text-primary)] font-semibold text-[color:var(--text-primary)]"
              : "border-transparent text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
          }`}
        >
          {p.texto}
        </Link>
      ))}
    </nav>
  );
}
