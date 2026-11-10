// #993 — Tarea «Clasificar respuesta» (R2 del PDF «Cadencias por Rama»): el lead respondió y la
// cadencia está en pausa. Cada botón fija estado y razón y abre la cadencia de la rama. Va arriba
// de «Mi día» porque el PDF pide clasificar en menos de 5 min en horario.
"use client";

import { useState } from "react";
import Link from "next/link";
import { MessageSquareReply } from "lucide-react";
import type { ClasificacionPendiente } from "@/lib/copilot/cadencia-servicio";
import { CLASIFICACIONES, DIAS_POSPUSO_POR_DEFECTO, ORDEN_CLASIFICACIONES, type ResultadoClasificacion } from "@/lib/copilot/clasificacion";

function haceCuanto(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}

function enDias(n: number): string {
  const d = new Date(Date.now() - 5 * 3_600_000 + n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function ClasificarRespuesta({
  pendiente,
  onCambio,
  mostrarContacto = true,
  sinMarco = false,
}: {
  pendiente: ClasificacionPendiente;
  onCambio: () => void;
  mostrarContacto?: boolean;
  /** #997: dentro de la carta de Copilot, que ya trae su propio marco. */
  sinMarco?: boolean;
}) {
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pidiendoFecha, setPidiendoFecha] = useState(false);
  const [fecha, setFecha] = useState(enDias(DIAS_POSPUSO_POR_DEFECTO));
  const tarde = Date.now() - new Date(pendiente.respuestaAt).getTime() > 5 * 60_000;

  async function enviar(resultado: ResultadoClasificacion, fechaRecontacto?: string) {
    setGuardando(true);
    setError(null);
    try {
      const res = await fetch(`/api/copilot/clasificaciones/${pendiente.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultado, ...(fechaRecontacto ? { fechaRecontacto } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(j?.error ?? "No se pudo guardar");
      else onCambio();
    } catch {
      setError("No se pudo guardar (sin conexión)");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className={sinMarco ? "" : "crm-card ring-1 ring-sky-300 dark:ring-sky-900"}>
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareReply className="h-4 w-4 text-sky-600" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-[color:var(--text-primary)]">Clasificar respuesta</span>
        {mostrarContacto && (
          <Link href={`/contacts/${pendiente.contactId}`} className="text-[14px] font-semibold text-[color:var(--text-primary)] hover:underline">
            {pendiente.nombre}
          </Link>
        )}
        <span className={`text-[12px] ${tarde ? "text-red-600" : "text-[color:var(--text-secondary)]"}`}>
          Respondió {haceCuanto(pendiente.respuestaAt)}
        </span>
        {pendiente.cadencia && <span className="text-[12px] text-[color:var(--text-tertiary)]">· {pendiente.cadencia} en pausa</span>}
      </div>
      {pendiente.ultimoMensaje && (
        <blockquote className="mt-2 border-l-2 pl-3 text-[13px] text-[color:var(--text-secondary)]" style={{ borderColor: "var(--border-default)" }}>
          {pendiente.ultimoMensaje}
        </blockquote>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {ORDEN_CLASIFICACIONES.map((r) => (
          <button
            key={r}
            type="button"
            disabled={guardando}
            title={CLASIFICACIONES[r].ayuda}
            onClick={() => (r === "AHORA_NO" ? setPidiendoFecha(true) : enviar(r))}
            className={r === "INTERESADO" ? "btn-primary text-[12px]" : "btn-secondary text-[12px]"}
          >
            {CLASIFICACIONES[r].etiqueta}
          </button>
        ))}
      </div>
      {pidiendoFecha && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
          <label htmlFor={`fecha-${pendiente.id}`} className="text-[color:var(--text-secondary)]">
            ¿Cuándo lo retomamos? (sin fecha: {DIAS_POSPUSO_POR_DEFECTO} días)
          </label>
          <input
            id={`fecha-${pendiente.id}`}
            type="date"
            className="form-input w-auto text-[12px]"
            value={fecha}
            min={enDias(1)}
            onChange={(e) => setFecha(e.target.value)}
          />
          <button type="button" className="btn-primary text-[12px]" disabled={guardando} onClick={() => enviar("AHORA_NO", fecha)}>
            Guardar «Ahora no»
          </button>
          <button type="button" className="btn-secondary text-[12px]" onClick={() => setPidiendoFecha(false)}>
            Cancelar
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </div>
  );
}
