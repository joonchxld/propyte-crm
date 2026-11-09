// Configuración → Automatización: workflows con switch, cadencias, SLA editable, cola.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Pencil, GitBranch } from "lucide-react";
import { WorkflowBuilder } from "./workflow-builder";
import { CadenceEditor } from "./cadence-editor";
import { SlaPolicyEditor } from "./sla-policy-editor";
import { SlaReasignacionCard } from "./sla-reasignacion-card";
import { mensajeAutomatizacion } from "./cadence-editor";
import { useFuentes } from "./use-fuentes";
import { minutosAcumulados } from "./cadence-editor-model";
import { describeRule, describeStep, type FuentesDeAccion } from "@/lib/workflows/action-catalog";
import { labelFor } from "@/lib/journey/node-catalog";
import { etiqueta } from "@/lib/labels";
import { toast } from "@/components/ui/use-toast";

const QUEUE_LABELS: Record<string, string> = {
  PENDING: "Pendientes",
  RUNNING: "En ejecución",
  DONE: "Hechas",
  FAILED: "Fallidas",
  SKIPPED: "Omitidas",
};

const ENTIDADES: Record<string, string> = {
  contact: "contacto", deal: "operación", lead: "lead", task: "tarea", conversation: "conversación", enrollment: "cadencia",
};

function pasosEnFrases(steps: Plan["steps"], fuentes: FuentesDeAccion): string[] {
  const ordenados = [...steps].sort((a, b) => a.order - b.order);
  const acum = minutosAcumulados(ordenados);
  return ordenados.map((st, i) => describeStep(st, fuentes, { acumuladoMinutos: acum[i] }));
}

interface Rule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: string;
  lastFiredAt: string | null;
  triggerConfig?: unknown;
  conditions?: unknown;
  actions: unknown[];
}
interface Plan {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  ownerUserId: string | null;
  exitConditions: unknown;
  steps: Array<{ order: number; actionType: string; delayMinutes: number; config: Record<string, unknown>; autonomyLevel: string }>;
  _count: { enrollments: number };
}
interface Sla {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  priority: number;
  conditions: unknown;
  firstTouchMinutes: number;
  retryMinutes: number;
  orphanHours: number;
  businessHours: unknown;
  _count: { timers: number };
}

function Switch({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative h-5 w-9 rounded-full transition-colors disabled:opacity-40"
      style={{ background: on ? "var(--color-success)" : "var(--bg-badge-neutral)" }}
      title={on ? "Activo — clic para pausar" : "Inactivo — clic para activar"}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
        style={{ left: on ? "18px" : "2px", boxShadow: "0 1px 2px rgba(0,0,0,.2)" }}
      />
    </button>
  );
}

