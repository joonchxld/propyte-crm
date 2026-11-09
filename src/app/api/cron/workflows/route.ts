// Tick del motor de workflows (Anexo §D.1) — agendado en el crontab de root del VPS CADA MINUTO:
//   curl -s -H "x-cron-secret: $CRON_SECRET" https://crm.propyte.com/api/cron/workflows
// Hace: eventos pendientes → cola de acciones → SLA breaches → enrollments → reglas INACTIVITY
// → … → correo entrante de Gmail (#889).
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { processPendingEvents, emitEvent } from "@/lib/workflows/events";
import { runQueue, recuperarEncalladas } from "@/lib/workflows/queue";
import { checkSlaBreaches } from "@/lib/workflows/sla";
import { reasignarSinPrimerContacto } from "@/lib/workflows/sla-reasignacion";
import { runEnrollments, runInactivityRules } from "@/lib/workflows/scheduler";
import { rechazoCron } from "@/lib/cron/auth";
import { limpiarOtpVencidos } from "@/lib/auth/otp-limpieza";
import { esTablaSinMigrar as sinTablasCopilot } from "@/lib/copilot/sin-migrar";

// CAPI dispatcher con guarda (tablas C123 pueden no estar migradas aún)
async function reintentarLeadsSafe() {
  try {
    const { reprocesarLeadsFallidos } = await import("@/lib/intake/connectors");
    return await reprocesarLeadsFallidos(25);
  } catch (err) {
    console.error("[cron/workflows] replay de leads:", err);
    return { intentados: 0, recuperados: 0 };
  }
}

// Lead scoring en modo sombra (spec 2026-10-26-lead-scoring-design.md). Igual que las
// parcialidades: solo se perdona P2021 (contact_scores sin migrar); cualquier otro error sube
// a la lista de ETAPAS con su nombre.
async function recalcularScoresSafe() {
  try {
    const { recalcularScores } = await import("@/lib/scoring/recalcular");
    return await recalcularScores(200);
  } catch (err) {
    if (esTablaSinMigrar(err)) return { calculados: 0, sinMigrar: true };
    throw err;
  }
}

// #973: temperatura calculada (Copilot). Igual que el score: solo se perdona P2021
// (contact_temperaturas sin migrar); cualquier otro error sube con el nombre de la etapa.
async function recalcularTemperaturasSafe() {
  try {
    const { recalcularTemperaturas } = await import("@/lib/copilot/temperatura-recalcular");
    return await recalcularTemperaturas(200);
  } catch (err) {
    if (esTablaSinMigrar(err)) return { calculados: 0, sinMigrar: true };
    throw err;
  }
}

// #988: «Mi día» (cadencia de nuevos). Solo se perdona la migración sin correr (P2021 o 42P01 en
// las consultas crudas); cualquier otro error sube con el nombre de la etapa.
async function tickCadenciasSafe() {
  try {
    const { tickCadencias } = await import("@/lib/copilot/cadencia-servicio");
    return await tickCadencias();
  } catch (err) {
    if (sinTablasCopilot(err)) return { cadencias: 0, sinMigrar: true };
    throw err;
  }
}

async function processPendingConversionsSafe() {
  try {
    const { processPendingConversions } = await import("@/lib/capi/dispatch");
    return await processPendingConversions(20);
  } catch {
    return { sent: 0, partial: 0, failed: 0 };
  }
}

// Parcialidades vencidas → VENCIDA + payment.overdue (WF6). Defensivo: si la tabla
// F6 aún no está migrada, regresa 0 sin romper el tick.
// Auditoría 2026-09-10: este `catch` devolvía 0 ante CUALQUIER error, no sólo ante la
// tabla sin migrar. Un fallo real —una restricción violada, la conexión caída a mitad del
// lote, un `dealId` nulo— se veía desde fuera exactamente igual que «hoy no había
// parcialidades vencidas»: la etapa reportaba 0 y el tick salía 200. Justo el fallo que la
// etapa existe para evitar.
//
// Ahora sólo se perdona P2021 (la tabla no existe), que es la única condición que este
// `try` pretendía cubrir. Todo lo demás sube a la lista de ETAPAS, que ya reporta el
// nombre de la etapa y devuelve 500 — el mecanismo que ya está escrito ahí abajo.
function esTablaSinMigrar(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2021";
}

