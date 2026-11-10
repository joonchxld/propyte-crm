// #993 — Lo que acepta la API del módulo Cadencias al crear o editar un paso. La validación de
// fondo (rangos, plantilla obligatoria en mensajes) es validarPaso() de cadencias-def.ts.
import { z } from "zod";

export const pasoSchema = z.object({
  codigo: z.string().max(20).optional(),
  canal: z.enum(["LLAMADA", "WHATSAPP", "SMS", "CORREO", "BUZON", "MISMO_CANAL"]).optional(),
  offset: z.number().int().optional(),
  unidad: z.enum(["DIA", "MIN"]).optional(),
  ancla: z.enum(["CADENCIA", "FECHA_RECONTACTO"]).optional(),
  plantilla: z.string().max(40).nullable().optional(),
  paises: z.array(z.enum(["MX", "US", "CA", "OTRO"])).optional(),
  whatsapp: z.enum(["SIEMPRE", "CON_WA", "SIN_WA"]).optional(),
  cuando: z.string().max(200).optional(),
  nota: z.string().max(300).nullable().optional(),
  orden: z.number().int().optional(),
  activo: z.boolean().optional(),
});
