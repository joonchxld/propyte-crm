// #988 / #993 — Las cadencias de Copilot contra la base: el tick del cron, el resultado que marca
// el asesor, la clasificación de respuestas, «Mi día», la ficha y el tablero de vencidas.
//
// Qué hace cada parte:
//   - El disparador trg_contacts_zz_copilot_cadencia (migraciones 2026-11-05 y 2026-11-09):
//       - inscribe en la cadencia general al llegar a Nuevo o Sin respuesta;
//       - termina cualquier cadencia cuando el contacto sale de los estados de esa cadencia.
//     Así cubre todas las vías que escriben contactos.
//   - El catálogo (copilot_cadencia_defs + pasos, módulo Cadencias) dice qué toques lleva cada
//     una; motor.ts lo convierte en toques por contacto.
//   - El cron de workflows, cada minuto (etapa «cadencias», tickCadencias):
//       1. crea los toques que ya llegaron;
//       2. detecta respuestas. En las cadencias que se detienen con la respuesta, la cadencia se
//          PAUSA y queda una tarea «Clasificar respuesta» (R2); en la general, además, el contacto
//          pasa a Contactado · En conversación. Detecta también el primer intento del asesor
//          (Nuevo → Sin respuesta) y la cita creada en «Agendar cita»;
//       3. cierra las cadencias que pasaron su plazo. Aplica su salida (p. ej. Perdido · Sin
//          respuesta tras cadencia) y abre la siguiente (p. ej. Nutrición);
//       4. a las 24 h sin marcar, avisa al gerente (una vez por toque).
//   - clasificar(): el botón que elige el asesor fija estado, subestado y razón, y abre la cadencia
//     de la rama (clasificacion.ts).
//
// Los cambios de estado llevan la fuente copilot_cadencia en la cronología.
import prisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import { setChangeSource, type PrismaTx } from "@/lib/audit/change-context";
import { normalizePhoneE164 } from "@/lib/phone";
import { mandoWhere, esCuentaTecnica } from "@/lib/workflows/ruteables";
import {
  TOPE_TAREAS_DIA,
  VENCIDA_MS,
  esIntento,
  esResultadoDelCanal,
  esRespuesta,
  fechaCancun,
  horaCancun,
  paisDeTelefono,
} from "./cadencia-nuevos";
import { esGeneral, type AnclaCadencia } from "./cadencias-def";
import { cargarCatalogo, codigosDePlantillas, type CadenciaGuardada } from "./catalogo";
import { finDeCadencia, planDeCadencia, type ContextoContacto } from "./motor";
import {
  CLASIFICACIONES,
  DIAS_POSPUSO_POR_DEFECTO,
  esReactivacion,
  esResultadoClasificacion,
  fechaRecontactoValida,
  type ResultadoClasificacion,
} from "./clasificacion";
import { armarTareas, fechaDe, ordenarMiDia, type MiDia, type TareaLista } from "./mi-dia";
import type { Plantilla } from "./plantillas";

export const FUENTE_CAMBIO_CADENCIA = "copilot_cadencia";
const ESTADOS_GENERAL = ["NUEVO", "SIN_RESPUESTA"];

type FilaCadencia = Awaited<ReturnType<typeof prisma.copilotCadencia.findMany>>[number];

function anclaDe(k: Pick<FilaCadencia, "anclaAt" | "inicio">): Date {
  return new Date(k.anclaAt ?? k.inicio);
}

