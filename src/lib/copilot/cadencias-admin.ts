// #993 — Lo que lee y escribe el módulo «Cadencias» (Desempeño): resumen del catálogo, detalle de
// una cadencia con sus contactos, y edición de la cadencia y de sus pasos. Los permisos los revisa
// quien llama (CADENCIAS_ROLES en lib/copilot/roles.ts).
import prisma from "@/lib/db";
import { cargarCatalogo, pasoDeFila, type CadenciaGuardada, type PasoGuardado } from "./catalogo";
import { validarPaso, type PasoDef } from "./cadencias-def";

export interface ResumenCadencia {
  def: CadenciaGuardada;
  activas: number;
  pausadas: number;
  terminadas: Record<string, number>;
}

export interface ResumenModulo {
  cadencias: ResumenCadencia[];
  /** Respuestas clasificadas por resultado, y las que esperan. */
  clasificaciones: Record<string, number>;
  porClasificar: number;
}

export async function resumenCadencias(): Promise<ResumenModulo> {
  const catalogo = await cargarCatalogo();
  const [porEstado, porMotivo, clas] = await Promise.all([
    prisma.copilotCadencia.groupBy({ by: ["tipo", "estado"], _count: { _all: true } }),
    prisma.copilotCadencia.groupBy({ by: ["tipo", "motivoFin"], where: { estado: "TERMINADA" }, _count: { _all: true } }),
    prisma.copilotClasificacion.groupBy({ by: ["resultado"], _count: { _all: true } }),
  ]);
  const cadencias = [...catalogo.values()].map((def) => {
    const terminadas: Record<string, number> = {};
    for (const m of porMotivo.filter((x) => x.tipo === def.tipo)) terminadas[m.motivoFin ?? "—"] = m._count._all;
    return {
      def,
      activas: porEstado.find((x) => x.tipo === def.tipo && x.estado === "ACTIVA")?._count._all ?? 0,
      pausadas: porEstado.find((x) => x.tipo === def.tipo && x.estado === "PAUSADA")?._count._all ?? 0,
      terminadas,
    };
  });
  const clasificaciones: Record<string, number> = {};
  let porClasificar = 0;
  for (const c of clas) {
    if (c.resultado) clasificaciones[c.resultado] = c._count._all;
    else porClasificar = c._count._all;
  }
  return { cadencias, clasificaciones, porClasificar };
}

export interface ContactoEnCadencia {
  contactId: string;
  nombre: string;
  asesor: string | null;
  estado: string;
  desde: string;
  pendientes: number;
  vencidos: number;
}

/** Contactos que van hoy en la cadencia (activa o en pausa), con su asesor. Hasta 200. */
export async function contactosEnCadencia(tipo: string, ahora: Date = new Date()): Promise<ContactoEnCadencia[]> {
  const ks = await prisma.copilotCadencia.findMany({
    where: { tipo, estado: { in: ["ACTIVA", "PAUSADA"] } },
    orderBy: { inicio: "desc" },
    take: 200,
  });
  if (ks.length === 0) return [];
  const [contactos, toques] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: ks.map((k) => k.contactId) } },
      select: { id: true, firstName: true, lastName: true, assignedTo: { select: { name: true } } },
    }),
    prisma.copilotToque.findMany({ where: { cadenciaId: { in: ks.map((k) => k.id) }, resultado: null }, select: { cadenciaId: true, programadoAt: true } }),
  ]);
  const con = new Map(contactos.map((c) => [c.id, c]));
  const limite = ahora.getTime() - 24 * 3_600_000;
  return ks.map((k) => {
    const c = con.get(k.contactId);
    const mios = toques.filter((t) => t.cadenciaId === k.id);
    return {
      contactId: k.contactId,
      nombre: c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Sin nombre" : "Contacto",
      asesor: c?.assignedTo?.name ?? null,
      estado: k.estado,
      desde: k.inicio.toISOString(),
      pendientes: mios.length,
      vencidos: mios.filter((t) => new Date(t.programadoAt).getTime() <= limite).length,
    };
  });
}

// ───────────────────────────── edición ─────────────────────────────

export type Resultado<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface CambiosCadencia {
  nombre?: string;
  descripcion?: string;
  activa?: boolean;
  finDias?: number;
}