export function AutomationSection({
  userRole,
  deepLinkPlanId,
  deepLinkSlaId,
  deepLinkRuleId,
}: {
  userRole: string;
  /** Deep-link desde Journey (cadence node click) → abre esta cadencia directo. */
  deepLinkPlanId?: string;
  /** Deep-link desde Journey (panel SLA) → abre esta política directo (via SlaPolicyEditor). */
  deepLinkSlaId?: string;
  /** Deep-link desde /journey ("Editar en Configuración") → abre el builder de esta regla. */
  deepLinkRuleId?: string;
}) {
  const canEdit = ["ADMIN", "DIRECTOR"].includes(userRole);
  const { fuentes } = useFuentes();
  const [rules, setRules] = useState<Rule[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [slas, setSlas] = useState<Sla[]>([]);
  const appliedPlanDeepLink = useRef(false);
  const [queue, setQueue] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState("");
  const [obs, setObs] = useState<{ recentErrors: any[]; eventsPending: number; eventsDone24h: number }>({ recentErrors: [], eventsPending: 0, eventsDone24h: 0 });
  const [builderRule, setBuilderRule] = useState<"new" | any | null>(null);
  const [editingPlan, setEditingPlan] = useState<"new" | Plan | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/automation");
    if (res.ok) {
      const { data } = await res.json();
      setRules(data.rules ?? []);
      setPlans(data.plans ?? []);
      setSlas(data.slaPolicies ?? []);
      setQueue(data.queue ?? {});
      setObs(data.observability ?? { recentErrors: [], eventsPending: 0, eventsDone24h: 0 });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Deep-link desde Journey (Tarea 2): cadence node → /configuracion?section=automation&planId=<id>
  // abre esa cadencia directo, una sola vez (no reabrir si el usuario la cierra o edita otra).
  useEffect(() => {
    if (appliedPlanDeepLink.current || !deepLinkPlanId || plans.length === 0) return;
    appliedPlanDeepLink.current = true;
    const p = plans.find((x) => x.id === deepLinkPlanId);
    if (p) setEditingPlan(p);
  }, [deepLinkPlanId, plans]);

  // Deep-link desde /journey: ?ruleId=<id> abre el builder de esa regla, una sola vez.
  const appliedRuleDeepLink = useRef(false);
  useEffect(() => {
    if (appliedRuleDeepLink.current || !deepLinkRuleId || rules.length === 0) return;
    appliedRuleDeepLink.current = true;
    const r = rules.find((x) => x.id === deepLinkRuleId);
    if (r && canEdit) setBuilderRule(r);
  }, [deepLinkRuleId, rules, canEdit]);

  async function retry(id: string) {
    const res = await fetch("/api/admin/automation/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) toast({ title: "Acción puesta de nuevo en la fila" });
    else setMsg("No se pudo reintentar la acción");
    load();
  }

  async function patch(body: Record<string, unknown>, okTitle?: string) {
    setMsg("");
    const res = await fetch("/api/admin/automation", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setMsg(mensajeAutomatizacion(d, "No se pudo guardar el cambio"));
    } else if (okTitle) {
      toast({ title: okTitle });
    }
    load();
  }

  const accionesPendientes = (queue.PENDING ?? 0) + (queue.RUNNING ?? 0);
  const accionesFallidas = queue.FAILED ?? 0;
  const semaforo =
    accionesFallidas > 0
      ? { color: "var(--color-error)", titulo: "Hay problemas.", detalle: `${accionesFallidas} ${accionesFallidas === 1 ? "acción falló" : "acciones fallaron"}; revisa los errores y reintenta.` }
      : accionesPendientes > 0 || obs.eventsPending > 0
      ? { color: "#d97706", titulo: "Trabajando.", detalle: `Hay ${accionesPendientes + obs.eventsPending} elementos esperando su turno; se procesan en unos minutos.` }
      : { color: "var(--color-success)", titulo: "Todo al día.", detalle: `Nada pendiente ni fallido · ${obs.eventsDone24h} procesados en 24 h.` };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Flujos de trabajo y SLA</h1>
        <p className="text-muted-foreground">
          Acciones programadas: {Object.entries(queue).map(([k, v]) => `${etiqueta(QUEUE_LABELS, k)} ${v}`).join(" · ") || "ninguna"}
        </p>
      </div>
      {msg && <p className="text-[13px]" style={{ color: "var(--color-error)" }}>{msg}</p>}

      {/* Observabilidad (T4.1) */}
      <div className="crm-card !p-0 overflow-hidden">
        <div className="px-4 py-3 hairline-b flex items-center justify-between">
          <span className="text-[13px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
            ¿Está funcionando la automatización?
          </span>
          <button onClick={load} className="text-[12px] hover:underline" style={{ color: "var(--text-tertiary)" }}>Actualizar</button>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 hairline-b">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: semaforo.color }} />
          <p className="text-[13px]"><strong>{semaforo.titulo}</strong> <span style={{ color: "var(--text-secondary)" }}>{semaforo.detalle}</span></p>
        </div>
        <div className="grid grid-cols-2 gap-px md:grid-cols-4" style={{ background: "var(--border-subtle)" }}>
          <div className="px-4 py-3" style={{ background: "var(--bg-card)" }}>
            <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>Eventos por procesar</p>
            <p className="num mt-0.5 text-[15px] font-medium" style={{ color: obs.eventsPending > 0 ? "var(--color-error)" : "var(--text-primary)" }}>{obs.eventsPending}</p>
          </div>
          <div className="px-4 py-3" style={{ background: "var(--bg-card)" }}>
            <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>Procesados en 24 h</p>
            <p className="num mt-0.5 text-[15px] font-medium">{obs.eventsDone24h}</p>
          </div>
          <div className="px-4 py-3" style={{ background: "var(--bg-card)" }}>
            <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>Acciones pendientes</p>
            <p className="num mt-0.5 text-[15px] font-medium">{accionesPendientes}</p>
          </div>
          <div className="px-4 py-3" style={{ background: "var(--bg-card)" }}>
            <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>Fallidas</p>
            <p className="num mt-0.5 text-[15px] font-medium" style={{ color: (queue.FAILED ?? 0) > 0 ? "var(--color-error)" : "var(--text-primary)" }}>{queue.FAILED ?? 0}</p>
          </div>
        </div>
        {obs.recentErrors.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border-subtle)" }}>
            <p className="px-4 pt-3 text-[11px] uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>Errores recientes</p>
            <ul className="divide-y" style={{ borderColor: "var(--border-subtle)" }}>
              {obs.recentErrors.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div className="min-w-0">
                    <p className="text-[13px]">{labelFor(e.actionType)} <span style={{ color: "var(--text-tertiary)" }}>· {etiqueta(ENTIDADES, String(e.entityType ?? "").toLowerCase(), "—")}</span></p>
                    <p className="truncate text-[11px]" style={{ color: "var(--color-error)" }}>{e.error ?? "—"} ({e.attempts}/{e.maxAttempts})</p>
                  </div>
                  {canEdit && (
                    <button onClick={() => retry(e.id)} className="btn-secondary shrink-0 text-[12px]">Reintentar</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="px-4 py-3 text-[12px]" style={{ borderTop: "1px solid var(--border-subtle)", color: "var(--text-tertiary)" }}>
          <summary className="cursor-pointer">Detalles técnicos</summary>
          <p className="mt-1">
            Las reglas se ejecutan con una tarea programada (cron) en <code>/api/cron/workflows</code> que debe estar
            activa en el servidor (crontab del VPS). Si &ldquo;Eventos por procesar&rdquo; no baja, revisa que esa tarea esté corriendo.
          </p>
        </details>
      </div>

      {/* Workflows */}
      <div className="crm-card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 hairline-b">
          <div>
            <p className="text-[13px] font-semibold">Reglas de flujo de trabajo</p>
            <p className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>
              Cuando pasa algo en el CRM, la regla hace algo por ti (más en &ldquo;Detalles técnicos&rdquo; arriba)
            </p>
          </div>
          {canEdit && (
            <button className="btn-primary shrink-0 text-[12px]" onClick={() => setBuilderRule("new")}>
              <Plus className="h-3.5 w-3.5" /> Nueva regla
            </button>
          )}
        </div>
        {rules.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 hairline-b">
            <div className="min-w-0">
              <p className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{r.name}</p>
              <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {describeRule(r, fuentes)}
              </p>
              <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                última: {r.lastFiredAt ? new Date(r.lastFiredAt).toLocaleString("es-MX") : "nunca"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canEdit && (
                <button onClick={() => setBuilderRule(r)} className="text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]" title="Editar regla">
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              <a
                href={`/journey?ruleId=${r.id}`}
                className="text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
                title="Ver en el mapa"
              >
                <GitBranch className="h-4 w-4" />
              </a>
              <Switch on={r.isActive} disabled={!canEdit} onChange={(v) => patch({ kind: "rule", id: r.id, isActive: v }, v ? "Regla activada" : "Regla pausada · no afecta acciones ya programadas")} />
            </div>
          </div>
        ))}
        {rules.length === 0 && (
          <p className="px-4 py-6 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
            Sin reglas todavía. Crea la primera con “Nueva regla”.
          </p>
        )}
      </div>

      {/* Modal del builder */}
      {builderRule && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4" style={{ background: "rgba(0,0,0,.4)" }}>
          <div className="my-8 w-full max-w-2xl rounded-lg p-5" style={{ background: "var(--bg-card)" }}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{builderRule === "new" ? "Nueva regla" : "Editar regla"}</h2>
            </div>
            <WorkflowBuilder
              rule={builderRule === "new" ? undefined : builderRule}
              onSaved={() => { setBuilderRule(null); load(); }}
              onCancel={() => setBuilderRule(null)}
            />
          </div>
        </div>
      )}

      {/* Cadencias */}
      <div className="crm-card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 hairline-b">
          <div>
            <p className="text-[13px] font-semibold">Secuencias de seguimiento (cadencias)</p>
            <p className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>
              Pasos programados (mensaje, tarea, aviso…) que se aplican a un contacto con el paso del tiempo
            </p>
          </div>
          {canEdit && (
            <button
              className="btn-primary shrink-0 text-[12px]"
              onClick={() => setEditingPlan("new")}
            >
              <Plus className="h-3.5 w-3.5" /> Nueva cadencia
            </button>
          )}
        </div>

        {editingPlan && (
          <div className="px-4 py-4 hairline-b">
            <CadenceEditor
              initial={
                editingPlan === "new"
                  ? undefined
                  : {
                      id: editingPlan.id,
                      name: editingPlan.name,
                      description: editingPlan.description ?? "",
                      exitConditions: editingPlan.exitConditions,
                      steps: [...editingPlan.steps]
                        .sort((a, b) => a.order - b.order)
                        .map((s) => ({
                          actionType: s.actionType,
                          delayMinutes: s.delayMinutes,
                          config: s.config ?? {},
                          autonomyLevel: s.autonomyLevel ?? "L0",
                        })),
                    }
              }
              onSaved={() => { setEditingPlan(null); load(); }}
              onCancel={() => setEditingPlan(null)}
            />
          </div>
        )}

        {plans.length === 0 && !editingPlan && (
          <p className="px-4 py-6 text-center text-[13px]" style={{ color: "var(--text-tertiary)" }}>
            Sin cadencias. Crea la primera con &ldquo;Nueva cadencia&rdquo;.
          </p>
        )}
        {plans.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 hairline-b">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                {p.name}
                {p.ownerUserId && <span className="badge badge-neutral ml-1">personal</span>}
              </p>
              <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                {p.steps.length} {p.steps.length === 1 ? "paso" : "pasos"} · {p._count.enrollments} {p._count.enrollments === 1 ? "contacto en curso" : "contactos en curso"}
              </p>
              {p.steps.length > 0 && (
                <ol className="mt-0.5 space-y-0.5 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                  {pasosEnFrases(p.steps, fuentes).map((f, i) => <li key={i}>{f}</li>)}
                </ol>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canEdit && (
                <button
                  onClick={() => setEditingPlan(p)}
                  className="text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
                  title="Editar cadencia"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
              <Switch on={p.isActive} disabled={!canEdit} onChange={(v) => patch({ kind: "plan", id: p.id, isActive: v }, v ? "Cadencia activada" : "Cadencia pausada")} />
            </div>
          </div>
        ))}
      </div>

      {/* SLA */}
      <SlaPolicyEditor policies={slas} canEdit={canEdit} onChanged={load} deepLinkSlaId={deepLinkSlaId} />
      <SlaReasignacionCard canEdit={canEdit} />
    </div>
  );
}