function fechaIso(d: Date | null | undefined): string | null {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

// ───────────────────────────── contexto del contacto ─────────────────────────────

const SELECT_CONTEXTO = {
  id: true,
  phone: true,
  leadSource: true,
  whatsappOptOut: true,
  fechaRecontacto: true,
  estado: true,
  doNotContact: true,
} satisfies Prisma.ContactSelect;
type FilaContexto = Prisma.ContactGetPayload<{ select: typeof SELECT_CONTEXTO }>;

/** ¿El lead ya escribió por WhatsApp? (EE. UU.: sin eso Meta no deja escribirle). */
async function conWhatsAppAbierto(contactIds: string[]): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();
  const filas = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT m."contactId" AS id FROM "propyte_crm"."messages" m
     WHERE m."contactId" = ANY(${contactIds}::text[]) AND m."direction" = 'INBOUND' AND m."channel"::text = 'WHATSAPP'`;
  return new Set(filas.map((f) => f.id));
}

function contextoDe(c: FilaContexto, waAbierto: boolean): ContextoContacto {
  return {
    pais: paisDeTelefono(normalizePhoneE164(c.phone)),
    waAbierto,
    whatsappOptOut: !!c.whatsappOptOut,
    fechaRecontacto: fechaIso(c.fechaRecontacto),
    fuente: (c.leadSource as string | null) ?? null,
  };
}

// ───────────────────────────── 1. crear los toques que ya llegaron ─────────────────────────────

/**
 * Crea los toques cuyo momento ya llegó. Idempotente (único por cadencia y código). Con
 * `contactIds` solo esos (lo usan Mi día y la ficha al abrir, para no esperar al cron).
 */
export async function materializarCadencias(
  opts: { ahora?: Date; limite?: number; contactIds?: string[]; catalogo?: Map<string, CadenciaGuardada> } = {},
): Promise<{ cadencias: number; toques: number }> {
  const ahora = opts.ahora ?? new Date();
  const activas = await prisma.copilotCadencia.findMany({
    where: { estado: "ACTIVA", ...(opts.contactIds ? { contactId: { in: opts.contactIds } } : {}) },
    orderBy: { inicio: "asc" },
    take: opts.contactIds ? undefined : opts.limite ?? 500,
  });
  if (activas.length === 0) return { cadencias: 0, toques: 0 };

  const [catalogo, codigos, contactos] = await Promise.all([
    opts.catalogo ? Promise.resolve(opts.catalogo) : cargarCatalogo(),
    codigosDePlantillas(),
    prisma.contact.findMany({ where: { id: { in: activas.map((k) => k.contactId) } }, select: SELECT_CONTEXTO }),
  ]);
  const porId = new Map(contactos.map((c) => [c.id, c]));
  const wa = await conWhatsAppAbierto(contactos.map((c) => c.id));

  let toques = 0;
  let cadencias = 0;
  for (const k of activas) {
    const def = catalogo.get(k.tipo);
    const c = porId.get(k.contactId);
    if (!def || !c) continue;
    const plan = planDeCadencia(def, def.pasos, contextoDe(c, wa.has(c.id)), anclaDe(k), codigos).filter(
      (t) => t.programadoAt.getTime() <= ahora.getTime(),
    );
    if (plan.length === 0) continue;
    const r = await prisma.copilotToque.createMany({
      data: plan.map((t) => ({
        cadenciaId: k.id,
        contactId: k.contactId,
        dia: t.dia,
        fecha: new Date(`${t.fecha}T00:00:00Z`),
        codigo: t.codigo,
        canal: t.canal,
        orden: t.orden,
        plantilla: t.plantilla,
        cuando: t.cuando,
        nota: t.nota,
        programadoAt: t.programadoAt,
        createdAt: t.programadoAt,
      })),
      skipDuplicates: true,
    });
    if (r.count > 0) cadencias++;
    toques += r.count;
  }
  return { cadencias, toques };
}

// ───────────────────────────── inscribir, pausar, cerrar ─────────────────────────────

/** Abre una cadencia. No hace nada si ya hay una activa o si la cadencia está apagada en el módulo. */
async function inscribir(
  tx: PrismaTx,
  catalogo: Map<string, CadenciaGuardada>,
  opts: { contactId: string; tipo: string; anclaAt: Date; anclaTipo: AnclaCadencia; origenId?: string | null; ahora: Date },
): Promise<string | null> {
  const def = catalogo.get(opts.tipo);
  if (!def || !def.activa) return null;
  const c = await tx.contact.findUnique({ where: { id: opts.contactId }, select: { estado: true, doNotContact: true, deletedAt: true } });
  if (!c || c.deletedAt) return null;
  if (!def.estados.includes(String(c.estado))) return null;
  if (c.doNotContact && !def.ignoraNoContactar) return null;
  const ya = await tx.copilotCadencia.findFirst({ where: { contactId: opts.contactId, estado: "ACTIVA" }, select: { id: true } });
  if (ya) return null;
  const k = await tx.copilotCadencia.create({
    data: {
      contactId: opts.contactId,
      tipo: opts.tipo,
      inicio: opts.ahora,
      diaInicio: new Date(`${fechaCancun(opts.anclaAt)}T00:00:00Z`),
      horaEntrada: horaCancun(opts.anclaAt),
      anclaAt: opts.anclaAt,
      anclaTipo: opts.anclaTipo,
      origenId: opts.origenId ?? null,
    },
  });
  return k.id;
}

/** Pausa la cadencia por respuesta y deja la tarea «Clasificar respuesta». */
async function pausarPorRespuesta(tx: PrismaTx, k: Pick<FilaCadencia, "id" | "contactId" | "tipo">, respuestaAt: Date): Promise<void> {
  const c = await tx.contact.findUnique({ where: { id: k.contactId }, select: { estado: true, subestado: true } });
  await tx.copilotCadencia.update({ where: { id: k.id }, data: { estado: "PAUSADA", respuestaAt } });
  const pendiente = await tx.copilotClasificacion.findFirst({ where: { contactId: k.contactId, resultado: null }, select: { id: true } });
  if (!pendiente) {
    await tx.copilotClasificacion.create({
      data: {
        contactId: k.contactId,
        cadenciaId: k.id,
        respuestaAt,
        estadoAntes: (c?.estado as string | null) ?? null,
        subestadoAntes: c?.subestado ?? null,
      },
    });
  }
  // Flujograma: con cualquier respuesta a la cadencia general, el contacto pasa a Contactado.
  if (esGeneral(k.tipo)) {
    await tx.contact.updateMany({
      where: { id: k.contactId, estado: { in: ESTADOS_GENERAL as never } },
      data: { estado: "CONTACTADO" as never, subestado: "EN_CONVERSACION" },
    });
  }
}

/** Nuevo → Sin respuesta en cuanto hay un primer intento (flujograma). */
async function pasarASinRespuesta(tx: PrismaTx, contactId: string): Promise<void> {
  await tx.contact.updateMany({
    where: { id: contactId, estado: "NUEVO" as never },
    data: { estado: "SIN_RESPUESTA" as never, subestado: null },
  });
}

/** Cierra una cadencia: lo pendiente se borra (o queda como «no se hizo» si cerró por plazo). */
async function cerrar(tx: PrismaTx, kId: string, motivo: string, ahora: Date, pendientes: "borrar" | "no_hecho"): Promise<void> {
  if (pendientes === "borrar") await tx.copilotToque.deleteMany({ where: { cadenciaId: kId, resultado: null } });
  else await tx.copilotToque.updateMany({ where: { cadenciaId: kId, resultado: null }, data: { resultado: "NO_HECHO", resultadoAt: ahora } });
  await tx.copilotCadencia.update({ where: { id: kId }, data: { estado: "TERMINADA", motivoFin: motivo, finAt: ahora } });
}

// ───────────────────────────── 2. respuestas, intentos y citas ─────────────────────────────

interface FilaSenal {
  id: string;
  contactId: string;
  tipo: string;
  primerIntentoAt: Date | null;
  respuestaAt: Date | null;
  estado: string | null;
}

/**
 * Primer intento y primera respuesta de cada cadencia activa que se detiene con la respuesta, en
 * una consulta.
 *
 * Intento (solo importa en la general): un toque marcado, o un mensaje, llamada, WhatsApp, SMS o
 * correo que el asesor mandó desde el CRM después de que entró.
 *
 * Respuesta (la misma lista que la temperatura, #973):
 *   - un mensaje o actividad entrante después de la «marca de agua». En la general la marca es el
 *     primer intento, porque antes de eso lo que escribió es con lo que llegó o la plática con el
 *     bot; en las ramas es el inicio de la cadencia; y si el asesor dijo «no era respuesta», es ese
 *     momento;
 *   - en cualquier momento desde la marca: una llamada entrante, un walk-in o una llamada nuestra
 *     de 30 s o más.
 */
async function senalesDeCadencias(): Promise<FilaSenal[]> {
  return prisma.$queryRaw<FilaSenal[]>`
    WITH k AS (
      SELECT k."id", k."contactId", k."tipo", k."inicio", k."ignorarAntesDe",
        LEAST(
          k."primerIntentoAt",
          (SELECT min(m."createdAt") FROM "propyte_crm"."messages" m
            WHERE m."contactId" = k."contactId" AND m."direction" = 'OUTBOUND' AND m."sender"::text = 'ADVISOR'
              AND m."createdAt" > k."inicio"),
          (SELECT min(a."createdAt") FROM "propyte_crm"."activities" a
            WHERE a."contactId" = k."contactId" AND a."deletedAt" IS NULL AND a."createdAt" > k."inicio"
              AND a."activityType"::text = ANY(ARRAY['CALL_OUTBOUND','WHATSAPP_OUT','SMS_OUT','EMAIL_SENT','INSTAGRAM_OUT','MESSENGER_OUT']::text[]))
        ) AS "primerIntentoAt"
      FROM "propyte_crm"."copilot_cadencias" k
      JOIN "propyte_crm"."copilot_cadencia_defs" d ON d."tipo" = k."tipo" AND d."respuestaTermina"
      WHERE k."estado" = 'ACTIVA'
    ),
    m AS (
      SELECT k.*,
        CASE WHEN k."tipo" IN ('NUEVOS', 'BASE_DE_DATOS') THEN k."primerIntentoAt" ELSE k."inicio" END AS marca_texto,
        GREATEST(k."inicio", k."ignorarAntesDe") AS marca_llamada
      FROM k
    )
    SELECT m."id", m."contactId", m."tipo", m."primerIntentoAt", c."estado"::text AS "estado",
      LEAST(
        (SELECT min(x."createdAt") FROM "propyte_crm"."messages" x
          WHERE x."contactId" = m."contactId" AND x."direction" = 'INBOUND' AND coalesce(x."internalNote", false) = false
            AND m.marca_texto IS NOT NULL AND x."createdAt" > GREATEST(m.marca_texto, m."ignorarAntesDe")),
        (SELECT min(a."createdAt") FROM "propyte_crm"."activities" a
          WHERE a."contactId" = m."contactId" AND a."deletedAt" IS NULL AND a."status"::text <> 'CANCELADA'
            AND (
              (a."activityType"::text = ANY(ARRAY['CALL_INBOUND','WALK_IN']::text[]) AND a."createdAt" > m.marca_llamada)
              OR (a."activityType"::text = 'CALL_OUTBOUND' AND coalesce(a."duration_seconds", 0) >= 30 AND a."createdAt" > m.marca_llamada)
              OR (a."activityType"::text = ANY(ARRAY['WHATSAPP_IN','SMS_IN','EMAIL_RECEIVED','INSTAGRAM_IN','MESSENGER_IN']::text[])
                  AND m.marca_texto IS NOT NULL AND a."createdAt" > GREATEST(m.marca_texto, m."ignorarAntesDe"))))
      ) AS "respuestaAt"
    FROM m JOIN "propyte_crm"."contacts" c ON c."id" = m."contactId"`;
}

/** Cadencias activas que terminan con una cita (Agendar) y ya tienen una creada después de empezar. */
async function cadenciasConCita(): Promise<{ id: string; contactId: string }[]> {
  return prisma.$queryRaw<{ id: string; contactId: string }[]>`
    SELECT k."id", k."contactId"
      FROM "propyte_crm"."copilot_cadencias" k
      JOIN "propyte_crm"."copilot_cadencia_defs" d ON d."tipo" = k."tipo" AND d."terminaConCita"
     WHERE k."estado" = 'ACTIVA'
       AND EXISTS (SELECT 1 FROM "propyte_crm"."activities" a
                    WHERE a."contactId" = k."contactId" AND a."deletedAt" IS NULL AND a."status"::text <> 'CANCELADA'
                      AND a."createdAt" > k."inicio"
                      AND a."activityType"::text = ANY(ARRAY['MEETING_VIRTUAL','MEETING_PRESENTIAL','MEETING_SHOWROOM','DISCOVERY_CALL']::text[]))`;
}

export async function detectarRespuestas(ahora: Date = new Date()): Promise<{ respondieron: number; aSinRespuesta: number; conCita: number }> {
  const filas = await senalesDeCadencias();
  let respondieron = 0;
  let aSinRespuesta = 0;
  for (const f of filas) {
    if (f.respuestaAt) {
      await prisma.$transaction(async (tx) => {
        await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA });
        await pausarPorRespuesta(tx, f, f.respuestaAt!);
      });
      respondieron++;
      continue;
    }
    if (f.primerIntentoAt && esGeneral(f.tipo)) {
      await prisma.$transaction(async (tx) => {
        await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA });
        await tx.copilotCadencia.updateMany({ where: { id: f.id, primerIntentoAt: null }, data: { primerIntentoAt: f.primerIntentoAt } });
        if (f.estado === "NUEVO") {
          await pasarASinRespuesta(tx, f.contactId);
          aSinRespuesta++;
        }
      });
    }
  }
  // Rama A: la cita creada cierra «Agendar cita» y el contacto pasa a Reunión · Agendada.
  const citas = await cadenciasConCita();
  for (const k of citas) {
    await prisma.$transaction(async (tx) => {
      await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA });
      await cerrar(tx, k.id, "CITA_AGENDADA", ahora, "borrar");
      await tx.contact.updateMany({
        where: { id: k.contactId, estado: "CONTACTADO" as never },
        data: { estado: "REUNION" as never, subestado: "AGENDADA" },
      });
    });
  }
  return { respondieron, aSinRespuesta, conCita: citas.length };
}

// ───────────────────────────── 3. fin por plazo ─────────────────────────────

/** Última respuesta del lead (ancla de «Dejó de responder»). */
async function ultimoInbound(contactId: string): Promise<Date | null> {
  const [f] = await prisma.$queryRaw<{ at: Date | null }[]>`
    SELECT max(m."createdAt") AS at FROM "propyte_crm"."messages" m
     WHERE m."contactId" = ${contactId} AND m."direction" = 'INBOUND' AND coalesce(m."internalNote", false) = false`;
  return f?.at ? new Date(f.at) : null;
}

/** Las cadencias que pasaron su plazo: aplican su salida y abren la siguiente. */
export async function terminarCadenciasVencidas(
  ahora: Date = new Date(),
  catalogoDado?: Map<string, CadenciaGuardada>,
): Promise<{ terminadas: number; cambiosDeEstado: number; siguientes: number }> {
  const activas = await prisma.copilotCadencia.findMany({ where: { estado: "ACTIVA" } });
  if (activas.length === 0) return { terminadas: 0, cambiosDeEstado: 0, siguientes: 0 };
  const catalogo = catalogoDado ?? (await cargarCatalogo());
  const contactos = await prisma.contact.findMany({
    where: { id: { in: activas.map((k) => k.contactId) } },
    select: { id: true, fechaRecontacto: true },
  });
  const fechas = new Map(contactos.map((c) => [c.id, fechaIso(c.fechaRecontacto)]));

  let terminadas = 0;
  let cambiosDeEstado = 0;
  let siguientes = 0;
  for (const k of activas) {
    const def = catalogo.get(k.tipo);
    if (!def) continue;
    const fin = finDeCadencia(def, anclaDe(k), fechas.get(k.contactId) ?? null);
    if (ahora.getTime() < fin.getTime()) continue;
    const sig = def.fin.siguiente ? catalogo.get(def.fin.siguiente) : null;
    const anclaSiguiente =
      sig?.anclaTipo === "ULTIMO_INBOUND" ? (await ultimoInbound(k.contactId)) ?? fin : sig?.anclaTipo === "FIN_CADENCIA" ? fin : ahora;
    const r = await prisma.$transaction(async (tx) => {
      await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA });
      await cerrar(tx, k.id, "SIN_RESPUESTA", ahora, "no_hecho");
      let movido = 0;
      if (def.fin.estado) {
        const u = await tx.contact.updateMany({
          where: { id: k.contactId, estado: { in: def.estados as never } },
          data: { estado: def.fin.estado as never, subestado: def.fin.subestado, razonSalida: (def.fin.razon ?? null) as never },
        });
        movido = u.count;
      }
      const nueva = sig
        ? await inscribir(tx, catalogo, { contactId: k.contactId, tipo: sig.tipo, anclaAt: anclaSiguiente, anclaTipo: sig.anclaTipo, origenId: k.id, ahora })
        : null;
      return { movido, nueva };
    });
    terminadas++;
    cambiosDeEstado += r.movido;
    if (r.nueva) siguientes++;
  }
  return { terminadas, cambiosDeEstado, siguientes };
}

// ───────────────────────────── 4. aviso de vencidas al gerente ─────────────────────────────

/** A quién se le avisa de las vencidas de un asesor: su líder, o la gerencia de su plaza. */
async function mandosDe(asesor: { id: string; teamLeaderId: string | null; plaza: string | null }): Promise<string[]> {
  if (asesor.teamLeaderId && asesor.teamLeaderId !== asesor.id) return [asesor.teamLeaderId];
  const base = { ...mandoWhere(), id: { not: asesor.id } };
  for (const where of [
    { ...base, role: "GERENTE" as never, ...(asesor.plaza ? { plaza: asesor.plaza as never } : {}) },
    { ...base, role: "DIRECTOR" as never, ...(asesor.plaza ? { plaza: asesor.plaza as never } : {}) },
    { ...base, role: "GERENTE" as never },
    base,
  ]) {
    const us = await prisma.user.findMany({ where, select: { id: true } });
    if (us.length > 0) return us.map((u) => u.id);
  }
  return [];
}

export async function avisarVencidas(ahora: Date = new Date()): Promise<{ avisos: number; toques: number }> {
  const limite = new Date(ahora.getTime() - VENCIDA_MS);
  const vencidos = await prisma.$queryRaw<{ id: string; cadenciaId: string; fecha: Date; asesorId: string | null }[]>`
    SELECT t."id", t."cadenciaId", t."fecha", c."assignedToId" AS "asesorId"
      FROM "propyte_crm"."copilot_toques" t
      JOIN "propyte_crm"."copilot_cadencias" k ON k."id" = t."cadenciaId" AND k."estado" = 'ACTIVA'
      JOIN "propyte_crm"."contacts" c ON c."id" = t."contactId"
     WHERE t."resultado" IS NULL AND t."avisoVencidaAt" IS NULL AND t."programadoAt" <= ${limite}
     LIMIT 1000`;
  if (vencidos.length === 0) return { avisos: 0, toques: 0 };

  const porAsesor = new Map<string, Set<string>>();
  for (const v of vencidos) {
    if (!v.asesorId) continue;
    const g = porAsesor.get(v.asesorId) ?? new Set<string>();
    g.add(`${v.cadenciaId}:${fechaDe(v.fecha)}`);
    porAsesor.set(v.asesorId, g);
  }
  const asesores = await prisma.user.findMany({
    where: { id: { in: [...porAsesor.keys()] } },
    select: { id: true, name: true, email: true, teamLeaderId: true, plaza: true },
  });

  let avisos = 0;
  for (const a of asesores) {
    // Cuentas técnicas (.local): nadie las abre; avisar solo llenaría la campana (#734, #756).
    if (esCuentaTecnica(a.email)) continue;
    const n = porAsesor.get(a.id)?.size ?? 0;
    if (n === 0) continue;
    const destinatarios = await mandosDe({ id: a.id, teamLeaderId: a.teamLeaderId, plaza: a.plaza as string | null });
    if (destinatarios.length === 0) continue;
    await prisma.notification.createMany({
      data: destinatarios.map((userId) => ({
        userId,
        type: "copilot_vencida",
        title: "Mi día: tareas vencidas",
        message: `${a.name} tiene ${n} ${n === 1 ? "tarea" : "tareas"} de Copilot sin marcar desde hace más de 24 h.`,
        link: "/copilot/vencidas",
      })),
    });
    avisos += destinatarios.length;
  }
  // Se marcan todos, también los de cuentas técnicas o sin asesor: un aviso por toque, nunca dos.
  await prisma.copilotToque.updateMany({ where: { id: { in: vencidos.map((v) => v.id) } }, data: { avisoVencidaAt: ahora } });
  return { avisos, toques: vencidos.length };
}

// ───────────────────────────── tick ─────────────────────────────

/** Etapa «cadencias» del cron. El orden importa: una respuesta gana al fin de la cadencia. */
export async function tickCadencias(ahora: Date = new Date()) {
  const catalogo = await cargarCatalogo();
  const materializadas = await materializarCadencias({ ahora, catalogo });
  const respuestas = await detectarRespuestas(ahora);
  const fin = await terminarCadenciasVencidas(ahora, catalogo);
  // Lo que se abrió al cerrar otra (p. ej. Nutrición) crea su +0 en este mismo minuto.
  const nuevas = fin.siguientes > 0 ? await materializarCadencias({ ahora, catalogo }) : { cadencias: 0, toques: 0 };
  const vencidas = await avisarVencidas(ahora);
  return { ...materializadas, toques: materializadas.toques + nuevas.toques, ...respuestas, ...fin, avisos: vencidas.avisos, toquesVencidos: vencidas.toques };
}

// ───────────────────────────── resultado del asesor ─────────────────────────────

export type ResultadoMarcar =
  | { ok: true; pausada: boolean }
  | { ok: false; status: number; error: string };

/**
 * Marca (o desmarca, con `resultado: null`) un toque. «Contestó» o «Respondió» en una cadencia que
 * se detiene con la respuesta la pausan y dejan la tarea «Clasificar respuesta»; en la general, un
 * intento pasa Nuevo → Sin respuesta.
 */
export async function marcarResultado(opts: {
  toqueId: string;
  resultado: string | null;
  variante?: string | null;
  usuarioId: string;
  ahora?: Date;
}): Promise<ResultadoMarcar> {
  const ahora = opts.ahora ?? new Date();
  const t = await prisma.copilotToque.findUnique({ where: { id: opts.toqueId } });
  if (!t) return { ok: false, status: 404, error: "El toque ya no existe (la cadencia pudo haber terminado)" };
  const k = await prisma.copilotCadencia.findUnique({ where: { id: t.cadenciaId } });
  if (!k || k.estado !== "ACTIVA") return { ok: false, status: 409, error: "La cadencia de este contacto ya no está activa" };
  if (opts.resultado !== null && !esResultadoDelCanal(t.canal, opts.resultado)) {
    return { ok: false, status: 400, error: "Ese resultado no aplica a este toque" };
  }
  if (new Date(t.programadoAt).getTime() > ahora.getTime()) {
    return { ok: false, status: 409, error: "Este toque todavía no toca" };
  }
  const def = await prisma.copilotCadenciaDef.findUnique({ where: { tipo: k.tipo }, select: { respuestaTermina: true } });

  return prisma.$transaction(async (tx) => {
    await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA, actorId: opts.usuarioId });
    await tx.copilotToque.update({
      where: { id: t.id },
      data: {
        resultado: opts.resultado,
        resultadoAt: opts.resultado ? ahora : null,
        resultadoPorId: opts.resultado ? opts.usuarioId : null,
        ...(opts.variante !== undefined ? { variante: opts.variante } : {}),
      },
    });
    if (esRespuesta(opts.resultado) && def?.respuestaTermina) {
      await pausarPorRespuesta(tx, k, ahora);
      return { ok: true as const, pausada: true };
    }
    if (esIntento(opts.resultado) && esGeneral(k.tipo)) {
      if (!k.primerIntentoAt) await tx.copilotCadencia.update({ where: { id: k.id }, data: { primerIntentoAt: ahora } });
      await pasarASinRespuesta(tx, k.contactId);
    }
    return { ok: true as const, pausada: false };
  });
}

// ───────────────────────────── clasificación (R2) ─────────────────────────────

export type ResultadoClasificar = { ok: true; cadencia: string | null } | { ok: false; status: number; error: string };

/**
 * El asesor clasifica la respuesta. Cierra la cadencia pausada, fija estado, subestado y razón, y
 * abre la cadencia de la rama. «No era respuesta» reanuda la cadencia pausada donde iba.
 */
export async function clasificar(opts: {
  clasificacionId: string;
  resultado: string;
  fechaRecontacto?: string | null;
  usuarioId: string;
  ahora?: Date;
}): Promise<ResultadoClasificar> {
  const ahora = opts.ahora ?? new Date();
  if (!esResultadoClasificacion(opts.resultado)) return { ok: false, status: 400, error: "Clasificación inválida" };
  const resultado: ResultadoClasificacion = opts.resultado;
  const efecto = CLASIFICACIONES[resultado];
  const c = await prisma.copilotClasificacion.findUnique({ where: { id: opts.clasificacionId } });
  if (!c) return { ok: false, status: 404, error: "La clasificación ya no existe" };
  if (c.resultado) return { ok: false, status: 409, error: "Esta respuesta ya se clasificó" };

  let fechaRecontacto: string | null = null;
  if (efecto.pideFecha) {
    const hoy = fechaCancun(ahora);
    if (opts.fechaRecontacto) {
      fechaRecontacto = fechaRecontactoValida(opts.fechaRecontacto, hoy);
      if (!fechaRecontacto) return { ok: false, status: 400, error: "La fecha de recontacto tiene que ser de mañana a dos años" };
    } else {
      fechaRecontacto = new Date(Date.parse(`${hoy}T00:00:00Z`) + DIAS_POSPUSO_POR_DEFECTO * 86_400_000).toISOString().slice(0, 10);
    }
  }
  const catalogo = await cargarCatalogo();
  const k = c.cadenciaId ? await prisma.copilotCadencia.findUnique({ where: { id: c.cadenciaId } }) : null;

  const nueva = await prisma.$transaction(async (tx) => {
    await setChangeSource(tx, { source: FUENTE_CAMBIO_CADENCIA, actorId: opts.usuarioId });
    await tx.copilotClasificacion.update({
      where: { id: c.id },
      data: {
        resultado,
        resueltaAt: ahora,
        resueltaPorId: opts.usuarioId,
        fechaRecontacto: fechaRecontacto ? new Date(`${fechaRecontacto}T00:00:00Z`) : null,
      },
    });

    if (resultado === "NO_ERA_RESPUESTA") {
      if (k?.estado === "PAUSADA") {
        const otra = await tx.copilotCadencia.findFirst({ where: { contactId: c.contactId, estado: "ACTIVA" }, select: { id: true } });
        if (otra) {
          await cerrar(tx, k.id, "CAMBIO_RAMA", ahora, "borrar");
        } else {
          // Primero la cadencia (ACTIVA), luego el estado: así el disparador no abre otra general.
          await tx.copilotCadencia.update({ where: { id: k.id }, data: { estado: "ACTIVA", respuestaAt: null, ignorarAntesDe: ahora } });
          if (c.estadoAntes && esGeneral(k.tipo)) {
            await tx.contact.updateMany({
              where: { id: c.contactId, estado: "CONTACTADO" as never },
              data: { estado: c.estadoAntes as never, subestado: c.subestadoAntes },
            });
          }
        }
      }
      return null;
    }

    if (k && (k.estado === "PAUSADA" || k.estado === "ACTIVA")) await cerrar(tx, k.id, "RESPONDIO", ahora, "borrar");
    const actual = await tx.contact.findUnique({ where: { id: c.contactId }, select: { estado: true, reactivaciones: true } });
    await tx.contact.update({
      where: { id: c.contactId },
      data: {
        estado: efecto.estado as never,
        subestado: efecto.subestado,
        razonSalida: (efecto.razon ?? null) as never,
        ...(fechaRecontacto ? { fechaRecontacto: new Date(`${fechaRecontacto}T00:00:00Z`) } : {}),
        ...(esReactivacion(actual?.estado as string | null, efecto.estado) ? { reactivaciones: (actual?.reactivaciones ?? 0) + 1 } : {}),
      },
    });
    if (!efecto.cadencia) return null;
    const def = catalogo.get(efecto.cadencia);
    const ancla = def?.anclaTipo === "RESPUESTA" ? new Date(c.respuestaAt) : ahora;
    return inscribir(tx, catalogo, {
      contactId: c.contactId,
      tipo: efecto.cadencia,
      anclaAt: ancla,
      anclaTipo: def?.anclaTipo ?? "CLASIFICACION",
      origenId: k?.id ?? null,
      ahora,
    });
  });
  // El +0 de la rama (A1, B2a, B3a…) aparece ya, sin esperar al cron.
  if (nueva) await materializarCadencias({ ahora, contactIds: [c.contactId], catalogo });
  return { ok: true, cadencia: nueva ? efecto.cadencia : null };
}

// ───────────────────────────── lectura ─────────────────────────────

const SELECT_CONTACTO = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  preferredLanguage: true,
  preferredZone: true,
  targetPlaza: true,
  estado: true,
  doNotContact: true,
  whatsappOptOut: true,
  fechaRecontacto: true,
  assignedToId: true,
} satisfies Prisma.ContactSelect;

async function cargarPlantillas(): Promise<Plantilla[]> {
  const filas = await prisma.copilotPlantilla.findMany({ orderBy: [{ orden: "asc" }, { idioma: "asc" }] });
  return filas.map((p) => ({ ...p, idioma: p.idioma === "EN" ? "EN" : "ES" }));
}

async function armarDesde(
  cadencias: FilaCadencia[],
  toques: Awaited<ReturnType<typeof prisma.copilotToque.findMany>>,
  ahora: Date,
  catalogo: Map<string, CadenciaGuardada>,
) {
  const contactIds = [...new Set(cadencias.map((k) => k.contactId))];
  const [contactos, temperaturas, plantillas] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: contactIds } }, select: SELECT_CONTACTO }),
    prisma.contactTemperatura.findMany({ where: { contactId: { in: contactIds } } }).catch(() => []),
    cargarPlantillas(),
  ]);
  const asesorIds = [...new Set(contactos.map((c) => c.assignedToId).filter((x): x is string => !!x))];
  const asesores = await prisma.user.findMany({ where: { id: { in: asesorIds } }, select: { id: true, name: true, role: true, phone: true } });
  const tareas = armarTareas({
    cadencias: cadencias.map((k) => {
      const def = catalogo.get(k.tipo);
      return {
        ...k,
        anclaAt: anclaDe(k),
        nombre: def?.nombre ?? k.tipo,
        finDias: def?.finDias ?? null,
      };
    }),
    toques,
    contactos: contactos.map((c) => ({
      ...c,
      estado: (c.estado as string | null) ?? null,
      preferredLanguage: c.preferredLanguage as string,
      targetPlaza: (c.targetPlaza as string | null) ?? null,
      fechaRecontacto: fechaIso(c.fechaRecontacto),
    })),
    asesores: asesores.map((a) => ({ ...a, role: a.role as string })),
    temperaturas: temperaturas.map((t) => ({ contactId: t.contactId, temperatura: (t.temperatura as string | null) ?? null, orden: t.orden, motivo: t.motivo })),
    plantillas,
    ahora,
  });
  return { tareas, temperaturas };
}

export interface ClasificacionPendiente {
  id: string;
  contactId: string;
  nombre: string;
  respuestaAt: string;
  /** Lo último que escribió el lead (para clasificar sin abrir el Inbox). */
  ultimoMensaje: string | null;
  /** Nombre de la cadencia que se pausó. */
  cadencia: string | null;
  temperatura: string | null;
}

async function clasificacionesPendientes(contactIds: string[], catalogo: Map<string, CadenciaGuardada>): Promise<ClasificacionPendiente[]> {
  if (contactIds.length === 0) return [];
  const pendientes = await prisma.copilotClasificacion.findMany({
    where: { contactId: { in: contactIds }, resultado: null },
    orderBy: { respuestaAt: "asc" },
  });
  if (pendientes.length === 0) return [];
  const ids = pendientes.map((p) => p.contactId);
  const [contactos, cadencias, temps, mensajes] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, temperature: true } }),
    prisma.copilotCadencia.findMany({ where: { id: { in: pendientes.map((p) => p.cadenciaId).filter((x): x is string => !!x) } }, select: { id: true, tipo: true } }),
    prisma.contactTemperatura.findMany({ where: { contactId: { in: ids } }, select: { contactId: true, temperatura: true } }).catch(() => []),
    prisma.$queryRaw<{ contactId: string; body: string | null }[]>`
      SELECT DISTINCT ON (m."contactId") m."contactId", m."body"
        FROM "propyte_crm"."messages" m
       WHERE m."contactId" = ANY(${ids}::text[]) AND m."direction" = 'INBOUND' AND coalesce(m."internalNote", false) = false
       ORDER BY m."contactId", m."createdAt" DESC`,
  ]);
  const con = new Map(contactos.map((c) => [c.id, c]));
  const cad = new Map(cadencias.map((k) => [k.id, k.tipo]));
  const tem = new Map(temps.map((t) => [t.contactId, (t.temperatura as string | null) ?? null]));
  const msg = new Map(mensajes.map((m) => [m.contactId, m.body]));
  return pendientes.map((p) => {
    const c = con.get(p.contactId);
    const tipo = p.cadenciaId ? cad.get(p.cadenciaId) : undefined;
    return {
      id: p.id,
      contactId: p.contactId,
      nombre: c ? `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Sin nombre" : "Contacto",
      respuestaAt: new Date(p.respuestaAt).toISOString(),
      ultimoMensaje: msg.get(p.contactId)?.slice(0, 400) ?? null,
      cadencia: tipo ? catalogo.get(tipo)?.nombre ?? tipo : null,
      temperatura: tem.get(p.contactId) ?? (c?.temperature as string | null) ?? null,
    };
  });
}

