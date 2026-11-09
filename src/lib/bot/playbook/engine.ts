import { isCustomTarget } from "./fields";
import { isPlaceholderFirstName } from "@/lib/messaging/lead-form-summary";

export interface PlaybookTaskLite {
  key: string;
  order: number;
  objective: string;
  targetField: string;
  required: boolean;
  skipIfFilled: boolean;
}

export const COMPLETION_OBJECTIVE =
  "Ya tienes lo esencial del lead. Propón con naturalidad agendar una llamada o visita con el asesor y ofrece resolver dudas.";

export function isFieldFilled(contact: Record<string, unknown>, targetField: string): boolean {
  if (isCustomTarget(targetField)) {
    const customKey = targetField.slice("custom.".length);
    const custom = contact.custom as Record<string, unknown> | undefined;
    const value = custom?.[customKey];
    return value !== null && value !== undefined && value !== "";
  }

  const value = contact[targetField];
  // #989: «Messenger», «Instagram», «WhatsApp» o un @usuario los pone el alta cuando el canal no
  // da un nombre real. Contaban como nombre ya capturado y el guion se saltaba la pregunta.
  if (targetField === "firstName" && typeof value === "string") return !isPlaceholderFirstName(value);
  return value !== null && value !== undefined && value !== "";
}

export function nextTask(
  tasks: PlaybookTaskLite[],
  completedKeys: string[],
  contact: Record<string, unknown>
): PlaybookTaskLite | null {
  const sorted = [...tasks].sort((a, b) => a.order - b.order);

  for (const task of sorted) {
    const isCompleted = completedKeys.includes(task.key);
    const isSkippedFilled = task.skipIfFilled && isFieldFilled(contact, task.targetField);
    if (!isCompleted && !isSkippedFilled) {
      return task;
    }
  }

  return null;
}

export function buildObjective(task: PlaybookTaskLite): string {
  return `Tu meta ahora: ${task.objective}. Consíguelo con UNA sola pregunta natural, sin sonar a formulario ni listar campos.`;
}

/**
 * La misma tarea sigue pendiente después de que el cliente contestó (prueba de reclutamiento
 * 2026-11-04: «Sip» no casó con ninguna opción, el guion se quedó en la comisión y el modelo, por
 * no repetirse, improvisó preguntas propias y cerró pidiendo el CV). Se le dice que la respuesta no
 * quedó registrada y que la confirme antes de seguir.
 */
export function buildRepreguntaObjective(task: PlaybookTaskLite): string {
  return (
    `Tu meta ahora: ${task.objective}. Ya lo preguntaste, pero la respuesta del cliente no quedó clara para el registro. ` +
    "Si el cliente hizo una pregunta, contéstala breve primero. Luego confirma ese mismo punto con una pregunta corta y " +
    "directa (que pueda contestar con un sí, un no o una de las opciones). No pases a otro tema, no hagas otras preguntas " +
    "y no cierres la charla hasta tener esa respuesta."
  );
}
