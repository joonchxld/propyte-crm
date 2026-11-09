// #988 / #993 — Sección «Cadencia» de la ficha del contacto. Muestra:
//   - la respuesta por clasificar, si la hay;
//   - en qué cadencia y en qué día va;
//   - los toques de hoy y los atrasados, para marcarlos aquí mismo;
//   - lo hecho, lo que sigue y las cadencias anteriores.
// No se muestra si el contacto nunca tuvo cadencia.
"use client";

import { useCallback, useEffect, useState } from "react";
import type { CadenciaDeContacto } from "@/lib/copilot/cadencia-servicio";
import { CANAL_LABELS, RESULTADO_LABELS, type Canal, type Resultado } from "@/lib/copilot/cadencia-nuevos";
import { TareaDelDia } from "./tarea-del-dia";
import { ClasificarRespuesta } from "./clasificar-respuesta";

export const MOTIVO_FIN: Record<string, string> = {
  RESPONDIO: "el lead respondió y se clasificó",
  SALIO_DEL_ESTADO: "el contacto cambió de estado",
  YA_NO_APLICA: "el contacto ya no lleva cadencia (tipo, flujo o No contactar)",
  SIN_RESPUESTA: "se cumplió el plazo",
  CITA_AGENDADA: "se agendó la cita",
  CAMBIO_RAMA: "pasó a otra cadencia",
};

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short", timeZone: "America/Cancun" });
}

export function CadenciaDelContacto({ contactId, userId, onCambio }: { contactId: string; userId: string; onCambio?: () => void }) {
  const [data, setData] = useState<CadenciaDeContacto | null>(null);
  const [verHistorial, setVerHistorial] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const res = await fetch(`/api/copilot/contactos/${contactId}`);
      if (!res.ok) return setData(null);
      setData((await res.json()).data ?? null);
    } catch {
      setData(null);
    }
  }, [contactId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!data) return null;

  const pendientes = data.tareas.filter((t) => t.pendientes > 0);
  const hechas = data.tareas.filter((t) => t.pendientes === 0);
  const activa = data.estado === "ACTIVA";
  const refrescar = () => {
    void cargar();
    onCambio?.();
  };
  const estadoTexto = activa
    ? `Día ${data.ultimoDia ? Math.min(data.dia, data.ultimoDia) : data.dia}${data.ultimoDia ? ` de ${data.ultimoDia}` : ""}`
    : data.estado === "PAUSADA"
      ? "En pausa: el lead respondió"
      : `Terminó: ${MOTIVO_FIN[data.motivoFin ?? ""] ?? "—"}`;

  return (
    <div className="crm-card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[color:var(--text-primary)]">
          {data.nombre}
          {data.rama && <span className="ml-2 text-[12px] font-normal text-[color:var(--text-tertiary)]">{data.rama}</span>}
        </h3>
        <span className="text-[12px] text-[color:var(--text-secondary)]">{estadoTexto}</span>
      </div>

      {data.clasificar && <ClasificarRespuesta pendiente={data.clasificar} onCambio={refrescar} mostrarContacto={false} />}

      {activa && pendientes.length === 0 && <p className="text-[12px] text-[color:var(--text-tertiary)]">Hoy no hay toques pendientes.</p>}
      {pendientes.map((t) => (
        <TareaDelDia key={t.clave} tarea={t} userId={userId} onCambio={refrescar} mostrarContacto={false} />
      ))}

      {(hechas.length > 0 || data.siguientes.length > 0 || data.historial.length > 0) && (
        <button type="button" className="text-[12px] text-[color:var(--text-secondary)] underline" onClick={() => setVerHistorial((v) => !v)}>
          {verHistorial ? "Ocultar el historial y lo que sigue" : "Ver el historial y lo que sigue"}
        </button>
      )}
      {verHistorial && (
        <div className="space-y-2 text-[12px]">
          {hechas.map((t) => (
            <div key={t.clave}>
              <span className="font-medium text-[color:var(--text-primary)]">Día {t.dia}:</span>{" "}
              <span className="text-[color:var(--text-secondary)]">
                {t.toques.map((q) => `${q.codigo} ${RESULTADO_LABELS[q.resultado as Resultado] ?? q.resultado ?? "pendiente"}`).join(" · ")}
              </span>
            </div>
          ))}
          {data.siguientes.length > 0 && (
            <div>
              <span className="font-medium text-[color:var(--text-primary)]">Lo que sigue:</span>{" "}
              <span className="text-[color:var(--text-secondary)]">
                {Object.entries(
                  data.siguientes.reduce<Record<number, string[]>>((acc, s) => {
                    (acc[s.dia] ??= []).push(`${s.codigo} (${CANAL_LABELS[s.canal as Canal] ?? s.canal})`);
                    return acc;
                  }, {}),
                )
                  .map(([dia, qs]) => `día ${dia}: ${qs.join(", ")}`)
                  .join(" · ")}
              </span>
            </div>
          )}
          {data.historial.length > 0 && (
            <div>
              <span className="font-medium text-[color:var(--text-primary)]">Antes:</span>{" "}
              <span className="text-[color:var(--text-secondary)]">
                {data.historial
                  .map((h) => `${h.nombre} (${fechaCorta(h.inicio)}${h.finAt ? ` – ${fechaCorta(h.finAt)}` : ""}${h.motivoFin ? `, ${MOTIVO_FIN[h.motivoFin] ?? h.motivoFin}` : ""})`)
                  .join(" · ")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