/** «Mi día» del asesor: respuestas por clasificar y sus tareas de hoy y atrasadas, en orden y con el tope de 40. */
export async function miDia(
  usuarioId: string,
  ahora: Date = new Date(),
): Promise<MiDia & { hoy: string; clasificar: ClasificacionPendiente[] }> {
  const hoy = fechaCancun(ahora);
  const deEl = await prisma.contact.findMany({ where: { assignedToId: usuarioId, deletedAt: null }, select: { id: true } });
  const todos = deEl.map((c) => c.id);
  const catalogo = await cargarCatalogo();
  const clasificar = await clasificacionesPendientes(todos, catalogo);

  const activasDeEl = await prisma.copilotCadencia.findMany({ where: { estado: "ACTIVA", contactId: { in: todos } } });
  const ids = activasDeEl.map((k) => k.contactId);
  if (ids.length === 0) return { hoy, tareas: [], fueraDelTope: 0, hechasHoy: [], vencidas: 0, clasificar };

  // Que el +0 de un lead que acaba de entrar no espere al cron.
  await materializarCadencias({ ahora, contactIds: ids, catalogo });
  const cadencias = await prisma.copilotCadencia.findMany({ where: { estado: "ACTIVA", contactId: { in: ids } } });
  const toques = await prisma.copilotToque.findMany({
    where: { cadenciaId: { in: cadencias.map((k) => k.id) }, programadoAt: { lte: ahora } },
  });
  // Solo los días con algo pendiente, y el de hoy (para «hechas hoy»).
  const diasConPendiente = new Set(toques.filter((t) => !t.resultado).map((t) => `${t.cadenciaId}:${fechaDe(t.fecha)}`));
  const visibles = toques.filter((t) => diasConPendiente.has(`${t.cadenciaId}:${fechaDe(t.fecha)}`) || fechaDe(t.fecha) === hoy);

  const { tareas, temperaturas } = await armarDesde(cadencias, visibles, ahora, catalogo);
  const orden = new Map(temperaturas.map((t) => [t.contactId, t.orden]));
  const inicio = new Map(cadencias.map((k) => [k.id, k.inicio]));
  // Las clasificaciones cuentan para el tope de 40: van antes que cualquier toque.
  const tope = Math.max(0, TOPE_TAREAS_DIA - clasificar.length);
  return {
    hoy,
    clasificar,
    ...ordenarMiDia(tareas, hoy, tope, (id) => orden.get(id) ?? null, (id) => inicio.get(id) ?? new Date(0)),
  };
}

