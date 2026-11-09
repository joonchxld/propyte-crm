// #988 — Una tarea de «Mi día»: un contacto, un día de su cadencia y los toques de ese día.
//
// Cada toque trae cuándo hacerlo, el texto listo (editable antes de copiar), los enlaces para
// abrir WhatsApp, el correo o el SMS ya escritos, y los botones de resultado. Copilot no manda
// nada: el asesor abre, revisa, envía desde su teléfono o su correo y marca lo que pasó.
"use client";

import { useState } from "react";
import Link from "next/link";
import { Phone, MessageCircle, Mail, MessageSquareText, Voicemail, Copy, Check, AlertTriangle, ExternalLink, Undo2 } from "lucide-react";
import type { TareaLista, ToqueListo } from "@/lib/copilot/mi-dia";
import { PAIS_LABELS, RESULTADOS_POR_CANAL, RESULTADO_LABELS, type Canal, type Resultado } from "@/lib/copilot/cadencia-nuevos";
import { enlaceCorreo, enlaceSms, enlaceWhatsApp } from "@/lib/copilot/plantillas";
import { etiquetaEstado } from "@/lib/estados";
import { CallButton } from "@/components/voice/call-button";

const ICONO: Record<Canal, typeof Phone> = {
  LLAMADA: Phone,
  WHATSAPP: MessageCircle,
  SMS: MessageSquareText,
  CORREO: Mail,
  BUZON: Voicemail,
  MISMO_CANAL: MessageCircle,
};

