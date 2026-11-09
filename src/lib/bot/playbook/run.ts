// Orquestador de un paso de playbook dentro de botRespond (Anexo Técnico §B-Task 8).
// Regla de oro: NUNCA debe romper la respuesta del bot. Cualquier error en
// extracción/captura/aplicación/avance cae de vuelta al objective de la ruta A
// (buildOpener/goal en bot-respond.ts).
import type { PrismaClient, PlaybookRunStatus } from "@prisma/client";
import type { BotMessage } from "../claude";
import { extractFields, type ExtractTaskLite } from "./extract";
import { coerceCapture, type EnumOption } from "./capture";
import { applyCapture } from "./apply";
import { nextTask, buildObjective, buildRepreguntaObjective, COMPLETION_OBJECTIVE, type PlaybookTaskLite } from "./engine";

export interface PlaybookTaskFull {
  key: string;
  order: number;
  objective: string;
  targetField: string;
  captureType: string;
  enumOptions: unknown;
  required: boolean;
  skipIfFilled: boolean;
  /** Pista extra para el extractor (opcional; la mayoría de las tareas no la traen). */
  extractionHint?: string | null;
}

export async function runPlaybookStep(
  db: PrismaClient,
  args: {
    playbook: { id: string; tasks: PlaybookTaskFull[] };
    conversationId: string;
    contact: any;
    messages: BotMessage[];
    model: string;
    /**
     * Marcas del agente (2026-10-09): el hilo guarda UN solo estado. Si es de OTRO playbook (p. ej.
     * el global corrió antes de asignarle una marca a la cuenta), sus tareas cumplidas no son avance
     * de este: con `true` se reinicia para este playbook (como si no hubiera estado, mismo criterio
     * que AI_DRAFT). Sin la bandera (camino sin marca), exactamente como antes.
     */
    ignoreForeignState?: boolean;
  },
): Promise<{
  objective?: string;
  status: PlaybookRunStatus;
  /** #989: el guion se completó EN ESTE turno (no estaba completo antes). Solo viene en true. */
  recienCompletado?: true;
}> {
  try {
    const { playbook, conversationId, contact, messages, model, ignoreForeignState } = args;
    const tasks = playbook.tasks;

    let state = await db.conversationPlaybookState.upsert({
      where: { conversationId },
      create: {
        id: crypto.randomUUID(),
        conversationId,
        playbookId: playbook.id,
        status: "IN_PROGRESS",
        completedTaskKeys: [],
      },
      update: {},
    });
    if (ignoreForeignState && state.playbookId !== playbook.id) {
      state = await db.conversationPlaybookState.update({
        where: { conversationId },
        data: {
          playbookId: playbook.id,
          status: "IN_PROGRESS",
          currentTaskKey: null,
          completedTaskKeys: [],
          startedAt: new Date(),
          completedAt: null,
        },
      });
    }

    let completedKeys = ((state.completedTaskKeys as string[]) ?? []) as string[];
    // Tarea que el bot estaba persiguiendo antes de este mensaje (null en el primer turno o tras reiniciar).
    const tareaPrevia = (state as { currentTaskKey?: string | null }).currentTaskKey ?? null;

    const pending = tasks.filter((t) => !completedKeys.includes(t.key));
    const newlyDone: string[] = [];

    if (pending.length > 0) {
      const extractTasks: ExtractTaskLite[] = pending.map((t) => ({
        key: t.key,
        objective: t.objective,
        captureType: t.captureType,
        extractionHint: t.extractionHint ?? null,
        enumOptions: t.enumOptions as { value: string; synonyms?: string[] }[],
      }));
      const extracted = await extractFields({ messages, tasks: extractTasks, model });

      for (const t of pending) {
        const raw = extracted[t.key];
        if (typeof raw !== "string" || !raw.trim()) continue;

        const res = coerceCapture(
          {
            targetField: t.targetField,
            captureType: t.captureType as any,
            enumOptions: t.enumOptions as EnumOption[],
          },
          raw,
        );
        if (res.ok) {
          await applyCapture(db, contact.id, res.writes, { taskKey: t.key, conversationId });
          newlyDone.push(t.key);

          // Caso 1: detección de duplicado al capturar teléfono/email — best
          // effort, NUNCA debe romper el flujo del bot (regla de oro de este
          // orquestador).
          if (t.captureType === "PHONE" || t.captureType === "EMAIL") {
            try {
              const { detectDuplicatesForContact } = await import("@/lib/contacts/duplicate-alert");
              await detectDuplicatesForContact(contact.id);
            } catch {
              /* best-effort: nunca romper el flujo del bot */
            }
          }
        }
      }
    }

    if (newlyDone.length > 0) {
      completedKeys = [...completedKeys, ...newlyDone];
      await db.conversationPlaybookState.update({
        where: { conversationId },
        data: { completedTaskKeys: completedKeys },
      });
    }

    const fresh = (await db.contact.findUnique({ where: { id: contact.id } })) ?? contact;

    const task = nextTask(tasks as unknown as PlaybookTaskLite[], completedKeys, fresh as any);

    if (task) {
      await db.conversationPlaybookState.update({
        where: { conversationId },
        data: { currentTaskKey: task.key, status: "IN_PROGRESS" },
      });
      // El cliente contestó y la tarea que se le preguntó sigue sin registrarse → repreguntar, no improvisar.
      const contestoElCliente = messages.length > 0 && messages[messages.length - 1].role === "user";
      const objective =
        contestoElCliente && tareaPrevia === task.key ? buildRepreguntaObjective(task) : buildObjective(task);
      return { objective, status: "IN_PROGRESS" };
    }

    const yaEstabaCompleto = (state as { status?: string }).status === "COMPLETED";
    await db.conversationPlaybookState.update({
      where: { conversationId },
      data: { status: "COMPLETED", completedAt: new Date(), currentTaskKey: null },
    });
    return yaEstabaCompleto
      ? { objective: COMPLETION_OBJECTIVE, status: "COMPLETED" }
      : { objective: COMPLETION_OBJECTIVE, status: "COMPLETED", recienCompletado: true };
  } catch {
    // Defensivo: cualquier fallo cae al objective de la ruta A (§ ver bot-respond.ts).
    return { objective: undefined, status: "IN_PROGRESS" };
  }
}
