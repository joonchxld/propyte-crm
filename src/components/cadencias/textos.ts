// #993 — Textos del módulo Cadencias (motivos de cierre y anclas), compartidos por las páginas.
export const MOTIVO_FIN_LABELS: Record<string, string> = {
  RESPONDIO: "respondió",
  SALIO_DEL_ESTADO: "cambió de estado",
  YA_NO_APLICA: "ya no aplica",
  SIN_RESPUESTA: "plazo cumplido",
  CITA_AGENDADA: "cita agendada",
  CAMBIO_RAMA: "cambió de rama",
};

export const ANCLA_LABELS: Record<string, string> = {
  ALTA: "El alta (o la llegada a Nuevo / Sin respuesta)",
  RESPUESTA: "La respuesta del lead",
  CLASIFICACION: "El momento en que se clasifica",
  FIN_CADENCIA: "El fin de la cadencia anterior",
  ULTIMO_INBOUND: "El último mensaje del lead",
};