async function checkOverduePayments(): Promise<number> {
  let overdue;
  try {
    overdue = await prisma.paymentSchedule.findMany({
      where: { status: "PENDIENTE", dueDate: { lte: new Date() } },
      take: 100,
      include: { plan: { include: { quote: { select: { dealId: true } } } } },
    });
  } catch (err) {
    if (esTablaSinMigrar(err)) return 0; // tabla F6 sin migrar todavía
    throw err;
  }

  let marcadas = 0;
  for (const sched of overdue) {
    // Por parcialidad, y no un try para todo el lote: una fila con un problema propio no
    // debe impedir que las otras 99 se marquen.
    try {
      // El estado y el evento van juntos o no van. Antes eran dos escrituras sueltas: si
      // `emitEvent` fallaba, la parcialidad quedaba VENCIDA y el aviso al asesor no salía
      // NUNCA — y como el evento es lo que dispara el seguimiento, el cliente se quedaba
      // sin cobrar sin que nadie se enterara. `emitEvent` sólo persiste el evento y lo
      // procesa best-effort, así que dentro de la transacción es seguro.
      await prisma.$transaction(async (tx) => {
        await tx.paymentSchedule.update({
          where: { id: sched.id },
          data: { status: "VENCIDA" },
        });
        await emitEvent("payment.overdue", "deal", sched.plan.quote.dealId, {
          scheduleId: sched.id,
          number: sched.number,
          amount: String(sched.amount),
          dueDate: sched.dueDate.toISOString(),
        });
      });
      marcadas++;
    } catch (err) {
      console.error(`[cron/workflows] parcialidad ${sched.id} no se pudo marcar vencida:`, err);
    }
  }

  // Se devuelve lo que de verdad se marcó, no cuántas se encontraron: con el `return
  // overdue.length` anterior, un lote entero que fallara seguía reportando el total.
  return marcadas;
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;


/**
 * Las etapas del tick, cada una con su nombre y su llamada.
 *
 * Están en una lista y no encadenadas en el cuerpo porque ANTES compartían un solo
 * `try`: si la primera tropezaba, las siguientes no llegaban a correr. Entre ellas
 * las que marcan los SLA vencidos y las que disparan los seguimientos programados, o sea
 * que el tiempo dejaba de pasar para todo lo que depende del reloj — y desde fuera se veía
 * igual que un día tranquilo.
 *
 * NO son independientes en el sentido de que el orden dé igual: los eventos alimentan la
 * cola, y por eso se recorren en secuencia. Lo que cambia es que el fallo de una ya no
 * cancela a las demás. Una etapa que dependa de datos que la anterior no produjo hará
 * menos trabajo, que es estrictamente mejor que no hacer ninguno.
 */
const ETAPAS: ReadonlyArray<{ nombre: string; correr: () => Promise<unknown> }> = [
  { nombre: "events", correr: () => processPendingEvents(50) },
  // Va ANTES de `queue` para que lo que se rescata entre en la misma pasada en vez de
  // esperar al minuto siguiente. Ver el comentario de `recuperarEncalladas`.
  { nombre: "encalladas", correr: () => recuperarEncalladas(50) },
  { nombre: "queue", correr: () => runQueue(20) },
  { nombre: "slaBreaches", correr: () => checkSlaBreaches(100) },
  // Reasignación por falta de primer contacto. Va DESPUÉS de `slaBreaches` para que el
  // vencimiento quede marcado (y avisado) antes de mover el lead. Apagada por defecto: sin
  // la fila `workflows.sla.reasignacion_primer_contacto` encendida no hace ninguna consulta
  // más que leer esa fila.
  { nombre: "slaReasignacion", correr: () => reasignarSinPrimerContacto(50) },
  { nombre: "enrollments", correr: () => runEnrollments(50) },
  { nombre: "inactivity", correr: () => runInactivityRules(200) },
  { nombre: "overduePayments", correr: () => checkOverduePayments() },
  { nombre: "conversions", correr: () => processPendingConversionsSafe() },
  // #713: los leads que quedaron en ERROR con sus campos ya mapeados se vuelven a
  // intentar. Va al final porque no alimenta a ninguna otra etapa.
  { nombre: "replayLeads", correr: () => reintentarLeadsSafe() },
  // Perfil de inversión desde los leads de Meta del Hub (plazo, pago, interés, presupuesto):
  // solo llena huecos. Va ANTES de leadScoring porque toca `updatedAt` y así el score del
  // contacto se recalcula en esta misma pasada.
  {
    nombre: "perfilMeta",
    correr: async () => (await import("@/lib/intake/perfil-desde-hub")).completarPerfilDesdeHub(50),
  },
  // Lead scoring: en sombra no alimenta a nadie (solo escribe contact_scores). Con
  // `scoring.activo` emite `contact.scored`, que el tick SIGUIENTE procesa vía `events`.
  { nombre: "leadScoring", correr: () => recalcularScoresSafe() },
  // #973: no alimenta a ninguna etapa de este tick (Copilot la leerá para ordenar «Mi día»).
  { nombre: "temperatura", correr: () => recalcularTemperaturasSafe() },
  // #988: después de la temperatura, que ordena «Mi día». Crea los toques del día, detecta
  // respuestas (→ Contactado), cierra las cadencias que pasaron su último día (→ Perdido) y avisa
  // al gerente de las tareas con 24 h sin marcar.
  { nombre: "cadencias", correr: () => tickCadenciasSafe() },
  // #699 (defecto 2): retira los códigos de un solo uso que ya vencieron. Va al final por
  // lo mismo: no alimenta a nadie. Y NO lleva `try` propio —a diferencia de las etapas con
  // tablas que pueden no estar migradas— porque `users` existe desde el init: si esto
  // falla, es un fallo de verdad y tiene que subir a la lista de fallos y sacar el 500.
  { nombre: "otpVencidos", correr: () => limpiarOtpVencidos() },
  // Acuerdo de actividad (E8): una vez por dia laboral por la manana, avisa al lider (o a la
  // gerencia) de los asesores que no llegaron a los minimos del dia anterior. Se frena solo
  // con `activity_agreement.last_run`, asi que correr cada minuto no repite avisos.
  {
    nombre: "acuerdoActividad",
    correr: async () =>
      (await import("@/lib/workflows/acuerdo-actividad")).revisarAcuerdoDeActividad(prisma, new Date()),
  },
  // #889: correo entrante de los buzones Gmail conectados → historial del contacto + aviso
  // al asesor. Va al final porque no alimenta a ninguna otra etapa y es la única que sale a
  // la red (API de Gmail). Import dinámico para no cargar googleapis si nadie lo usa. Una
  // cuenta desconectada NO es fallo (queda marcada para reconectar); cualquier otro error
  // sí, después de intentar todas las cuentas. Ver lib/google/gmail-sync.ts.
  {
    nombre: "correoEntrante",
    correr: async () => (await import("@/lib/google/gmail-sync")).sincronizarCorreoEntranteTick(),
  },
];

export async function GET(req: NextRequest) {
  const rechazo = rechazoCron(req);
  if (rechazo) return rechazo;

  const startedAt = Date.now();
  const result: Record<string, unknown> = {};
  const fallos: Array<{ etapa: string; error: string; ms: number }> = [];

  for (const { nombre, correr } of ETAPAS) {
    const t0 = Date.now();
    try {
      result[nombre] = await correr();
    } catch (err) {
      // Cada etapa se reporta con su nombre. Un «el tick falló» sin decir cuál de las
      // cuál obliga a reproducir el minuto entero para saber por dónde empezar.
      console.error(`[cron/workflows] etapa ${nombre}:`, err);
      fallos.push({
        etapa: nombre,
        error: String(err instanceof Error ? err.message : err).slice(0, 500),
        ms: Date.now() - t0,
      });
    }
  }

  result.ms = Date.now() - startedAt;

  /**
   * 500 en cuanto UNA etapa falle, aunque las demás hayan ido bien.
   *
   * Un 200 con los fallos escondidos en el cuerpo es peor que el bug que se está
   * arreglando: cualquier monitor externo mira el status, y este endpoint corre cada
   * minuto sin que nadie lea su respuesta. El cuerpo lleva TODO —lo que sí corrió y lo
   * que no— para que el status no sea el único dato disponible.
   */
  if (fallos.length > 0) {
    return NextResponse.json({ ok: false, fallos, ...result }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}
