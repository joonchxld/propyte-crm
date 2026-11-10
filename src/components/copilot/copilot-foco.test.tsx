import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig usa `jsx: preserve`: en vitest el JSX sale como React.createElement.
vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/voice/call-button", () => ({ CallButton: () => null }));

import { CopilotFoco } from "./copilot-foco";
import type { MiDia, TareaLista, ToqueListo } from "@/lib/copilot/mi-dia";
import type { ClasificacionPendiente } from "@/lib/copilot/cadencia-servicio";

// #997 — lo que pidió sistemas@: la actividad actual en grande, una a la vez, y el recuadro
// «Preview irá aquí» abajo a la derecha.

function toque(id: string, orden: number, canal: ToqueListo["canal"], resultado: string | null = null): ToqueListo {
  return {
    id, codigo: id, canal, canalLabel: canal, orden, cuando: "Ahora", resultado, resultadoAt: null, vencido: false,
    texto: canal === "LLAMADA" ? null : { texto: "Hola Uberto", asunto: null, faltan: [], otroIdioma: false },
    variantes: null, variante: null, bloqueo: null, nota: null,
  } as ToqueListo;
}

const TAREA: TareaLista = {
  clave: "cad1:2026-11-10", cadenciaId: "cad1", tipo: "NUEVOS", nombreCadencia: "Cadencia de nuevos", dia: 1,
  ultimoDia: 14, fecha: "2026-11-10", vencida: false, pendientes: 2,
  contacto: {
    id: "c1", nombre: "Uberto Pérez", telefono: "+529990000000", correo: null, idioma: "ES", pais: "MX",
    estado: null, temperatura: "HOT", motivoTemperatura: null,
  },
  toques: [toque("L1", 1, "LLAMADA", "NO_CONTESTO"), toque("WA1", 2, "WHATSAPP"), toque("L2", 3, "LLAMADA")],
};

const vacio = (extra: Partial<MiDia & { clasificar: ClasificacionPendiente[] }> = {}) => ({
  tareas: [], fueraDelTope: 0, hechasHoy: [], vencidas: 0, clasificar: [], ...extra,
});

const texto = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Copilot — una actividad a la vez", () => {
  it("muestra en grande el toque que sigue, no los ya hechos ni los de después", () => {
    const html = renderToStaticMarkup(<CopilotFoco data={vacio({ tareas: [TAREA, { ...TAREA, clave: "cad2:2026-11-10" }] })} userId="u1" />);
    expect(html).toMatch(/<h2[^>]*>Mandar WhatsApp a Uberto Pérez<\/h2>/);
    expect(texto(html)).toContain("Actividad 1 de 2");
    // Una sola carta con su toque abierto: el texto del WhatsApp sale una vez.
    expect(html.match(/Hola Uberto/g)?.length).toBe(1);
    // Los demás toques del día, chicos: L1 hecho, WA1 actual, L2 después.
    expect(html).toMatch(/aria-current="step"[^>]*>[^<]*WA1|aria-current="step"[\s\S]{0,400}WA1/);
  });

  it("las respuestas por clasificar van primero", () => {
    const html = renderToStaticMarkup(
      <CopilotFoco
        data={vacio({
          tareas: [TAREA],
          clasificar: [{ id: "r1", contactId: "c9", nombre: "Mike", respuestaAt: new Date().toISOString(), ultimoMensaje: "Sí me interesa", cadencia: null, temperatura: null }],
        })}
        userId="u1"
      />,
    );
    expect(texto(html)).toContain("Clasificar la respuesta de Mike");
    expect(texto(html)).toContain("Actividad 1 de 2");
    expect(html).not.toContain("Mandar WhatsApp a Uberto");
  });

  it("siempre está el recuadro del preview, también sin actividades", () => {
    const con = renderToStaticMarkup(<CopilotFoco data={vacio({ tareas: [TAREA] })} userId="u1" />);
    const sin = renderToStaticMarkup(<CopilotFoco data={vacio()} userId="u1" />);
    for (const html of [con, sin]) {
      expect(html).toMatch(/<aside[^>]*aria-label="Preview"[^>]*>Preview irá aquí<\/aside>/);
      expect(html).toMatch(/lg:fixed lg:bottom-6 lg:right-6/);
    }
    expect(texto(sin)).toContain("No tienes actividades pendientes");
  });

  it("con una sola actividad, Saltar y Anterior están apagados", () => {
    const html = renderToStaticMarkup(<CopilotFoco data={vacio({ tareas: [TAREA] })} userId="u1" />);
    expect(html.match(/<button[^>]*disabled=""[^>]*>[\s\S]*?(Anterior|Saltar)/g)?.length).toBe(2);
  });

  it("sin la migración, avisa en vez de romperse", () => {
    const html = renderToStaticMarkup(<CopilotFoco data={vacio()} userId="u1" sinMigrar />);
    expect(texto(html)).toContain("falta correr la migración");
  });
});