const TEMPERATURA: Record<string, { texto: string; clase: string }> = {
  HOT: { texto: "Caliente", clase: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" },
  WARM: { texto: "Tibio", clase: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  COLD: { texto: "Frío", clase: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
  DEAD: { texto: "Muerto", clase: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" },
};

async function guardar(id: string, resultado: string | null, variante?: string | null): Promise<string | null> {
  try {
    const res = await fetch(`/api/copilot/toques/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resultado, ...(variante !== undefined ? { variante } : {}) }),
    });
    if (res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j?.error ?? "No se pudo guardar";
  } catch {
    return "No se pudo guardar (sin conexión)";
  }
}

function ToqueFila({
  toque,
  tarea,
  userId,
  onCambio,
}: {
  toque: ToqueListo;
  tarea: TareaLista;
  userId: string;
  onCambio: () => void;
}) {
  const [variante, setVariante] = useState(toque.variante);
  const base = toque.variantes ? toque.variantes.find((v) => v.valor === variante)?.texto ?? null : toque.texto;
  const [texto, setTexto] = useState(base?.texto ?? "");
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const Icono = ICONO[toque.canal] ?? Phone;
  const hecho = !!toque.resultado;
  const c = tarea.contacto;

  function cambiarVariante(v: string) {
    setVariante(v);
    const t = toque.variantes?.find((x) => x.valor === v)?.texto;
    setTexto(t?.texto ?? "");
  }

  async function marcar(r: Resultado | null) {
    setGuardando(true);
    setError(null);
    const e = await guardar(toque.id, r, toque.variantes ? variante : undefined);
    setGuardando(false);
    if (e) setError(e);
    else onCambio();
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      setError("No se pudo copiar; selecciona el texto y cópialo a mano");
    }
  }

  const enlace =
    toque.canal === "WHATSAPP" || toque.canal === "MISMO_CANAL"
      ? enlaceWhatsApp(c.telefono, texto)
      : toque.canal === "CORREO"
        ? enlaceCorreo(c.correo, base?.asunto ?? null, texto)
        : toque.canal === "SMS"
          ? enlaceSms(c.telefono, texto)
          : null;
  const faltan = base?.faltan ?? [];

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icono className="h-4 w-4 shrink-0 text-[color:var(--text-tertiary)]" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-[color:var(--text-primary)]">
          {toque.codigo.replace(/^CORREO/, "Correo ").replace(/^BUZON/, "Buzón ")}
          {toque.canal === "MISMO_CANAL" ? " · por el canal donde respondió" : ""}
        </span>
        <span className="text-[12px] text-[color:var(--text-secondary)]">{toque.cuando}</span>
        {toque.vencido && (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
            Vencido (más de 24 h)
          </span>
        )}
        {hecho && (
          <span className="ml-auto inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <Check className="h-3 w-3" aria-hidden="true" />
            {RESULTADO_LABELS[toque.resultado as Resultado] ?? toque.resultado}
            {toque.resultado !== "NO_HECHO" && (
              <button
                type="button"
                className="ml-1 text-emerald-800/70 hover:text-emerald-900 dark:text-emerald-200/70"
                title="Deshacer"
                aria-label="Deshacer el resultado"
                disabled={guardando}
                onClick={() => marcar(null)}
              >
                <Undo2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        )}
      </div>

      {!hecho && (
        <div className="mt-2 space-y-2 pl-6">
          {toque.bloqueo && (
            <p className="flex items-center gap-1 text-[12px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {toque.bloqueo}
            </p>
          )}
          {toque.nota && <p className="text-[12px] text-[color:var(--text-secondary)]">{toque.nota}</p>}

          {toque.canal === "LLAMADA" ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
              <span>
                Guion: Manual de Primera Llamada{toque.codigo === "L7" ? " · cierre en vivo" : ""}. De 9:00 a 20:00, hora del lead.
              </span>
              {c.telefono && !toque.bloqueo && (
                <CallButton phone={c.telefono} contactId={c.id} userId={userId} />
              )}
            </div>
          ) : (
            <>
              {toque.variantes && (
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Variante">
                  {toque.variantes.map((v) => (
                    <button
                      key={v.valor}
                      type="button"
                      role="radio"
                      aria-checked={variante === v.valor}
                      onClick={() => cambiarVariante(v.valor)}
                      className={`rounded border px-2 py-0.5 text-[12px] ${
                        variante === v.valor
                          ? "border-[color:var(--text-primary)] font-medium text-[color:var(--text-primary)]"
                          : "border-[color:var(--border-default)] text-[color:var(--text-secondary)]"
                      }`}
                    >
                      {v.etiqueta}
                    </button>
                  ))}
                </div>
              )}
              {base?.asunto && (
                <p className="text-[12px] text-[color:var(--text-secondary)]">
                  Asunto: <span className="text-[color:var(--text-primary)]">{base.asunto}</span>
                </p>
              )}
              {base ? (
                <textarea
                  className="form-input min-h-[96px] w-full text-[13px] leading-snug"
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  aria-label={`Texto de ${toque.codigo}`}
                />
              ) : (
                <p className="text-[12px] text-[color:var(--text-tertiary)]">No hay plantilla para este toque.</p>
              )}
              {(faltan.length > 0 || base?.otroIdioma) && (
                <p className="text-[12px] text-amber-700 dark:text-amber-300">
                  {faltan.length > 0 && <>Llena antes de enviar: {faltan.join(" ")}. </>}
                  {base?.otroIdioma && <>No hay versión en {c.idioma === "EN" ? "inglés" : "español"}: salió en el otro idioma.</>}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {base && (
                  <button type="button" className="btn-secondary text-[12px]" onClick={copiar}>
                    {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copiado ? "Copiado" : "Copiar"}
                  </button>
                )}
                {enlace && !toque.bloqueo && (
                  <a className="btn-secondary text-[12px]" href={enlace} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" /> Abrir {toque.canal === "MISMO_CANAL" ? "WhatsApp" : toque.canalLabel}
                  </a>
                )}
              </div>
            </>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {RESULTADOS_POR_CANAL[toque.canal].map((r) => (
              <button
                key={r}
                type="button"
                disabled={guardando}
                onClick={() => marcar(r)}
                className={r === "CONTESTO" || r === "RESPONDIO" ? "btn-primary text-[12px]" : "btn-secondary text-[12px]"}
              >
                {RESULTADO_LABELS[r]}
              </button>
            ))}
          </div>
          {error && <p className="text-[12px] text-red-600">{error}</p>}
        </div>
      )}
    </li>
  );
}

export function TareaDelDia({
  tarea,
  userId,
  onCambio,
  mostrarContacto = true,
}: {
  tarea: TareaLista;
  userId: string;
  onCambio: () => void;
  mostrarContacto?: boolean;
}) {
  const c = tarea.contacto;
  const temp = c.temperatura ? TEMPERATURA[c.temperatura] : null;
  return (
    <div className={`crm-card ${tarea.vencida ? "ring-1 ring-red-300 dark:ring-red-900" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        {mostrarContacto ? (
          <Link href={`/contacts/${c.id}`} className="text-[14px] font-semibold text-[color:var(--text-primary)] hover:underline">
            {c.nombre}
          </Link>
        ) : (
          <span className="text-[14px] font-semibold text-[color:var(--text-primary)]">
            {new Date(`${tarea.fecha}T12:00:00Z`).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
          </span>
        )}
        {temp && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${temp.clase}`} title={c.motivoTemperatura ?? undefined}>
            {temp.texto}
          </span>
        )}
        <span className="text-[12px] text-[color:var(--text-secondary)]">
          {tarea.nombreCadencia} · Día {tarea.dia}
          {tarea.ultimoDia ? ` de ${tarea.ultimoDia}` : ""}
        </span>
        {mostrarContacto && (
          <span className="text-[12px] text-[color:var(--text-tertiary)]">
            {etiquetaEstado(c.estado)} · {PAIS_LABELS[c.pais]} · {c.idioma === "EN" ? "inglés" : "español"}
          </span>
        )}
        {tarea.vencida && (
          <span className="ml-auto rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Vencida</span>
        )}
      </div>
      <ul className="mt-1 divide-y" style={{ borderColor: "var(--border-subtle)" }}>
        {tarea.toques.map((t) => (
          <ToqueFila key={`${t.id}:${t.resultado ?? ""}`} toque={t} tarea={tarea} userId={userId} onCambio={onCambio} />
        ))}
      </ul>
    </div>
  );
}