export interface CadenciaDeContacto {
  id: string;
  tipo: string;
  nombre: string;
  rama: string;
  estado: string;
  motivoFin: string | null;
  dia: number;
  ultimoDia: number | null;
  diaInicio: string;
  finAt: string | null;
  /** Días con toques ya creados, con su texto. */
  tareas: TareaLista[];
  /** Lo que falta: día, código, canal y cuándo. */
  siguientes: { dia: number; fecha: string; codigo: string; canal: string }[];
  /** La respuesta por clasificar de este contacto, si la hay. */
  clasificar: ClasificacionPendiente | null;
  /** Las cadencias anteriores del contacto (la más reciente primero). */
  historial: { tipo: string; nombre: string; motivoFin: string | null; inicio: string; finAt: string | null }[];
}

/** La cadencia del contacto para su ficha: la activa, la pausada o la última que tuvo. null si nunca tuvo. */
export async function cadenciaDeContacto(contactId: string, ahora: Date = new Date()): Promise<CadenciaDeContacto | null> {
  const catalogo = await cargarCatalogo();
  await materializarCadencias({ ahora, contactIds: [contactId], catalogo }).catch(() => undefined);
  const todas = await prisma.copilotCadencia.findMany({ where: { contactId }, orderBy: { inicio: "desc" } });
  if (todas.length === 0) return null;
  const k = todas.find((x) => x.estado === "ACTIVA") ?? todas.find((x) => x.estado === "PAUSADA") ?? todas[0];
  const def = catalogo.get(k.tipo);
  const toques = await prisma.copilotToque.findMany({ where: { cadenciaId: k.id }, orderBy: [{ programadoAt: "asc" }, { orden: "asc" }] });
  const { tareas } = await armarDesde([k], toques, ahora, catalogo);
  tareas.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  const ancla = anclaDe(k);
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: SELECT_CONTEXTO });
  let siguientes: CadenciaDeContacto["siguientes"] = [];
  if (k.estado === "ACTIVA" && def && c) {
    const hechos = new Set(toques.map((t) => t.codigo));
    const wa = await conWhatsAppAbierto([contactId]);
    siguientes = planDeCadencia(def, def.pasos, contextoDe(c, wa.has(contactId)), ancla, await codigosDePlantillas())
      .filter((t) => !hechos.has(t.codigo) && t.programadoAt.getTime() > ahora.getTime())
      .map((t) => ({ dia: t.dia, fecha: t.fecha, codigo: t.codigo, canal: t.canal }));
  }
  const fin = def && c ? finDeCadencia(def, ancla, fechaIso(c.fechaRecontacto)) : null;
  const ultimoDia = fin ? Math.round((Date.parse(`${fechaCancun(fin)}T00:00:00Z`) - Date.parse(`${fechaCancun(ancla)}T00:00:00Z`)) / 86_400_000) : null;
  const [pendiente] = await clasificacionesPendientes([contactId], catalogo);
  return {
    id: k.id,
    tipo: k.tipo,
    nombre: def?.nombre ?? k.tipo,
    rama: def?.rama ?? "",
    estado: k.estado,
    motivoFin: k.motivoFin,
    dia: Math.max(1, Math.round((Date.parse(`${fechaCancun(ahora)}T00:00:00Z`) - Date.parse(`${fechaCancun(ancla)}T00:00:00Z`)) / 86_400_000) + 1),
    ultimoDia,
    diaInicio: fechaCancun(ancla),
    finAt: k.finAt ? k.finAt.toISOString() : null,
    tareas,
    siguientes,
    clasificar: pendiente ?? null,
    historial: todas
      .filter((x) => x.id !== k.id)
      .map((x) => ({
        tipo: x.tipo,
        nombre: catalogo.get(x.tipo)?.nombre ?? x.tipo,
        motivoFin: x.motivoFin,
        inicio: x.inicio.toISOString(),
        finAt: x.finAt ? x.finAt.toISOString() : null,
      })),
  };
}

