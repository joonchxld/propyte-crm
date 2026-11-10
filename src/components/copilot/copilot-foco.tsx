// #997 — Copilot «una a la vez»: la actividad que toca ahora, en grande, como carta de Tinder.
//
// Mismos datos que «Mi día» (#988/#993). Se ve una carta a la vez: la respuesta por clasificar o el
// toque que sigue con un contacto. Al marcar el resultado se refresca y aparece lo siguiente; con
// «Saltar» / «Anterior», las flechas ← → o deslizando la carta se recorre la fila sin marcar nada.
// Abajo a la derecha queda un recuadro reservado para el preview (por ahora vacío).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, List, MessageSquareReply, Sparkles } from "lucide-react";
import type { MiDia, TareaLista } from "@/lib/copilot/mi-dia";
import type { ClasificacionPendiente } from "@/lib/copilot/cadencia-servicio";
import { PAIS_LABELS, RESULTADO_LABELS, type Resultado } from "@/lib/copilot/cadencia-nuevos";
import {
  armarFila,
  direccionDeslizar,
  indiceTrasCambio,
  moverIndice,
  tituloActividad,
  toqueActual,
  type ItemFila,
} from "@/lib/copilot/fila";
import { etiquetaEstado } from "@/lib/estados";
import { ToqueFila } from "./tarea-del-dia";
import { ClasificarRespuesta } from "./clasificar-respuesta";

const TEMPERATURA: Record<string, { texto: string; clase: string }> = {
  HOT: { texto: "Caliente", clase: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300" },
  WARM: { texto: "Tibio", clase: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" },
  COLD: { texto: "Frío", clase: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" },
  DEAD: { texto: "Muerto", clase: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300" },
};

/** Lo que no debe arrancar un arrastre: ahí el clic o la selección de texto mandan. */
const INTERACTIVO = "button, a, input, textarea, select, label, [role='radio'], [contenteditable='true']";

/** El recuadro de la esquina inferior derecha. Vacío por ahora (#997). */
export function PreviewCopilot() {
  return (
    <aside
      aria-label="Preview"
      className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed text-[12px] text-[color:var(--text-tertiary)] shadow-sm lg:fixed lg:bottom-6 lg:right-6 lg:z-20 lg:h-44 lg:w-72"
      style={{ background: "var(--bg-card)", borderColor: "var(--border-default)" }}
    >
      Preview irá aquí
    </aside>
  );
}

function CartaClasificar({ pendiente, onCambio }: { pendiente: ClasificacionPendiente; onCambio: () => void }) {
  const temp = pendiente.temperatura ? TEMPERATURA[pendiente.temperatura] : null;
  return (
    <>
      <p className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-300">
        <MessageSquareReply className="h-3.5 w-3.5" aria-hidden="true" /> Respondió · clasifica su respuesta
      </p>
      <h2 className="mt-2 text-2xl font-semibold leading-tight text-[color:var(--text-primary)]">
        Clasificar la respuesta de{" "}
        <Link href={`/contacts/${pendiente.contactId}`} className="hover:underline">
          {pendiente.nombre}
        </Link>
      </h2>
      {temp && <span className={`mt-2 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${temp.clase}`}>{temp.texto}</span>}
      <div className="mt-4">
        <ClasificarRespuesta pendiente={pendiente} onCambio={onCambio} mostrarContacto={false} sinMarco />
      </div>
    </>
  );
}

function CartaTarea({ tarea, userId, onCambio }: { tarea: TareaLista; userId: string; onCambio: () => void }) {
  const c = tarea.contacto;
  const actual = toqueActual(tarea);
  const temp = c.temperatura ? TEMPERATURA[c.temperatura] : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-[color:var(--text-secondary)]">
        <span className="font-medium uppercase tracking-wide">
          {tarea.nombreCadencia} · Día {tarea.dia}
          {tarea.ultimoDia ? ` de ${tarea.ultimoDia}` : ""}
        </span>
        {temp && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${temp.clase}`} title={c.motivoTemperatura ?? undefined}>
            {temp.texto}
          </span>
        )}
        {tarea.vencida && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Vencida</span>}
      </div>

      <h2 className="mt-2 text-2xl font-semibold leading-tight text-[color:var(--text-primary)]">
        {actual ? tituloActividad(actual.canal, c.nombre) : c.nombre}
      </h2>
      <p className="mt-1 text-[13px] text-[color:var(--text-tertiary)]">
        <Link href={`/contacts/${c.id}`} className="text-[color:var(--text-secondary)] hover:underline">
          Ver ficha
        </Link>{" "}
        · {etiquetaEstado(c.estado)} · {PAIS_LABELS[c.pais]} · {c.idioma === "EN" ? "inglés" : "español"}
      </p>

      {actual && (
        <ul className="mt-3 rounded-lg border px-4" style={{ borderColor: "var(--border-subtle)" }}>
          <ToqueFila key={actual.id} toque={actual} tarea={tarea} userId={userId} onCambio={onCambio} />
        </ul>
      )}

      {tarea.toques.length > 1 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--text-tertiary)]">Toques de hoy con este contacto</p>
          <ol className="flex flex-wrap gap-1.5">
            {[...tarea.toques]
              .sort((a, b) => a.orden - b.orden)
              .map((t) => {
                const esActual = actual?.id === t.id;
                return (
                  <li
                    key={t.id}
                    aria-current={esActual ? "step" : undefined}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      esActual
                        ? "border-[color:var(--text-primary)] font-semibold text-[color:var(--text-primary)]"
                        : t.resultado
                          ? "border-transparent bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : "border-[color:var(--border-default)] text-[color:var(--text-secondary)]"
                    }`}
                    title={t.resultado ? RESULTADO_LABELS[t.resultado as Resultado] ?? t.resultado : t.cuando}
                  >
                    {t.resultado && <Check className="h-3 w-3" aria-hidden="true" />}
                    {t.codigo}
                  </li>
                );
              })}
          </ol>
        </div>
      )}
    </>
  );
}

