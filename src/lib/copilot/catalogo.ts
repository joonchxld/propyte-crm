// #993 — Lee el catálogo de cadencias de la base (copilot_cadencia_defs + copilot_cadencia_pasos)
// con la forma de cadencias-def.ts. Lo usan el cron, Mi día, la ficha y el módulo Cadencias.
import prisma from "@/lib/db";
import type { Canal, Pais } from "./cadencia-nuevos";
import type { AnclaCadencia, AnclaPaso, CadenciaDef, CondicionWhatsApp, PasoDef, Unidad } from "./cadencias-def";

export interface PasoGuardado extends PasoDef {
  id: string;
  /** Un paso nuevo no aplica a toques que ya debieron salir antes de crearlo. */
  createdAt: Date;
}
export interface CadenciaGuardada extends Omit<CadenciaDef, "pasos"> {
  pasos: PasoGuardado[];
  updatedAt: Date;
}

type FilaDef = Awaited<ReturnType<typeof prisma.copilotCadenciaDef.findMany>>[number];
type FilaPaso = Awaited<ReturnType<typeof prisma.copilotCadenciaPaso.findMany>>[number];

export function pasoDeFila(p: FilaPaso): PasoGuardado {
  return {
    id: p.id,
    codigo: p.codigo,
    canal: p.canal as Canal,
    offset: p.offset,
    unidad: p.unidad as Unidad,
    ancla: p.ancla as AnclaPaso,
    plantilla: p.plantilla,
    paises: p.paises as Pais[],
    whatsapp: p.whatsapp as CondicionWhatsApp,
    cuando: p.cuando,
    nota: p.nota,
    orden: p.orden,
    activo: p.activo,
    createdAt: p.createdAt,
  };
}

export function defDeFila(d: FilaDef, pasos: FilaPaso[]): CadenciaGuardada {
  return {
    tipo: d.tipo,
    nombre: d.nombre,
    rama: d.rama,
    descripcion: d.descripcion,
    disparador: d.disparador,
    anclaTipo: d.anclaTipo as AnclaCadencia,
    estados: d.estados,
    respuestaTermina: d.respuestaTermina,
    terminaConCita: d.terminaConCita,
    ignoraNoContactar: d.ignoraNoContactar,
    finDias: d.finDias,
    finAncla: d.finAncla as AnclaPaso,
    fin: { estado: d.finEstado, subestado: d.finSubestado, razon: d.finRazon, siguiente: d.finSiguiente },
    activa: d.activa,
    orden: d.orden,
    updatedAt: d.updatedAt,
    pasos: pasos.filter((p) => p.tipo === d.tipo).sort((a, b) => a.orden - b.orden).map(pasoDeFila),
  };
}

/** El catálogo completo, por tipo. */
export async function cargarCatalogo(): Promise<Map<string, CadenciaGuardada>> {
  const [defs, pasos] = await Promise.all([
    prisma.copilotCadenciaDef.findMany({ orderBy: { orden: "asc" } }),
    prisma.copilotCadenciaPaso.findMany({ orderBy: [{ tipo: "asc" }, { orden: "asc" }] }),
  ]);
  return new Map(defs.map((d) => [d.tipo, defDeFila(d, pasos)]));
}

/** Códigos de plantilla que existen (para la plantilla por fuente y para avisar en el editor). */
export async function codigosDePlantillas(): Promise<Set<string>> {
  const filas = await prisma.copilotPlantilla.findMany({ select: { codigo: true }, distinct: ["codigo"] });
  return new Set(filas.map((f) => f.codigo));
}