export interface FilaTablero {
  asesorId: string;
  asesor: string;
  tareasVencidas: number;
  contactos: { id: string; nombre: string; dia: number; desde: string; cadencia: string }[];
}

/** Tablero de vencidas por asesor (24 h o más sin marcar). `owners` undefined = todos. */
export async function tableroVencidas(owners: string[] | undefined, ahora: Date = new Date()): Promise<FilaTablero[]> {
  const limite = new Date(ahora.getTime() - VENCIDA_MS);
  const filas = await prisma.$queryRaw<{ asesorId: string; asesor: string; contactId: string; nombre: string; dia: number; fecha: Date; desde: Date; cadencia: string }[]>`
    SELECT c."assignedToId" AS "asesorId", u."name" AS "asesor", c."id" AS "contactId",
           trim(coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '')) AS "nombre",
           t."dia", t."fecha", min(t."programadoAt") AS "desde", coalesce(d."nombre", k."tipo") AS "cadencia"
      FROM "propyte_crm"."copilot_toques" t
      JOIN "propyte_crm"."copilot_cadencias" k ON k."id" = t."cadenciaId" AND k."estado" = 'ACTIVA'
      LEFT JOIN "propyte_crm"."copilot_cadencia_defs" d ON d."tipo" = k."tipo"
      JOIN "propyte_crm"."contacts" c ON c."id" = t."contactId" AND c."deletedAt" IS NULL
      JOIN "propyte_crm"."users" u ON u."id" = c."assignedToId"
     WHERE t."resultado" IS NULL AND t."programadoAt" <= ${limite}
       AND (${owners ?? null}::text[] IS NULL OR c."assignedToId" = ANY(${owners ?? null}::text[]))
     GROUP BY 1, 2, 3, 4, 5, 6, 8
     ORDER BY 2, 7`;
  const porAsesor = new Map<string, FilaTablero>();
  for (const f of filas) {
    const g = porAsesor.get(f.asesorId) ?? { asesorId: f.asesorId, asesor: f.asesor, tareasVencidas: 0, contactos: [] };
    g.tareasVencidas++;
    g.contactos.push({ id: f.contactId, nombre: f.nombre || "Sin nombre", dia: f.dia, desde: new Date(f.desde).toISOString(), cadencia: f.cadencia });
    porAsesor.set(f.asesorId, g);
  }
  return [...porAsesor.values()].sort((a, b) => b.tareasVencidas - a.tareasVencidas);
}

export { esTablaSinMigrar } from "./sin-migrar";
