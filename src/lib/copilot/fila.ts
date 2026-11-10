// #997 — Copilot «una a la vez»: la fila de actividades que se muestran de una en una, como cartas.
//
// Sale de lo mismo que «Mi día» (#988/#993): primero las respuestas por clasificar (el PDF pide
// clasificar en menos de 5 min) y luego las tareas de las cadencias, en el orden y con el tope que
// ya calcula `ordenarMiDia`. Dentro de una tarea (un contacto, un día), la actividad actual es el
// primer toque sin resultado; los demás del día se ven chicos, para no perder el contexto.
//
// Módulo PURO (sin React ni Prisma) para poder probarlo en node.
import type { MiDia, TareaLista, ToqueListo } from "./mi-dia";
import type { ClasificacionPendiente } from "./cadencia-servicio";
import type { Canal } from "./cadencia-nuevos";

export type ItemFila =
  | { tipo: "clasificar"; clave: string; pendiente: ClasificacionPendiente }
  | { tipo: "tarea"; clave: string; tarea: TareaLista };

/** La fila completa, en el orden en que se muestran las cartas. */
export function armarFila(data: Pick<MiDia, "tareas"> & { clasificar?: ClasificacionPendiente[] }): ItemFila[] {
  const clasificar = (data.clasificar ?? []).map<ItemFila>((p) => ({ tipo: "clasificar", clave: `clasificar:${p.id}`, pendiente: p }));
  const tareas = data.tareas
    .filter((t) => t.toques.some((q) => !q.resultado))
    .map<ItemFila>((t) => ({ tipo: "tarea", clave: `tarea:${t.clave}`, tarea: t }));
  return [...clasificar, ...tareas];
}

/** El toque que toca ahora dentro de una tarea: el primero sin resultado, por su orden. */
export function toqueActual(tarea: Pick<TareaLista, "toques">): ToqueListo | null {
  const pendientes = tarea.toques.filter((t) => !t.resultado);
  if (pendientes.length === 0) return null;
  return [...pendientes].sort((a, b) => a.orden - b.orden)[0];
}

/** Índice de la carta vecina, dando la vuelta al llegar a un extremo. */
export function moverIndice(indice: number, total: number, paso: 1 | -1): number {
  if (total <= 0) return 0;
  return (((indice + paso) % total) + total) % total;
}

/**
 * Dónde quedarse cuando la fila cambia (al marcar un resultado se refresca la página).
 * - Si la carta que se estaba viendo sigue en la fila (le quedan toques), se queda en ella.
 * - Si ya no está (se terminó), se queda en la misma posición: ahí cae la siguiente.
 * - Si la fila se acortó por el final, vuelve al principio.
 */
export function indiceTrasCambio(claves: readonly string[], claveAnterior: string | null, indiceAnterior: number): number {
  if (claves.length === 0) return 0;
  if (claveAnterior) {
    const i = claves.indexOf(claveAnterior);
    if (i >= 0) return i;
  }
  return indiceAnterior < claves.length ? Math.max(0, indiceAnterior) : 0;
}

/** Qué tan lejos hay que arrastrar la carta (px) para que cuente como deslizar. */
export const UMBRAL_DESLIZAR = 120;

/** Hacia dónde manda un arrastre: izquierda = siguiente, derecha = anterior, poco = se queda. */
export function direccionDeslizar(dx: number, umbral: number = UMBRAL_DESLIZAR): 1 | -1 | 0 {
  if (dx <= -umbral) return 1;
  if (dx >= umbral) return -1;
  return 0;
}

/** El título grande de la carta: qué hay que hacer y con quién. */
export function tituloActividad(canal: Canal, nombre: string): string {
  switch (canal) {
    case "LLAMADA":
      return `Llamar a ${nombre}`;
    case "WHATSAPP":
      return `Mandar WhatsApp a ${nombre}`;
    case "SMS":
      return `Mandar SMS a ${nombre}`;
    case "CORREO":
      return `Mandar correo a ${nombre}`;
    case "BUZON":
      return `Dejar buzón de voz a ${nombre}`;
    case "MISMO_CANAL":
      return `Contestarle a ${nombre} por donde escribió`;
    default:
      return nombre;
  }
}
