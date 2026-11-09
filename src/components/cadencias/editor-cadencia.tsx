// #993 — Editor de una cadencia en el módulo «Cadencias»: datos generales (nombre, descripción,
// plazo, encendida) y sus pasos. Los cambios aplican a los toques que faltan; los que ya se crearon
// no cambian.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2 } from "lucide-react";
import { CANAL_LABELS, PAIS_LABELS, type Canal, type Pais } from "@/lib/copilot/cadencia-nuevos";
import { CANALES, PAISES, momentoDelPaso, validarPaso, type PasoDef } from "@/lib/copilot/cadencias-def";

export interface PasoEditable extends PasoDef {
  id: string;
}

export interface CadenciaEditable {
  tipo: string;
  nombre: string;
  descripcion: string;
  activa: boolean;
  finDias: number;
  finAncla: string;
  pasos: PasoEditable[];
}

const WHATSAPP_LABELS: Record<PasoDef["whatsapp"], string> = {
  SIEMPRE: "Siempre",
  CON_WA: "Solo si se le puede escribir por WhatsApp",
  SIN_WA: "Solo si NO se le puede escribir por WhatsApp",
};

/** Solo los campos del paso (sin id ni fechas), para comparar si cambió algo. */
function soloPaso(x: PasoDef): PasoDef {
  return {
    codigo: x.codigo,
    canal: x.canal,
    offset: x.offset,
    unidad: x.unidad,
    ancla: x.ancla,
    plantilla: x.plantilla,
    paises: x.paises,
    whatsapp: x.whatsapp,
    cuando: x.cuando,
    nota: x.nota,
    orden: x.orden,
    activo: x.activo,
  };
}

async function llamar(url: string, method: string, cuerpo?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
    });
    if (res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j?.error ?? "No se pudo guardar";
  } catch {
    return "No se pudo guardar (sin conexión)";
  }
}