export function CopilotFoco({
  data,
  userId,
  sinMigrar = false,
}: {
  data: MiDia & { clasificar?: ClasificacionPendiente[] };
  userId: string;
  sinMigrar?: boolean;
}) {
  const router = useRouter();
  const refrescar = useCallback(() => router.refresh(), [router]);
  const fila: ItemFila[] = useMemo(() => armarFila(data), [data]);
  const claves = useMemo(() => fila.map((i) => i.clave), [fila]);

  // Se guarda qué carta se estaba viendo y en qué posición: al refrescar, la fila cambia.
  const [vista, setVista] = useState<{ clave: string | null; indice: number }>({ clave: null, indice: 0 });
  const indice = indiceTrasCambio(claves, vista.clave, vista.indice);
  const item = fila[indice] ?? null;

  const [dx, setDx] = useState(0);
  const [saliendo, setSaliendo] = useState<1 | -1 | 0>(0);
  const [arrastrando, setArrastrando] = useState(false);
  const arrastre = useRef<{ x: number; id: number } | null>(null);

  const ir = useCallback(
    (paso: 1 | -1) => {
      if (claves.length < 2) return;
      const nuevo = moverIndice(indice, claves.length, paso);
      setVista({ clave: claves[nuevo], indice: nuevo });
    },
    [claves, indice],
  );

  /** Deslizar: la carta sale volando hacia ese lado y entra la vecina. */
  const despedir = useCallback(
    (paso: 1 | -1) => {
      if (claves.length < 2) {
        setDx(0);
        return;
      }
      setSaliendo(paso);
      window.setTimeout(() => {
        ir(paso);
        setSaliendo(0);
        setDx(0);
      }, 180);
    },
    [claves.length, ir],
  );

  useEffect(() => {
    function tecla(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select") || t.isContentEditable)) return;
      if (e.key === "ArrowRight") ir(1);
      else if (e.key === "ArrowLeft") ir(-1);
    }
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ir]);

  function alPresionar(e: ReactPointerEvent<HTMLDivElement>) {
    if (claves.length < 2 || (e.target as HTMLElement).closest(INTERACTIVO)) return;
    arrastre.current = { x: e.clientX, id: e.pointerId };
    setArrastrando(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function alMover(e: ReactPointerEvent<HTMLDivElement>) {
    if (arrastre.current?.id === e.pointerId) setDx(e.clientX - arrastre.current.x);
  }
  function alSoltar(e: ReactPointerEvent<HTMLDivElement>) {
    if (arrastre.current?.id !== e.pointerId) return;
    arrastre.current = null;
    setArrastrando(false);
    const dir = direccionDeslizar(dx);
    if (dir === 0) setDx(0);
    else despedir(dir);
  }

  if (sinMigrar) {
    return (
      <div className="crm-card text-[13px] text-[color:var(--text-secondary)]">
        Copilot todavía no está instalado en la base: falta correr la migración de «Mi día» (#988).
      </div>
    );
  }

  const desplazamiento = saliendo !== 0 ? -saliendo * 640 : dx;
  const estilo = {
    transform: `translateX(${desplazamiento}px) rotate(${desplazamiento / 24}deg)`,
    transition: arrastrando ? "none" : "transform 180ms ease-out, opacity 180ms ease-out",
    opacity: saliendo !== 0 ? 0 : 1,
    touchAction: "pan-y" as const,
  };

  return (
    <div className="space-y-4 lg:pr-80">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold text-[color:var(--text-primary)]">Ahora</h1>
        <span className="text-[13px] text-[color:var(--text-secondary)]">
          {fila.length === 0
            ? "Sin actividades pendientes"
            : `Actividad ${indice + 1} de ${fila.length}${data.fueraDelTope > 0 ? ` (+${data.fueraDelTope} fuera del tope)` : ""}`}
          {data.vencidas > 0 && <span className="text-red-600"> · {data.vencidas} vencidas</span>}
          {data.hechasHoy.length > 0 && <> · {data.hechasHoy.length} terminadas hoy</>}
        </span>
        <Link
          href="/copilot?vista=lista"
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
        >
          <List className="h-3.5 w-3.5" aria-hidden="true" /> Ver lista
        </Link>
      </div>

      {item === null ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
          <Sparkles className="h-10 w-10 text-muted-foreground/60" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No tienes actividades pendientes. Los leads nuevos aparecen aquí al entrar.</p>
        </div>
      ) : (
        <>
          <div className="relative mx-auto max-w-2xl">
            {/* La pila: cartas detrás para que se note que hay más. */}
            {fila.length > 2 && (
              <div aria-hidden="true" className="absolute inset-x-6 -bottom-4 top-4 rounded-xl border" style={{ background: "var(--bg-card)", borderColor: "var(--border-subtle)" }} />
            )}
            {fila.length > 1 && (
              <div aria-hidden="true" className="absolute inset-x-3 -bottom-2 top-2 rounded-xl border" style={{ background: "var(--bg-card)", borderColor: "var(--border-default)" }} />
            )}
            <div
              key={item.clave}
              role="group"
              aria-roledescription="carta"
              aria-label={`Actividad ${indice + 1} de ${fila.length}`}
              className={`relative min-h-[420px] select-text rounded-xl border p-6 shadow-md sm:p-8 ${
                item.tipo === "tarea" && item.tarea.vencida
                  ? "ring-1 ring-red-300 dark:ring-red-900"
                  : item.tipo === "clasificar"
                    ? "ring-1 ring-sky-300 dark:ring-sky-900"
                    : ""
              }`}
              style={{ ...estilo, background: "var(--bg-card)", borderColor: "var(--border-default)" }}
              onPointerDown={alPresionar}
              onPointerMove={alMover}
              onPointerUp={alSoltar}
              onPointerCancel={alSoltar}
            >
              {item.tipo === "clasificar" ? (
                <CartaClasificar pendiente={item.pendiente} onCambio={refrescar} />
              ) : (
                <CartaTarea tarea={item.tarea} userId={userId} onCambio={refrescar} />
              )}
            </div>
          </div>

          <div className="mx-auto flex max-w-2xl items-center justify-between pt-4">
            <button type="button" className="btn-secondary text-[13px]" onClick={() => ir(-1)} disabled={fila.length < 2}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Anterior
            </button>
            <span className="hidden text-[11px] text-[color:var(--text-tertiary)] sm:inline">Desliza la carta o usa ← →</span>
            <button type="button" className="btn-secondary text-[13px]" onClick={() => ir(1)} disabled={fila.length < 2}>
              Saltar <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </>
      )}

      <PreviewCopilot />
    </div>
  );
}