export async function actualizarCadencia(tipo: string, cambios: CambiosCadencia, usuarioId: string): Promise<Resultado<CadenciaGuardada>> {
  const def = await prisma.copilotCadenciaDef.findUnique({ where: { tipo } });
  if (!def) return { ok: false, status: 404, error: "La cadencia no existe" };
  if (cambios.nombre !== undefined && !cambios.nombre.trim()) return { ok: false, status: 400, error: "El nombre no puede quedar vacío" };
  if (cambios.finDias !== undefined && (!Number.isInteger(cambios.finDias) || cambios.finDias < 1 || cambios.finDias > 730)) {
    return { ok: false, status: 400, error: "El plazo va de 1 a 730 días" };
  }
  await prisma.copilotCadenciaDef.update({
    where: { tipo },
    data: {
      ...(cambios.nombre !== undefined ? { nombre: cambios.nombre.trim() } : {}),
      ...(cambios.descripcion !== undefined ? { descripcion: cambios.descripcion.trim() } : {}),
      ...(cambios.activa !== undefined ? { activa: cambios.activa } : {}),
      ...(cambios.finDias !== undefined ? { finDias: cambios.finDias } : {}),
      updatedAt: new Date(),
      updatedById: usuarioId,
    },
  });
  const catalogo = await cargarCatalogo();
  return { ok: true, data: catalogo.get(tipo)! };
}

/** Normaliza lo que llega del editor a un PasoDef completo. */
function pasoDeEntrada(x: Partial<PasoDef>): PasoDef {
  return {
    codigo: String(x.codigo ?? "").trim().toUpperCase(),
    canal: x.canal as PasoDef["canal"],
    offset: Number(x.offset),
    unidad: x.unidad as PasoDef["unidad"],
    ancla: (x.ancla ?? "CADENCIA") as PasoDef["ancla"],
    plantilla: x.plantilla ? String(x.plantilla).trim() : null,
    paises: (x.paises ?? []) as PasoDef["paises"],
    whatsapp: (x.whatsapp ?? "SIEMPRE") as PasoDef["whatsapp"],
    cuando: String(x.cuando ?? "").trim(),
    nota: x.nota ? String(x.nota).trim() : null,
    orden: Number.isInteger(x.orden) ? Number(x.orden) : 0,
    activo: x.activo ?? true,
  };
}

async function validarConPlantillas(p: PasoDef): Promise<string[]> {
  const errores = validarPaso(p);
  if (p.plantilla) {
    const existe = await prisma.copilotPlantilla.findFirst({ where: { codigo: p.plantilla }, select: { id: true } });
    if (!existe) errores.push(`No existe la plantilla «${p.plantilla}» (Mi Configuración → Plantillas).`);
  }
  return errores;
}

export async function crearPaso(tipo: string, entrada: Partial<PasoDef>, usuarioId: string): Promise<Resultado<PasoGuardado>> {
  const def = await prisma.copilotCadenciaDef.findUnique({ where: { tipo }, select: { tipo: true } });
  if (!def) return { ok: false, status: 404, error: "La cadencia no existe" };
  const p = pasoDeEntrada(entrada);
  if (!p.orden) {
    const ultimo = await prisma.copilotCadenciaPaso.findFirst({ where: { tipo }, orderBy: { orden: "desc" }, select: { orden: true } });
    p.orden = (ultimo?.orden ?? 0) + 10;
  }
  const errores = await validarConPlantillas(p);
  if (errores.length > 0) return { ok: false, status: 400, error: errores.join(" ") };
  const fila = await prisma.copilotCadenciaPaso.create({
    data: { tipo, ...p, paises: p.paises, updatedById: usuarioId },
  });
  return { ok: true, data: pasoDeFila(fila) };
}

export async function actualizarPaso(tipo: string, id: string, entrada: Partial<PasoDef>, usuarioId: string): Promise<Resultado<PasoGuardado>> {
  const actual = await prisma.copilotCadenciaPaso.findUnique({ where: { id } });
  if (!actual || actual.tipo !== tipo) return { ok: false, status: 404, error: "El paso no existe" };
  const p = pasoDeEntrada({ ...pasoDeFila(actual), ...entrada });
  const errores = await validarConPlantillas(p);
  if (errores.length > 0) return { ok: false, status: 400, error: errores.join(" ") };
  const fila = await prisma.copilotCadenciaPaso.update({
    where: { id },
    data: { ...p, updatedAt: new Date(), updatedById: usuarioId },
  });
  return { ok: true, data: pasoDeFila(fila) };
}

export async function borrarPaso(tipo: string, id: string): Promise<Resultado<null>> {
  const actual = await prisma.copilotCadenciaPaso.findUnique({ where: { id }, select: { tipo: true } });
  if (!actual || actual.tipo !== tipo) return { ok: false, status: 404, error: "El paso no existe" };
  await prisma.copilotCadenciaPaso.delete({ where: { id } });
  return { ok: true, data: null };
}