function FilaPaso({
  tipo,
  paso,
  plantillas,
  nuevo = false,
  onListo,
}: {
  tipo: string;
  paso: PasoEditable | (PasoDef & { id?: undefined });
  plantillas: string[];
  nuevo?: boolean;
  onListo: () => void;
}) {
  const [p, setP] = useState<PasoDef>(soloPaso(paso));
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const cambio = nuevo || JSON.stringify(p) !== JSON.stringify(soloPaso(paso));
  const set = <K extends keyof PasoDef>(k: K, v: PasoDef[K]) => setP((x) => ({ ...x, [k]: v }));

  async function guardar() {
    const errores = validarPaso(p);
    if (errores.length > 0) return setError(errores.join(" "));
    setGuardando(true);
    setError(null);
    const e = nuevo
      ? await llamar(`/api/cadencias/${tipo}/pasos`, "POST", p)
      : await llamar(`/api/cadencias/${tipo}/pasos/${paso.id}`, "PATCH", p);
    setGuardando(false);
    if (e) setError(e);
    else onListo();
  }

  async function quitar() {
    if (!paso.id) return;
    if (!window.confirm(`¿Quitar el paso ${paso.codigo}? Los toques que ya se crearon se quedan. Para pausarlo sin quitarlo, apágalo.`)) return;
    setGuardando(true);
    const e = await llamar(`/api/cadencias/${tipo}/pasos/${paso.id}`, "DELETE");
    setGuardando(false);
    if (e) setError(e);
    else onListo();
  }

  return (
    <div className={`space-y-2 py-3 ${p.activo ? "" : "opacity-60"}`}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Código
          <input className="form-input mt-0.5 w-full text-[12px]" value={p.codigo} onChange={(e) => set("codigo", e.target.value.toUpperCase())} />
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Canal
          <select className="form-input mt-0.5 w-full text-[12px]" value={p.canal} onChange={(e) => set("canal", e.target.value as Canal)}>
            {CANALES.map((c) => (
              <option key={c} value={c}>
                {CANAL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Momento
          <div className="mt-0.5 flex gap-1">
            <input
              type="number"
              className="form-input w-20 text-[12px]"
              value={p.offset}
              onChange={(e) => set("offset", Number(e.target.value))}
              aria-label="Cuánto después del ancla"
            />
            <select className="form-input text-[12px]" value={p.unidad} onChange={(e) => set("unidad", e.target.value as PasoDef["unidad"])} aria-label="Unidad">
              <option value="DIA">días</option>
              <option value="MIN">minutos</option>
            </select>
          </div>
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Desde
          <select className="form-input mt-0.5 w-full text-[12px]" value={p.ancla} onChange={(e) => set("ancla", e.target.value as PasoDef["ancla"])}>
            <option value="CADENCIA">El inicio de la cadencia</option>
            <option value="FECHA_RECONTACTO">La fecha de recontacto</option>
          </select>
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Plantilla
          <select
            className="form-input mt-0.5 w-full text-[12px]"
            value={p.plantilla ?? ""}
            onChange={(e) => set("plantilla", e.target.value || null)}
          >
            <option value="">(sin texto: llamada)</option>
            {[...new Set([...(p.plantilla ? [p.plantilla] : []), ...plantillas])].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Orden
          <input type="number" className="form-input mt-0.5 w-full text-[12px]" value={p.orden} onChange={(e) => set("orden", Number(e.target.value))} />
        </label>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Cuándo (lo ve el asesor; acepta [YA], [FRANJA], [FRANJA_OPUESTA])
          <input className="form-input mt-0.5 w-full text-[12px]" value={p.cuando} onChange={(e) => set("cuando", e.target.value)} />
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          Aviso para el asesor (opcional)
          <input className="form-input mt-0.5 w-full text-[12px]" value={p.nota ?? ""} onChange={(e) => set("nota", e.target.value || null)} />
        </label>
        <label className="text-[11px] text-[color:var(--text-tertiary)]">
          WhatsApp
          <select className="form-input mt-0.5 w-full text-[12px]" value={p.whatsapp} onChange={(e) => set("whatsapp", e.target.value as PasoDef["whatsapp"])}>
            {(Object.keys(WHATSAPP_LABELS) as PasoDef["whatsapp"][]).map((w) => (
              <option key={w} value={w}>
                {WHATSAPP_LABELS[w]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <span className="text-[color:var(--text-tertiary)]">Países:</span>
        {PAISES.map((x) => (
          <label key={x} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={p.paises.includes(x)}
              onChange={(e) => set("paises", e.target.checked ? [...p.paises, x] : p.paises.filter((y) => y !== x))}
            />
            {PAIS_LABELS[x as Pais]}
          </label>
        ))}
        <span className="text-[color:var(--text-tertiary)]">{p.paises.length === 0 ? "(ninguno marcado = todos)" : ""}</span>
        <label className="ml-auto inline-flex items-center gap-1">
          <input type="checkbox" checked={p.activo} onChange={(e) => set("activo", e.target.checked)} /> Encendido
        </label>
        <span className="text-[color:var(--text-tertiary)]">{momentoDelPaso(p)}</span>
        <button type="button" className="btn-secondary text-[12px]" disabled={guardando || !cambio} onClick={guardar}>
          {nuevo ? <Plus className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />} {nuevo ? "Agregar" : "Guardar"}
        </button>
        {!nuevo && (
          <button type="button" className="btn-secondary text-[12px]" disabled={guardando} onClick={quitar} aria-label={`Quitar ${paso.codigo}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {error && <p className="text-[12px] text-red-600">{error}</p>}
    </div>
  );
}

const PASO_NUEVO: PasoDef = {
  codigo: "",
  canal: "WHATSAPP",
  offset: 1,
  unidad: "DIA",
  ancla: "CADENCIA",
  plantilla: null,
  paises: [],
  whatsapp: "CON_WA",
  cuando: "En horario laboral",
  nota: null,
  orden: 0,
  activo: true,
};

export function EditorCadencia({ cadencia, plantillas }: { cadencia: CadenciaEditable; plantillas: string[] }) {
  const router = useRouter();
  const [nombre, setNombre] = useState(cadencia.nombre);
  const [descripcion, setDescripcion] = useState(cadencia.descripcion);
  const [finDias, setFinDias] = useState(cadencia.finDias);
  const [estado, setEstado] = useState<string>("");
  const [agregando, setAgregando] = useState(false);
  const refrescar = () => {
    setAgregando(false);
    router.refresh();
  };

  async function guardarGenerales(cambios: Record<string, unknown>) {
    setEstado("guardando");
    const e = await llamar(`/api/cadencias/${cadencia.tipo}`, "PATCH", cambios);
    setEstado(e ?? "ok");
    if (!e) router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="crm-card space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-[11px] text-[color:var(--text-tertiary)]">
            Nombre
            <input className="form-input mt-0.5 w-full text-[13px]" value={nombre} onChange={(e) => setNombre(e.target.value)} />
          </label>
          <label className="text-[11px] text-[color:var(--text-tertiary)]">
            Plazo (días{cadencia.finAncla === "FECHA_RECONTACTO" ? " después de la fecha de recontacto" : ""})
            <input type="number" className="form-input mt-0.5 w-full text-[13px]" value={finDias} onChange={(e) => setFinDias(Number(e.target.value))} />
          </label>
          <div className="flex items-end gap-2">
            <label className="inline-flex items-center gap-1 text-[13px]">
              <input type="checkbox" checked={cadencia.activa} onChange={(e) => guardarGenerales({ activa: e.target.checked })} /> Encendida
            </label>
          </div>
        </div>
        <label className="block text-[11px] text-[color:var(--text-tertiary)]">
          Descripción
          <textarea className="form-input mt-0.5 min-h-[56px] w-full text-[13px]" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary text-[12px]"
            disabled={estado === "guardando" || (nombre === cadencia.nombre && descripcion === cadencia.descripcion && finDias === cadencia.finDias)}
            onClick={() => guardarGenerales({ nombre, descripcion, finDias })}
          >
            <Save className="h-3.5 w-3.5" /> Guardar
          </button>
          {estado === "ok" && <span className="text-[12px] text-emerald-600">Guardado</span>}
          {estado && estado !== "ok" && estado !== "guardando" && <span className="text-[12px] text-red-600">{estado}</span>}
          {!cadencia.activa && <span className="text-[12px] text-amber-700">Apagada: no entra nadie nuevo; las que ya van siguen.</span>}
        </div>
      </div>

      <div className="crm-card">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-[color:var(--text-primary)]">Pasos ({cadencia.pasos.length})</h2>
          <button type="button" className="btn-secondary text-[12px]" onClick={() => setAgregando((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Agregar paso
          </button>
        </div>
        <p className="mt-1 text-[12px] text-[color:var(--text-tertiary)]">
          Si dos pasos tienen el mismo código, sale el primero (por orden) que aplica al contacto: así se arman las versiones por país o por
          WhatsApp de un mismo toque. Un paso nuevo no genera toques que ya debieron salir antes de crearlo.
        </p>
        <div className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
          {agregando && <FilaPaso tipo={cadencia.tipo} paso={PASO_NUEVO} plantillas={plantillas} nuevo onListo={refrescar} />}
          {cadencia.pasos.map((p) => (
            <FilaPaso key={`${p.id}:${p.orden}:${p.offset}:${p.activo}`} tipo={cadencia.tipo} paso={p} plantillas={plantillas} onListo={refrescar} />
          ))}
        </div>
      </div>
    </div>
  );
}
