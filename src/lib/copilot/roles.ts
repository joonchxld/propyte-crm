// #988 — Quién edita las plantillas de Copilot y quién ve el tablero de vencidas.
// Lógica pura, para servidor y cliente.

/** Editan los textos: dirección comercial, gerencia, Marketing (escribe las cifras) y Admin. */
export const ROLES_EDITAN_PLANTILLAS = ["ADMIN", "DIRECTOR", "GERENTE", "MARKETING"] as const;

export function puedeEditarPlantillas(role: string | null | undefined): boolean {
  return !!role && (ROLES_EDITAN_PLANTILLAS as readonly string[]).includes(role);
}

/** Ven el tablero de vencidas: los mandos y el líder de equipo (de su equipo). */
export const ROLES_VEN_VENCIDAS = ["ADMIN", "DIRECTOR", "GERENTE", "TEAM_LEADER"] as const;

export function puedeVerVencidas(role: string | null | undefined): boolean {
  return !!role && (ROLES_VEN_VENCIDAS as readonly string[]).includes(role);
}

/**
 * #993 — Módulo «Cadencias» (Desempeño): ven y editan el catálogo que sigue Copilot. Pedido de
 * sistemas@ (09-nov): solo administradores, directores y gerentes. Lo importan el menú
 * (nav-config), las páginas y la API, para que el menú y la puerta no se separen. Fail-closed.
 */
export const CADENCIAS_ROLES = ["ADMIN", "DIRECTOR", "GERENTE"] as const;

export function puedeVerCadencias(role: string | null | undefined): boolean {
  return !!role && (CADENCIAS_ROLES as readonly string[]).includes(role);
}
