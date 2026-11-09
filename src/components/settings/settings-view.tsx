// Configuración personal — tabs Perfil / Correo / Tarjeta / Plantillas (Anexo B §J.5).
// Minimalista B/N; guarda vía PATCH /api/profile y CRUD /api/profile/templates.
"use client";

import { useState, useEffect, useCallback } from "react";
import { QrCode, Save, Trash2, Plus, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { telefonoSinEspacios } from "@/lib/phone";
import { erroresPorCampo, leerError, mensajeDeError } from "@/lib/api-errors";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/use-toast";
import { etiqueta, PREFERRED_LANGUAGE_LABELS } from "@/lib/labels";

const CHANNEL_LABELS_PLANTILLA: Record<string, string> = { WHATSAPP: "WhatsApp", EMAIL: "Correo", SMS: "SMS" };

// Campos que la API acepta vaciar (cadena vacía). El resto (agenda, alias, slug) valida formato
// y rechaza "": si están vacíos no se mandan.
const VACIABLES = new Set<string>(["jobTitle", "bioEs", "bioEn", "phoneDirect", "whatsappNumber", "emailSignatureHtml"]);

const TABS = [
  { key: "perfil", label: "Perfil" },
  { key: "correo", label: "Correo" },
  { key: "tarjeta", label: "Tarjeta" },
  { key: "plantillas", label: "Plantillas" },
  { key: "google", label: "Google Workspace" },
] as const;

interface ProfileData {
  jobTitle?: string;
  bioEs?: string;
  bioEn?: string;
  phoneDirect?: string;
  whatsappNumber?: string;
  emailFromAlias?: string;
  emailSignatureHtml?: string;
  cardSlug?: string;
  calendarUrl?: string;
  socialLinks?: Record<string, string>;
  user?: { name: string; email: string };
}

interface Template {
  id: string;
  channel: string;
  name: string;
  shortcut: string | null;
  subject: string | null;
  body: string;
  language: string;
  isGlobal: boolean;
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="form-label !mb-0">{label}</label>
      {children}
      {hint && <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>{hint}</p>}
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

const SECCIONES_PLANTILLAS = [
  { key: "mias", label: "Mis plantillas" },
  { key: "copilot", label: "Copilot (generales)" },
] as const;

// `plantillasCopilot` llega ya renderado desde el servidor (editor de #988): son las plantillas
// generales de la cadencia del Copilot, iguales para todo el equipo.
export function SettingsView({ plantillasCopilot }: { plantillasCopilot?: React.ReactNode } = {}) {
  const [tab, setTab] = useState<string>("perfil");
  const [seccionPlantillas, setSeccionPlantillas] = useState<string>("mias");
  const [profile, setProfile] = useState<ProfileData>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const confirmar = useConfirm();
  const [newTpl, setNewTpl] = useState({ channel: "WHATSAPP", name: "", shortcut: "", body: "", language: "ES" });

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([fetch("/api/profile"), fetch("/api/profile/templates")]);
    if (p.ok) setProfile((await p.json()).data ?? {});
    if (t.ok) setTemplates((await t.json()).data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const [gw, setGw] = useState<{ connected: boolean; googleEmail?: string; isValid?: boolean } | null>(null)

  const loadGw = useCallback(async () => {
    try {
      const res = await fetch("/api/google/oauth/status")
      if (res.ok) setGw((await res.json()).data)
    } catch { /* degradación suave */ }
  }, [])

  useEffect(() => { loadGw() }, [loadGw])

  // #885: el botón «Correo» de la ficha manda aquí con ?tab=google, y el regreso de Google
  // tras conectar llega con ?google=<estado>: en los dos casos se abre la pestaña de la cuenta.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const pedido = q.get("tab") ?? (q.has("google") ? "google" : null)
      if (pedido && TABS.some((t) => t.key === pedido)) setTab(pedido)
      // ?tab=plantillas&seccion=copilot: a donde redirige la ruta vieja /copilot/plantillas.
      const seccion = q.get("seccion")
      if (seccion && SECCIONES_PLANTILLAS.some((s) => s.key === seccion)) setSeccionPlantillas(seccion)
    } catch { /* sin window (no debería pasar en un componente cliente) */ }
  }, [])

  async function disconnectGoogle() {
    const ok = await confirmar({
      titulo: "¿Desconectar tu cuenta de Gmail?",
      descripcion:
        "Dejarás de enviar correos desde el CRM con tu Gmail y ya no se registrarán tus conversaciones en el historial de cada contacto. Los correos ya registrados se conservan. Puedes volver a conectarla cuando quieras.",
      confirmar: "Desconectar",
      peligroso: true,
    })
    if (!ok) return
    const res = await fetch("/api/google/oauth/disconnect", { method: "DELETE" })
    if (res.ok) toast({ title: "Gmail desconectado" })
    else toast({ title: "No se pudo desconectar", description: await leerError(res), variant: "destructive" })
    await loadGw()
  }

  function set<K extends keyof ProfileData>(key: K, value: ProfileData[K]) {
    setProfile((prev) => ({ ...prev, [key]: value }));
  }

  // Sugerencia de slug derivada del nombre real del usuario (kebab-case, sin acentos).
  // Evita el placeholder hardcodeado que confundía a usuarios (parecía un valor por defecto de otra persona).
  const suggestedSlug =
    profile.user?.name
      ?.normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "nombre-apellido";

  async function save(fields: (keyof ProfileData)[]) {
    setSaving(true);
    setMsg("");
    setFieldErrors({});
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      const v = profile[f];
      if (f === "user" || v === undefined) continue;
      // Un campo vaciado se manda como "" para poder borrar el valor guardado (antes se omitía).
      if (v === "" && !VACIABLES.has(f)) continue;
      payload[f] = v;
    }
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) setMsg("Guardado ✓");
    else {
      const data = await res.json().catch(() => ({}));
      setFieldErrors(erroresPorCampo(data));
      setMsg(mensajeDeError(data, "No se pudo guardar. Revisa los campos marcados."));
    }
    setSaving(false);
  }

  async function createTemplate() {
    if (!newTpl.name || !newTpl.body) return;
    const res = await fetch("/api/profile/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...newTpl, shortcut: newTpl.shortcut || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setNewTpl({ channel: "WHATSAPP", name: "", shortcut: "", body: "", language: "ES" });
      if (data.brandWarnings?.length) {
        setMsg(`Guardada, pero ojo con la voz de marca: ${data.brandWarnings.join(", ")}`);
      } else setMsg("Plantilla creada ✓");
      load();
    } else {
      setMsg(mensajeDeError(data, "No se pudo crear la plantilla"));
    }
  }

  async function deleteTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    const ok = await confirmar({
      titulo: t ? `¿Eliminar la plantilla "${t.name}"?` : "¿Eliminar plantilla?",
      descripcion: "Se borra para siempre y no se puede recuperar. Los mensajes que ya enviaste con ella no cambian.",
      confirmar: "Eliminar",
      peligroso: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/profile/templates?id=${id}`, { method: "DELETE" });
    if (res.ok) toast({ title: "Plantilla eliminada" });
    else toast({ title: "No se pudo eliminar", description: await leerError(res), variant: "destructive" });
    load();
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: "var(--border-subtle)" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setMsg(""); }}
            className={cn("px-4 py-2 text-[13px] font-medium transition-colors -mb-px border-b-2")}
            style={{
              borderColor: tab === t.key ? "var(--color-teal)" : "transparent",
              color: tab === t.key ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className="rounded-lg px-3.5 py-2.5 text-[13px]" style={{ background: "var(--color-teal-light)", color: "var(--text-primary)" }}>
          {msg}
        </div>
      )}

      {/* ── Perfil ── */}
      {tab === "perfil" && (
        <div className="crm-card max-w-2xl space-y-4">
          <Field label="Puesto" error={fieldErrors.jobTitle}>
            <input className="form-input" value={profile.jobTitle ?? ""} onChange={(e) => set("jobTitle", e.target.value)} placeholder="Asesor Senior" />
          </Field>
          <Field label="Bio (español)" hint="Aparece en tu tarjeta digital" error={fieldErrors.bioEs}>
            <textarea className="form-input" rows={3} value={profile.bioEs ?? ""} onChange={(e) => set("bioEs", e.target.value)} />
          </Field>
          <Field label="Bio (inglés)" error={fieldErrors.bioEn}>
            <textarea className="form-input" rows={3} value={profile.bioEn ?? ""} onChange={(e) => set("bioEn", e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Teléfono directo" hint="Se guarda sin espacios; en tus fichas se muestra separado." error={fieldErrors.phoneDirect}>
              <input className="form-input" type="tel" inputMode="tel" autoComplete="tel" value={profile.phoneDirect ?? ""} onChange={(e) => set("phoneDirect", telefonoSinEspacios(e.target.value))} placeholder="+529841234567" />
            </Field>
            <Field label="WhatsApp" error={fieldErrors.whatsappNumber}>
              <input className="form-input" type="tel" inputMode="tel" value={profile.whatsappNumber ?? ""} onChange={(e) => set("whatsappNumber", telefonoSinEspacios(e.target.value))} placeholder="+529841234567" />
            </Field>
          </div>
          <Field label="Link de agenda" hint="Google Calendar (citas) o Calendly. Si lo dejas vacío no se modifica el que ya tengas." error={fieldErrors.calendarUrl}>
            <input className="form-input" value={profile.calendarUrl ?? ""} onChange={(e) => set("calendarUrl", e.target.value)} placeholder="https://calendar.app.google/..." />
          </Field>
          <button className="btn-primary" disabled={saving} onClick={() => save(["jobTitle", "bioEs", "bioEn", "phoneDirect", "whatsappNumber", "calendarUrl"])}>
            <Save className="h-4 w-4" /> Guardar perfil
          </button>
        </div>
      )}

      {/* ── Correo ── */}
      {tab === "correo" && (
        <div className="crm-card max-w-2xl space-y-4">
          <Field label="Tu correo de envío" hint="Debe terminar en @propyte.com. Tus correos saldrán con tu nombre desde esta dirección." error={fieldErrors.emailFromAlias}>
            <input className="form-input" value={profile.emailFromAlias ?? ""} onChange={(e) => set("emailFromAlias", e.target.value)} placeholder="tunombre@propyte.com" />
          </Field>
          <Field label="Firma del correo" hint="Se agrega al final de tus correos y secuencias automáticas. Acepta formato HTML." error={fieldErrors.emailSignatureHtml}>
            <textarea className="form-input font-mono text-[12px]" rows={8} value={profile.emailSignatureHtml ?? ""} onChange={(e) => set("emailSignatureHtml", e.target.value)} placeholder="<p>Nombre — Propyte</p>" />
          </Field>
          {profile.emailSignatureHtml && (
            <div>
              <p className="form-label">Vista previa</p>
              <div className="rounded-lg border p-4 text-sm" style={{ borderColor: "var(--border-default)" }} dangerouslySetInnerHTML={{ __html: profile.emailSignatureHtml }} />
            </div>
          )}
          <button className="btn-primary" disabled={saving} onClick={() => save(["emailFromAlias", "emailSignatureHtml"])}>
            <Save className="h-4 w-4" /> Guardar correo
          </button>
        </div>
      )}

      {/* ── Tarjeta ── */}
      {tab === "tarjeta" && (
        <div className="crm-card max-w-2xl space-y-4">
          <Field label="Dirección de tu tarjeta" hint="Solo minúsculas, números y guiones (ej. nombre-apellido). No se podrá cambiar una vez publicada, porque se imprime en el QR." error={fieldErrors.cardSlug}>
            <input className="form-input" value={profile.cardSlug ?? ""} onChange={(e) => set("cardSlug", e.target.value)} placeholder={suggestedSlug} />
          </Field>
          <button className="btn-primary" disabled={saving} onClick={() => save(["cardSlug"])}>
            <Save className="h-4 w-4" /> Guardar tarjeta
          </button>
          {profile.cardSlug && (
            <div className="space-y-3 border-t pt-4" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="flex flex-wrap items-center gap-3">
                <a href={`/t/${profile.cardSlug}`} target="_blank" className="btn-secondary text-[13px]">
                  <ExternalLink className="h-3.5 w-3.5" /> Ver tarjeta pública
                </a>
                <a href={`/t/${profile.cardSlug}/qr`} target="_blank" className="btn-secondary text-[13px]">
                  <QrCode className="h-3.5 w-3.5" /> QR para imprimir
                </a>
                <a href={`/t/${profile.cardSlug}/vcard`} className="btn-secondary text-[13px]">
                  Guardar contacto
                </a>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/t/${profile.cardSlug}/qr`} alt="QR" className="h-36 w-36 rounded-lg border" style={{ borderColor: "var(--border-default)" }} />
            </div>
          )}
        </div>
      )}

      {/* ── Google Workspace ── */}
      {tab === "google" && (
        <div className="crm-card max-w-2xl space-y-4">
          <div>
            <h3 className="text-[15px] font-medium text-[color:var(--text-primary)]">Google Workspace</h3>
            <p className="mt-1 text-[13px] text-[color:var(--text-secondary)]">
              Conecta tu cuenta de Gmail para enviar correos desde el CRM y registrar automáticamente tus conversaciones en el timeline de cada contacto.
            </p>
          </div>

          {gw?.connected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-md border p-3" style={{ borderColor: "var(--border-subtle)" }}>
                <div>
                  <p className="text-[13px] font-medium text-[color:var(--text-primary)]">
                    {gw.isValid === false ? "Reconexión requerida" : "Conectado"}
                  </p>
                  <p className="text-[12px] text-[color:var(--text-tertiary)]">{gw.googleEmail}</p>
                </div>
                {gw.isValid === false && (
                  <a className="btn-secondary text-[13px]" href="/api/google/oauth/connect">Reconectar</a>
                )}
              </div>
              <button className="btn-secondary text-[13px]" onClick={disconnectGoogle}>Desconectar</button>
            </div>
          ) : (
            <a className="btn-primary inline-flex text-[13px]" href="/api/google/oauth/connect">
              Conectar cuenta Gmail
            </a>
          )}
        </div>
      )}

      {/* ── Plantillas ── */}
      {tab === "plantillas" && plantillasCopilot && (
        <div className="flex max-w-3xl gap-1" role="tablist" aria-label="Tipo de plantillas">
          {SECCIONES_PLANTILLAS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={seccionPlantillas === s.key}
              onClick={() => { setSeccionPlantillas(s.key); setMsg(""); }}
              className="rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors"
              style={{
                borderColor: seccionPlantillas === s.key ? "var(--text-primary)" : "var(--border-default)",
                color: seccionPlantillas === s.key ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {tab === "plantillas" && plantillasCopilot && seccionPlantillas === "copilot" && (
        <div className="max-w-3xl space-y-2">
          <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
            Plantillas de la cadencia de nuevos que usa el Copilot. Son generales: las mismas para todo el equipo.
          </p>
          {plantillasCopilot}
        </div>
      )}

      {tab === "plantillas" && (!plantillasCopilot || seccionPlantillas === "mias") && (
        <div className="max-w-3xl space-y-4">
          <div className="crm-card space-y-3">
            <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>Nueva plantilla</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <select className="form-input" value={newTpl.channel} onChange={(e) => setNewTpl({ ...newTpl, channel: e.target.value })}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="EMAIL">Email</option>
                <option value="SMS">SMS</option>
              </select>
              <select className="form-input" value={newTpl.language} onChange={(e) => setNewTpl({ ...newTpl, language: e.target.value })}>
                <option value="ES">Español</option>
                <option value="EN">English</option>
              </select>
              <input className="form-input" placeholder="Nombre" value={newTpl.name} onChange={(e) => setNewTpl({ ...newTpl, name: e.target.value })} />
              <input className="form-input" placeholder="/atajo" value={newTpl.shortcut} onChange={(e) => setNewTpl({ ...newTpl, shortcut: e.target.value })} />
            </div>
            <textarea
              className="form-input"
              rows={3}
              placeholder="Hola {{contact.firstName}}, soy {{user.name}} de Propyte..."
              value={newTpl.body}
              onChange={(e) => setNewTpl({ ...newTpl, body: e.target.value })}
            />
            <p className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
              Variables: {"{{contact.firstName}} {{contact.lastName}} {{user.name}} {{card.url}}"}
            </p>
            <button className="btn-primary" onClick={createTemplate}>
              <Plus className="h-4 w-4" /> Crear plantilla
            </button>
          </div>

          <div className="space-y-2">
            {templates.map((t) => (
              <div key={t.id} className="crm-card !p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>{t.name}</span>
                    <span className="badge badge-neutral">{etiqueta(CHANNEL_LABELS_PLANTILLA, t.channel)}</span>
                    <span className="badge badge-neutral">{etiqueta(PREFERRED_LANGUAGE_LABELS, t.language)}</span>
                    {t.shortcut && <span className="badge badge-teal">{t.shortcut}</span>}
                    {t.isGlobal && <span className="badge badge-neutral">Marca</span>}
                  </div>
                  <p className="mt-1 truncate text-[12px]" style={{ color: "var(--text-secondary)" }}>{t.body}</p>
                </div>
                {!t.isGlobal && (
                  <button className="shrink-0" title="Eliminar" onClick={() => deleteTemplate(t.id)}>
                    <Trash2 className="h-4 w-4" style={{ color: "var(--text-tertiary)" }} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
