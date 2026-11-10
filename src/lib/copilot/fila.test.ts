import { describe, it, expect } from "vitest";
import { armarFila, direccionDeslizar, indiceTrasCambio, moverIndice, tituloActividad, toqueActual } from "./fila";
import type { TareaLista, ToqueListo } from "./mi-dia";
import type { ClasificacionPendiente } from "./cadencia-servicio";

// #997 — Copilot «una a la vez»: qué carta se ve, en qué orden y dónde se queda al refrescar.

function toque(id: string, orden: number, resultado: string | null = null): ToqueListo {
  return {
    id, codigo: id, canal: "LLAMADA", canalLabel: "Llamada", orden, cuando: "Ahora", resultado,
    resultadoAt: resultado ? "2026-11-10T15:00:00.000Z" : null, vencido: false, texto: null,
    variantes: null, variante: null, bloqueo: null, nota: null,
  };
}

function tarea(clave: string, toques: ToqueListo[]): TareaLista {
  return {
    clave, cadenciaId: clave, tipo: "NUEVOS", nombreCadencia: "Cadencia de nuevos", dia: 1, ultimoDia: 14,
    fecha: "2026-11-10", vencida: false, pendientes: toques.filter((t) => !t.resultado).length,
    contacto: {
      id: `c-${clave}`, nombre: "Uberto Pérez", telefono: "+529990000000", correo: null, idioma: "ES", pais: "MX",
      estado: null, temperatura: "HOT", motivoTemperatura: null,
    },
    toques,
  };
}

const clasif = (id: string): ClasificacionPendiente => ({
  id, contactId: `c-${id}`, nombre: "Mike", respuestaAt: "2026-11-10T15:00:00.000Z", ultimoMensaje: "Sí me interesa",
  cadencia: "Cadencia de nuevos", temperatura: null,
});

describe("Copilot — la fila de cartas", () => {
  it("primero las respuestas por clasificar, luego las tareas en el orden que trae Mi día", () => {
    const fila = armarFila({
      clasificar: [clasif("r1")],
      tareas: [tarea("a", [toque("L1", 1)]), tarea("b", [toque("L1", 1)])],
    });
    expect(fila.map((i) => i.clave)).toEqual(["clasificar:r1", "tarea:a", "tarea:b"]);
  });

  it("una tarea sin toques pendientes no sale como carta", () => {
    const fila = armarFila({ tareas: [tarea("a", [toque("L1", 1, "CONTESTO")]), tarea("b", [toque("L1", 1)])] });
    expect(fila.map((i) => i.clave)).toEqual(["tarea:b"]);
  });

  it("sin nada pendiente, la fila está vacía", () => {
    expect(armarFila({ tareas: [] })).toEqual([]);
  });
});

describe("Copilot — la actividad actual de una tarea", () => {
  it("es el primer toque sin resultado, por su orden (no por cómo vienen)", () => {
    const t = tarea("a", [toque("L2", 4), toque("L1", 1, "NO_CONTESTO"), toque("WA1", 2), toque("SMS1", 3)]);
    expect(toqueActual(t)?.id).toBe("WA1");
  });

  it("si ya todos tienen resultado, no hay actual", () => {
    expect(toqueActual(tarea("a", [toque("L1", 1, "CONTESTO")]))).toBeNull();
  });
});

describe("Copilot — moverse entre cartas", () => {
  it("Saltar y Anterior dan la vuelta en los extremos", () => {
    expect(moverIndice(0, 3, 1)).toBe(1);
    expect(moverIndice(2, 3, 1)).toBe(0);
    expect(moverIndice(0, 3, -1)).toBe(2);
    expect(moverIndice(0, 0, 1)).toBe(0);
  });

  it("deslizar a la izquierda = siguiente, a la derecha = anterior, poco = se queda", () => {
    expect(direccionDeslizar(-200)).toBe(1);
    expect(direccionDeslizar(200)).toBe(-1);
    expect(direccionDeslizar(-60)).toBe(0);
    expect(direccionDeslizar(60)).toBe(0);
  });
});

describe("Copilot — dónde quedarse al refrescar", () => {
  it("si la carta sigue (le quedan toques), se queda en ella aunque cambie de posición", () => {
    expect(indiceTrasCambio(["clasificar:r1", "tarea:a", "tarea:b"], "tarea:b", 1)).toBe(2);
  });

  it("si la carta se terminó, se queda en la misma posición: ahí cae la siguiente", () => {
    expect(indiceTrasCambio(["tarea:a", "tarea:c"], "tarea:b", 1)).toBe(1);
  });

  it("si se terminó la última, vuelve a la primera", () => {
    expect(indiceTrasCambio(["tarea:a", "tarea:b"], "tarea:c", 2)).toBe(0);
  });

  it("al entrar (sin carta previa) empieza en la primera", () => {
    expect(indiceTrasCambio(["tarea:a"], null, 0)).toBe(0);
    expect(indiceTrasCambio([], null, 3)).toBe(0);
  });
});

describe("Copilot — título de la carta", () => {
  it("dice qué hacer y con quién", () => {
    expect(tituloActividad("LLAMADA", "Uberto")).toBe("Llamar a Uberto");
    expect(tituloActividad("WHATSAPP", "Uberto")).toBe("Mandar WhatsApp a Uberto");
    expect(tituloActividad("CORREO", "Uberto")).toBe("Mandar correo a Uberto");
    expect(tituloActividad("SMS", "Uberto")).toBe("Mandar SMS a Uberto");
    expect(tituloActividad("BUZON", "Uberto")).toBe("Dejar buzón de voz a Uberto");
    expect(tituloActividad("MISMO_CANAL", "Uberto")).toBe("Contestarle a Uberto por donde escribió");
  });
});
