-- #993 — Módulo «Cadencias» (Desempeño): las cadencias de Copilot pasan a ser datos editables, y
-- entran la clasificación de respuestas (R2) y las ramas Interesado, Ahora no, Reperfilar y
-- Nutrición del PDF «Copilot · Cadencias por Rama» (Luis, 09-nov).
--
-- Qué hace:
--   1. Razones de salida nuevas (R12): YA_COMPRO y NUMERO_EQUIVOCADO en Contactado perdido.
--   2. copilot_cadencia_defs y copilot_cadencia_pasos: una fila por cadencia y una por toque. Las
--      edita el módulo Cadencias (ADMIN, DIRECTOR, GERENTE) y las sigue Copilot. Se siembran:
--        - NUEVOS y BASE_DE_DATOS: idénticas, paso por paso, al calendario que estaba en código
--          (#988; lo comprueba la prueba de paridad);
--        - AGENDAR, REPERFILAR, POSPUSO, NUTRICION, GHOSTING (solo al terminar Agendar sin cita),
--          BAJA y YA_COMPRO.
--   3. copilot_clasificaciones: la tarea «Clasificar respuesta» cuando el lead responde.
--   4. copilot_cadencias: tipo ligado al catálogo, estado PAUSADA (esperando clasificación),
--      ancla (anclaAt / anclaTipo), ignorarAntesDe («no era respuesta») y origenId.
--      copilot_toques: programadoAt (tiempos en minutos, R3), expiraAt, nota, canal MISMO_CANAL
--      y resultado EXPIRADO.
--   5. El disparador de contactos (trg_contacts_zz_copilot_cadencia) ahora sabe de todas las
--      cadencias: cada una sigue viva mientras el contacto esté en sus estados.
--   6. Plantillas R_ del Anexo A (40 filas ES/EN) en copilot_plantillas (Mi Configuración →
--      Plantillas → «Copilot (generales)»).
--
-- No mueve contactos ni crea toques. Idempotente: volver a correrla no pisa lo editado en el
-- módulo ni en Plantillas. Va en una transacción. Aplicar en Supabase → SQL Editor
-- (oaijxdpevakashxshhvm) ANTES de desplegar el código.
--
-- Comprobación:
--   SELECT tipo, nombre, activa, (SELECT count(*) FROM propyte_crm.copilot_cadencia_pasos p WHERE p.tipo = d.tipo) pasos
--     FROM propyte_crm.copilot_cadencia_defs d ORDER BY orden;                 -- 9 cadencias
--   SELECT count(*) FROM propyte_crm.copilot_plantillas WHERE codigo LIKE 'R\_%';   -- 40

BEGIN;

-- ───────────────────────────── 1. razones nuevas ─────────────────────────────
ALTER TYPE propyte_crm."RazonSalida" ADD VALUE IF NOT EXISTS 'YA_COMPRO';
ALTER TYPE propyte_crm."RazonSalida" ADD VALUE IF NOT EXISTS 'NUMERO_EQUIVOCADO';

CREATE OR REPLACE FUNCTION propyte_crm.razon_salida_valida(e propyte_crm."EstadoContacto", r propyte_crm."RazonSalida")
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT r IS NULL OR CASE e::text
    WHEN 'PERDIDO' THEN r::text IN ('DATOS_INCORRECTOS', 'SIN_RESPUESTA_TRAS_CADENCIA', 'DUPLICADO', 'SPAM', 'PROTEGIDO_POR_BROKER', 'OTRO')
    WHEN 'CONTACTADO_PERDIDO' THEN r::text IN ('NO_CALIFICA', 'NO_LE_INTERESA', 'POSPUSO', 'DEJO_DE_RESPONDER', 'NO_CONTACTAR', 'YA_COMPRO', 'NUMERO_EQUIVOCADO', 'OTRO')
    WHEN 'NEGOCIO_PERDIDO' THEN r::text IN ('ELIGIO_OTRA_OPCION', 'PRECIO', 'FINANCIAMIENTO', 'PRODUCTO', 'CONFIANZA', 'POSPUSO', 'SITUACION_PERSONAL', 'DEJO_DE_RESPONDER', 'CANCELO_APARTADO', 'NO_CONTACTAR', 'OTRO')
    ELSE false
  END;
$$;

-- ───────────────────────────── 2. catálogo de cadencias ─────────────────────────────
CREATE TABLE IF NOT EXISTS propyte_crm.copilot_cadencia_defs (
  "tipo"              TEXT PRIMARY KEY CHECK ("tipo" ~ '^[A-Z0-9_]{2,30}$'),
  "nombre"            TEXT NOT NULL,
  "rama"              TEXT NOT NULL,
  "descripcion"       TEXT NOT NULL DEFAULT '',
  "disparador"        TEXT NOT NULL DEFAULT '',
  "anclaTipo"         TEXT NOT NULL CHECK ("anclaTipo" IN ('ALTA', 'RESPUESTA', 'CLASIFICACION', 'FIN_CADENCIA', 'ULTIMO_INBOUND')),
  "estados"           TEXT[] NOT NULL,
  "respuestaTermina"  BOOLEAN NOT NULL DEFAULT true,
  "terminaConCita"    BOOLEAN NOT NULL DEFAULT false,
  "ignoraNoContactar" BOOLEAN NOT NULL DEFAULT false,
  "finDias"           INTEGER NOT NULL CHECK ("finDias" BETWEEN 1 AND 730),
  "finAncla"          TEXT NOT NULL DEFAULT 'CADENCIA' CHECK ("finAncla" IN ('CADENCIA', 'FECHA_RECONTACTO')),
  "finEstado"         TEXT,
  "finSubestado"      TEXT,
  "finRazon"          TEXT,
  "finSiguiente"      TEXT,
  "activa"            BOOLEAN NOT NULL DEFAULT true,
  "orden"             INTEGER NOT NULL DEFAULT 0,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedById"       TEXT
);

CREATE TABLE IF NOT EXISTS propyte_crm.copilot_cadencia_pasos (
  "id"          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tipo"        TEXT NOT NULL REFERENCES propyte_crm.copilot_cadencia_defs("tipo") ON DELETE CASCADE,
  "codigo"      TEXT NOT NULL CHECK ("codigo" ~ '^[A-Z0-9_]{1,20}$'),
  "canal"       TEXT NOT NULL CHECK ("canal" IN ('LLAMADA', 'WHATSAPP', 'SMS', 'CORREO', 'BUZON', 'MISMO_CANAL')),
  "offset"      INTEGER NOT NULL,
  "unidad"      TEXT NOT NULL CHECK ("unidad" IN ('DIA', 'MIN')),
  "ancla"       TEXT NOT NULL DEFAULT 'CADENCIA' CHECK ("ancla" IN ('CADENCIA', 'FECHA_RECONTACTO')),
  "plantilla"   TEXT,
  "paises"      TEXT[] NOT NULL DEFAULT '{}',
  "whatsapp"    TEXT NOT NULL DEFAULT 'SIEMPRE' CHECK ("whatsapp" IN ('SIEMPRE', 'CON_WA', 'SIN_WA')),
  "cuando"      TEXT NOT NULL,
  "nota"        TEXT,
  "orden"       INTEGER NOT NULL,
  "activo"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
  "updatedById" TEXT
);
CREATE INDEX IF NOT EXISTS copilot_cadencia_pasos_tipo_idx ON propyte_crm.copilot_cadencia_pasos ("tipo", "orden");

-- ───────────────────────────── 3. clasificación de respuestas ─────────────────────────────
CREATE TABLE IF NOT EXISTS propyte_crm.copilot_clasificaciones (
  "id"              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "contactId"       TEXT NOT NULL REFERENCES propyte_crm.contacts("id") ON DELETE CASCADE,
  "cadenciaId"      TEXT REFERENCES propyte_crm.copilot_cadencias("id") ON DELETE SET NULL,
  "respuestaAt"     TIMESTAMP(3) NOT NULL,
  "estadoAntes"     TEXT,
  "subestadoAntes"  TEXT,
  "resultado"       TEXT CHECK ("resultado" IS NULL OR "resultado" IN ('INTERESADO', 'AHORA_NO', 'NO_ES_LO_QUE_BUSCA', 'NO_LE_INTERESA', 'BAJA', 'YA_COMPRO', 'DATOS_INCORRECTOS', 'EQUIVOCADO', 'NO_ERA_RESPUESTA', 'SIN_CLASIFICAR')),
  "fechaRecontacto" DATE,
  "resueltaAt"      TIMESTAMP(3),
  "resueltaPorId"   TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);
CREATE UNIQUE INDEX IF NOT EXISTS copilot_clasificaciones_una_pendiente ON propyte_crm.copilot_clasificaciones ("contactId") WHERE "resultado" IS NULL;
CREATE INDEX IF NOT EXISTS copilot_clasificaciones_contact_idx ON propyte_crm.copilot_clasificaciones ("contactId");

ALTER TABLE propyte_crm.copilot_cadencia_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE propyte_crm.copilot_cadencia_pasos ENABLE ROW LEVEL SECURITY;
ALTER TABLE propyte_crm.copilot_clasificaciones ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────── 4. cadencias y toques ─────────────────────────────
-- Se quitan los CHECK de tipo, estado y motivoFin de la #988 (se buscan por su definición: el
-- nombre lo puso Postgres) y se vuelven a poner con los valores nuevos.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname, conrelid::regclass::text AS tabla FROM pg_constraint
     WHERE contype = 'c'
       AND ((conrelid = 'propyte_crm.copilot_cadencias'::regclass
             AND (pg_get_constraintdef(oid) LIKE '%tipo%' OR pg_get_constraintdef(oid) LIKE '%estado%' OR pg_get_constraintdef(oid) LIKE '%motivoFin%'))
         OR (conrelid = 'propyte_crm.copilot_toques'::regclass
             AND (pg_get_constraintdef(oid) LIKE '%canal%' OR pg_get_constraintdef(oid) LIKE '%resultado%')))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tabla, c.conname);
  END LOOP;
END $$;

ALTER TABLE propyte_crm.copilot_cadencias
  ADD COLUMN IF NOT EXISTS "anclaAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "anclaTipo"      TEXT,
  ADD COLUMN IF NOT EXISTS "ignorarAntesDe" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "origenId"       TEXT;
UPDATE propyte_crm.copilot_cadencias SET "anclaAt" = "inicio", "anclaTipo" = 'ALTA' WHERE "anclaAt" IS NULL;
ALTER TABLE propyte_crm.copilot_cadencias
  ADD CONSTRAINT copilot_cadencias_estado_check CHECK ("estado" IN ('ACTIVA', 'PAUSADA', 'TERMINADA')),
  ADD CONSTRAINT copilot_cadencias_motivo_fin_check CHECK ("motivoFin" IS NULL OR "motivoFin" IN ('RESPONDIO', 'SALIO_DEL_ESTADO', 'YA_NO_APLICA', 'SIN_RESPUESTA', 'CITA_AGENDADA', 'CAMBIO_RAMA'));

ALTER TABLE propyte_crm.copilot_toques
  ADD COLUMN IF NOT EXISTS "programadoAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "expiraAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nota"         TEXT;
UPDATE propyte_crm.copilot_toques SET "programadoAt" = "createdAt" WHERE "programadoAt" IS NULL;
ALTER TABLE propyte_crm.copilot_toques
  ALTER COLUMN "programadoAt" SET NOT NULL,
  ALTER COLUMN "programadoAt" SET DEFAULT (now() AT TIME ZONE 'UTC'),
  ADD CONSTRAINT copilot_toques_canal_check CHECK ("canal" IN ('LLAMADA', 'WHATSAPP', 'SMS', 'CORREO', 'BUZON', 'MISMO_CANAL')),
  ADD CONSTRAINT copilot_toques_resultado_check CHECK ("resultado" IS NULL OR "resultado" IN ('CONTESTO', 'NO_CONTESTO', 'DEJADO', 'ENVIADO', 'RESPONDIO', 'NO_SE_PUDO', 'NO_HECHO', 'EXPIRADO'));

-- ───────────────────────────── 5. siembra del catálogo ─────────────────────────────
-- Generado con sqlDeSiembra() de src/lib/copilot/cadencias-def.ts (la prueba cadencias-def.test.ts
-- comprueba que este bloque es exactamente ese). No editar a mano: se cambia el .ts y se regenera.
-- <siembra>
INSERT INTO propyte_crm.copilot_cadencia_defs ("tipo", "nombre", "rama", "descripcion", "disparador", "anclaTipo", "estados", "respuestaTermina", "terminaConCita", "ignoraNoContactar", "finDias", "finAncla", "finEstado", "finSubestado", "finRazon", "finSiguiente", "activa", "orden") VALUES
('NUEVOS', 'Cadencia de nuevos', 'General', 'Primer contacto: 7 llamadas, 5 WhatsApp, 5 correos, y SMS y buzón para +1 (PDF «Cadencia Multicanal»).', 'Alta en Nuevo o Sin respuesta, o llega a uno de esos dos estados desde otro.', 'ALTA', ARRAY['NUEVO', 'SIN_RESPUESTA']::text[], true, false, false, 15, 'CADENCIA', 'PERDIDO', NULL, 'SIN_RESPUESTA_TRAS_CADENCIA', 'NUTRICION', true, 10),
('BASE_DE_DATOS', 'Cadencia ligera (Base de datos)', 'General', 'Leads de Base de datos: WhatsApp el día 1, correo el día 7 y cierre el día 14 (Luis, ronda 4).', 'Como la de nuevos, cuando la fuente es Base de datos.', 'ALTA', ARRAY['NUEVO', 'SIN_RESPUESTA']::text[], true, false, false, 14, 'CADENCIA', 'PERDIDO', NULL, 'SIN_RESPUESTA_TRAS_CADENCIA', 'NUTRICION', true, 20),
('AGENDAR', 'Agendar cita', 'A · Interesado', 'El lead quiere ver opciones: dos preguntas de perfil y dos horarios hasta tener la cita.', 'El asesor clasifica la respuesta como «Interesado».', 'RESPUESTA', ARRAY['CONTACTADO']::text[], false, true, false, 5, 'CADENCIA', NULL, NULL, NULL, 'GHOSTING', true, 30),
('GHOSTING', 'Dejó de responder', 'C2 · Ghosting', 'Respondió y desapareció. En esta entrega solo entra al terminar «Agendar cita» sin cita (la detección a las 48 h es la fase 2B).', '«Agendar cita» termina sin cita.', 'ULTIMO_INBOUND', ARRAY['CONTACTADO']::text[], true, true, false, 15, 'CADENCIA', 'CONTACTADO_PERDIDO', NULL, 'DEJO_DE_RESPONDER', 'NUTRICION', true, 40),
('REPERFILAR', 'Reperfilar', 'B3 · No es lo que busca', 'Pregunta qué sí le serviría (zona, rango o tipo) y, a los 3 días, un correo con lo único que encaja o la verdad de que hoy no hay.', 'El asesor clasifica la respuesta como «No es lo que busca».', 'RESPUESTA', ARRAY['CONTACTADO']::text[], true, false, false, 4, 'CADENCIA', 'CONTACTADO_PERDIDO', NULL, 'NO_LE_INTERESA', 'NUTRICION', true, 50),
('POSPUSO', 'Ahora no (pospuso)', 'B2 · Ahora no', 'Respeta la fecha que pidió: un mensaje al clasificar, un correo trimestral mientras tanto y retomar el día que dijo.', 'El asesor clasifica «Ahora no» con fecha (sin fecha: 90 días).', 'CLASIFICACION', ARRAY['CONTACTADO_PERDIDO']::text[], true, false, false, 6, 'FECHA_RECONTACTO', NULL, NULL, NULL, 'NUTRICION', true, 60),
('NUTRICION', 'Nutrición', 'C1 · Nunca contestó', 'Silencio de 2 semanas y luego un toque al mes con un dato real; archivo al día 180.', 'Termina la cadencia de nuevos sin respuesta (y al final de Reperfilar, Dejó de responder y Ahora no).', 'FIN_CADENCIA', ARRAY['PERDIDO', 'CONTACTADO_PERDIDO', 'NEGOCIO_PERDIDO']::text[], true, false, false, 180, 'CADENCIA', NULL, NULL, NULL, NULL, true, 70),
('BAJA', 'Baja', 'B1 · Baja', 'Una sola confirmación y no se le vuelve a escribir: el contacto queda en «No contactar».', 'El asesor clasifica «Baja» (o el lead manda STOP).', 'CLASIFICACION', ARRAY['CONTACTADO_PERDIDO']::text[], false, false, true, 1, 'CADENCIA', NULL, NULL, NULL, NULL, true, 80),
('YA_COMPRO', 'Ya compró', 'B4 · Ya compró', 'Felicitar y ofrecer una actualización de vez en cuando; nutrición solo si acepta.', 'El asesor clasifica «Ya compró».', 'CLASIFICACION', ARRAY['CONTACTADO_PERDIDO']::text[], false, false, false, 2, 'CADENCIA', NULL, NULL, NULL, NULL, true, 90)
ON CONFLICT ("tipo") DO NOTHING;

INSERT INTO propyte_crm.copilot_cadencia_pasos ("tipo", "codigo", "canal", "offset", "unidad", "ancla", "plantilla", "paises", "whatsapp", "cuando", "nota", "orden", "activo")
SELECT v.* FROM (VALUES
('NUEVOS', 'WA1', 'WHATSAPP', 0, 'DIA', 'CADENCIA', 'WA1', ARRAY['OTRO']::text[], 'CON_WA', 'Antes de la llamada', NULL, 10, true),
('NUEVOS', 'L1', 'LLAMADA', 0, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[YA]', NULL, 20, true),
('NUEVOS', 'WA1', 'WHATSAPP', 0, 'DIA', 'CADENCIA', 'WA1', ARRAY['MX', 'US', 'CA']::text[], 'CON_WA', 'Después de la L1', NULL, 30, true),
('NUEVOS', 'SMS1', 'SMS', 0, 'DIA', 'CADENCIA', 'SMS_C1_CON_WA', ARRAY['US', 'CA']::text[], 'CON_WA', 'Junto con el WhatsApp o la llamada', NULL, 40, true),
('NUEVOS', 'SMS1', 'SMS', 0, 'DIA', 'CADENCIA', 'SMS_C1_SIN_WA', ARRAY['US']::text[], 'SIN_WA', 'Junto con el WhatsApp o la llamada', NULL, 50, true),
('NUEVOS', 'L2', 'LLAMADA', 0, 'DIA', 'CADENCIA', NULL, ARRAY['MX', 'US', 'CA']::text[], 'SIEMPRE', '[FRANJA_OPUESTA]', NULL, 60, true),
('NUEVOS', 'BUZON1', 'BUZON', 0, 'DIA', 'CADENCIA', 'BUZON1', ARRAY['US', 'CA']::text[], 'SIEMPRE', 'Si la L2 no contesta (menos de 20 s)', NULL, 70, true),
('NUEVOS', 'CORREO1', 'CORREO', 0, 'DIA', 'CADENCIA', 'CORREO1', ARRAY['US']::text[], 'SIEMPRE', 'En horario laboral', NULL, 80, true),
('NUEVOS', 'L3', 'LLAMADA', 1, 'DIA', 'CADENCIA', NULL, ARRAY['MX', 'US', 'CA']::text[], 'SIEMPRE', '[FRANJA]', NULL, 90, true),
('NUEVOS', 'CORREO1', 'CORREO', 1, 'DIA', 'CADENCIA', 'CORREO1', ARRAY['MX', 'CA', 'OTRO']::text[], 'SIEMPRE', 'En horario laboral', NULL, 100, true),
('NUEVOS', 'WA2', 'WHATSAPP', 3, 'DIA', 'CADENCIA', 'WA2', ARRAY['OTRO']::text[], 'CON_WA', 'Antes de la llamada', NULL, 110, true),
('NUEVOS', 'L4', 'LLAMADA', 3, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA_OPUESTA]', NULL, 120, true),
('NUEVOS', 'WA2', 'WHATSAPP', 3, 'DIA', 'CADENCIA', 'WA2', ARRAY['MX', 'US', 'CA']::text[], 'CON_WA', 'Después de la L4', NULL, 130, true),
('NUEVOS', 'SMS2', 'SMS', 3, 'DIA', 'CADENCIA', 'SMS_R2', ARRAY['US']::text[], 'SIN_WA', 'Junto con el WhatsApp o la llamada', NULL, 140, true),
('NUEVOS', 'CORREO2', 'CORREO', 4, 'DIA', 'CADENCIA', 'CORREO2', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 150, true),
('NUEVOS', 'SMS2', 'SMS', 5, 'DIA', 'CADENCIA', 'SMS_C2', ARRAY['US', 'CA']::text[], 'CON_WA', 'Junto con el WhatsApp o la llamada', NULL, 160, true),
('NUEVOS', 'WA3', 'WHATSAPP', 6, 'DIA', 'CADENCIA', 'WA3', ARRAY['OTRO']::text[], 'CON_WA', 'Antes de la llamada', NULL, 170, true),
('NUEVOS', 'L5', 'LLAMADA', 6, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', NULL, 180, true),
('NUEVOS', 'WA3', 'WHATSAPP', 6, 'DIA', 'CADENCIA', 'WA3', ARRAY['MX', 'US', 'CA']::text[], 'CON_WA', 'Después de la L5', NULL, 190, true),
('NUEVOS', 'SMS3', 'SMS', 7, 'DIA', 'CADENCIA', 'SMS_R3', ARRAY['US']::text[], 'SIN_WA', 'Junto con el WhatsApp o la llamada', NULL, 200, true),
('NUEVOS', 'CORREO3', 'CORREO', 7, 'DIA', 'CADENCIA', 'CORREO3', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 210, true),
('NUEVOS', 'WA4', 'WHATSAPP', 9, 'DIA', 'CADENCIA', 'WA4', ARRAY['OTRO']::text[], 'CON_WA', 'Antes de la llamada', NULL, 220, true),
('NUEVOS', 'L6', 'LLAMADA', 9, 'DIA', 'CADENCIA', NULL, ARRAY['MX', 'US', 'CA']::text[], 'SIEMPRE', '[FRANJA_OPUESTA]', NULL, 230, true),
('NUEVOS', 'WA4', 'WHATSAPP', 9, 'DIA', 'CADENCIA', 'WA4', ARRAY['MX', 'US', 'CA']::text[], 'CON_WA', 'Después de la L6', NULL, 240, true),
('NUEVOS', 'BUZON2', 'BUZON', 9, 'DIA', 'CADENCIA', 'BUZON2', ARRAY['US', 'CA']::text[], 'SIEMPRE', 'Si la L6 no contesta (menos de 20 s)', NULL, 250, true),
('NUEVOS', 'CORREO4', 'CORREO', 10, 'DIA', 'CADENCIA', 'CORREO4', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 260, true),
('NUEVOS', 'SMS3', 'SMS', 11, 'DIA', 'CADENCIA', 'SMS_C3', ARRAY['US', 'CA']::text[], 'CON_WA', 'Junto con el WhatsApp o la llamada', NULL, 270, true),
('NUEVOS', 'WA5', 'WHATSAPP', 12, 'DIA', 'CADENCIA', 'WA5', ARRAY['OTRO']::text[], 'CON_WA', 'Antes de la llamada', NULL, 280, true),
('NUEVOS', 'L7', 'LLAMADA', 12, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', NULL, 290, true),
('NUEVOS', 'WA5', 'WHATSAPP', 12, 'DIA', 'CADENCIA', 'WA5', ARRAY['MX', 'US', 'CA']::text[], 'CON_WA', 'Después de la L7', NULL, 300, true),
('NUEVOS', 'SMS4', 'SMS', 12, 'DIA', 'CADENCIA', 'SMS_R4', ARRAY['US']::text[], 'SIN_WA', 'Junto con el WhatsApp o la llamada', NULL, 310, true),
('NUEVOS', 'CORREO5', 'CORREO', 14, 'DIA', 'CADENCIA', 'CORREO5', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 320, true),
('BASE_DE_DATOS', 'WA1', 'WHATSAPP', 0, 'DIA', 'CADENCIA', 'WA1_BASE_DE_DATOS', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 10, true),
('BASE_DE_DATOS', 'SMS1', 'SMS', 0, 'DIA', 'CADENCIA', 'SMS_C1_SIN_WA', ARRAY['US']::text[], 'SIN_WA', 'En horario laboral', NULL, 20, true),
('BASE_DE_DATOS', 'CORREO2', 'CORREO', 6, 'DIA', 'CADENCIA', 'CORREO2', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 30, true),
('BASE_DE_DATOS', 'WA5', 'WHATSAPP', 13, 'DIA', 'CADENCIA', 'WA5', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 40, true),
('BASE_DE_DATOS', 'SMS4', 'SMS', 13, 'DIA', 'CADENCIA', 'SMS_R4', ARRAY['US']::text[], 'SIN_WA', 'En horario laboral', NULL, 50, true),
('AGENDAR', 'A1', 'MISMO_CANAL', 0, 'MIN', 'CADENCIA', 'R_A1', '{}'::text[], 'SIEMPRE', 'En menos de 5 min desde que respondió', NULL, 10, true),
('AGENDAR', 'A2', 'MISMO_CANAL', 120, 'MIN', 'CADENCIA', 'R_A2', '{}'::text[], 'SIEMPRE', '2 h después de la respuesta', 'Solo si contestó las preguntas pero no eligió horario; si no, márcalo «No se pudo».', 20, true),
('AGENDAR', 'A3L', 'LLAMADA', 1, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', NULL, 30, true),
('AGENDAR', 'A3', 'WHATSAPP', 1, 'DIA', 'CADENCIA', 'R_A3', '{}'::text[], 'CON_WA', 'Si la llamada no contesta', NULL, 40, true),
('AGENDAR', 'A3', 'SMS', 1, 'DIA', 'CADENCIA', 'R_A3', ARRAY['US']::text[], 'SIN_WA', 'Si la llamada no contesta', NULL, 50, true),
('AGENDAR', 'A4', 'CORREO', 2, 'DIA', 'CADENCIA', 'R_A4', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 60, true),
('AGENDAR', 'A5', 'WHATSAPP', 4, 'DIA', 'CADENCIA', 'R_A5', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 70, true),
('AGENDAR', 'A5', 'SMS', 4, 'DIA', 'CADENCIA', 'R_A5', ARRAY['US']::text[], 'SIN_WA', 'En horario laboral', NULL, 80, true),
('GHOSTING', 'C2A', 'MISMO_CANAL', 2, 'DIA', 'CADENCIA', 'R_C2a', '{}'::text[], 'SIEMPRE', 'Por el canal donde habló', NULL, 10, true),
('GHOSTING', 'C2L', 'LLAMADA', 4, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', NULL, 20, true),
('GHOSTING', 'C2BZ', 'BUZON', 4, 'DIA', 'CADENCIA', 'BUZON2', ARRAY['US', 'CA']::text[], 'SIEMPRE', 'Si la llamada no contesta (máximo 1)', NULL, 30, false),
('GHOSTING', 'C2B', 'CORREO', 7, 'DIA', 'CADENCIA', 'R_C2b', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 40, true),
('GHOSTING', 'C2C', 'WHATSAPP', 10, 'DIA', 'CADENCIA', 'R_C2c', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 50, true),
('GHOSTING', 'C2C', 'SMS', 10, 'DIA', 'CADENCIA', 'R_C2c', ARRAY['US']::text[], 'SIN_WA', 'En horario laboral', NULL, 60, true),
('GHOSTING', 'C2D', 'CORREO', 14, 'DIA', 'CADENCIA', 'R_C2d', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 70, true),
('GHOSTING', 'C2DW', 'WHATSAPP', 14, 'DIA', 'CADENCIA', 'R_C2d', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 80, true),
('REPERFILAR', 'B3A', 'MISMO_CANAL', 0, 'MIN', 'CADENCIA', 'R_B3a', '{}'::text[], 'SIEMPRE', 'En menos de 5 min desde que respondió', NULL, 10, true),
('REPERFILAR', 'B3B', 'CORREO', 3, 'DIA', 'CADENCIA', 'R_B3b', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 20, true),
('POSPUSO', 'B2A', 'MISMO_CANAL', 0, 'MIN', 'CADENCIA', 'R_B2a', '{}'::text[], 'SIEMPRE', 'Al clasificar', NULL, 10, true),
('POSPUSO', 'B2B', 'CORREO', 90, 'DIA', 'CADENCIA', 'R_B2b', '{}'::text[], 'SIEMPRE', 'En horario laboral', 'Solo sale si la fecha de recontacto todavía no llega.', 20, true),
('POSPUSO', 'B2B2', 'CORREO', 180, 'DIA', 'CADENCIA', 'R_B2b', '{}'::text[], 'SIEMPRE', 'En horario laboral', 'Solo sale si la fecha de recontacto todavía no llega.', 30, true),
('POSPUSO', 'B2C', 'WHATSAPP', 0, 'DIA', 'FECHA_RECONTACTO', 'R_B2c', '{}'::text[], 'CON_WA', 'El día que pidió', NULL, 40, true),
('POSPUSO', 'B2C', 'SMS', 0, 'DIA', 'FECHA_RECONTACTO', 'R_B2c', ARRAY['US']::text[], 'SIN_WA', 'El día que pidió', NULL, 50, true),
('POSPUSO', 'B2CC', 'CORREO', 0, 'DIA', 'FECHA_RECONTACTO', 'R_B2c', '{}'::text[], 'SIEMPRE', 'El día que pidió', NULL, 60, true),
('POSPUSO', 'B2L', 'LLAMADA', 5, 'DIA', 'FECHA_RECONTACTO', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', 'Solo si aceptó retomarlo.', 70, true),
('NUTRICION', 'C1A', 'CORREO', 15, 'DIA', 'CADENCIA', 'R_C1a', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 10, true),
('NUTRICION', 'C1B', 'CORREO', 45, 'DIA', 'CADENCIA', 'R_C1b', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 20, true),
('NUTRICION', 'C1C', 'WHATSAPP', 75, 'DIA', 'CADENCIA', 'R_C1c', '{}'::text[], 'CON_WA', 'En horario laboral', NULL, 30, true),
('NUTRICION', 'C1C', 'SMS', 75, 'DIA', 'CADENCIA', 'R_C1c', ARRAY['US']::text[], 'SIN_WA', 'En horario laboral', NULL, 40, true),
('NUTRICION', 'C1CC', 'CORREO', 75, 'DIA', 'CADENCIA', 'R_C1c', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 50, true),
('NUTRICION', 'C1L', 'LLAMADA', 77, 'DIA', 'CADENCIA', NULL, '{}'::text[], 'SIEMPRE', '[FRANJA]', 'Solo si abrió el correo o dio clic.', 60, false),
('NUTRICION', 'C1A2', 'CORREO', 105, 'DIA', 'CADENCIA', 'R_C1a', '{}'::text[], 'SIEMPRE', 'En horario laboral', 'Con un dato nuevo.', 70, true),
('NUTRICION', 'C1B2', 'CORREO', 135, 'DIA', 'CADENCIA', 'R_C1b', '{}'::text[], 'SIEMPRE', 'En horario laboral', 'Con un dato nuevo.', 80, true),
('NUTRICION', 'C1D', 'CORREO', 165, 'DIA', 'CADENCIA', 'R_C1d', '{}'::text[], 'SIEMPRE', 'En horario laboral', NULL, 90, true),
('BAJA', 'B1', 'MISMO_CANAL', 0, 'MIN', 'CADENCIA', 'R_B1', '{}'::text[], 'SIEMPRE', 'Al clasificar', NULL, 10, true),
('YA_COMPRO', 'B4', 'MISMO_CANAL', 0, 'MIN', 'CADENCIA', 'R_B4', '{}'::text[], 'SIEMPRE', 'Al clasificar', NULL, 10, true)
) AS v("tipo", "codigo", "canal", "offset", "unidad", "ancla", "plantilla", "paises", "whatsapp", "cuando", "nota", "orden", "activo")
WHERE NOT EXISTS (SELECT 1 FROM propyte_crm.copilot_cadencia_pasos p WHERE p."tipo" = v."tipo");
-- </siembra>

-- El tipo de cada cadencia apunta al catálogo (las de la #988 son NUEVOS o BASE_DE_DATOS).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copilot_cadencias_tipo_fkey') THEN
    ALTER TABLE propyte_crm.copilot_cadencias
      ADD CONSTRAINT copilot_cadencias_tipo_fkey FOREIGN KEY ("tipo") REFERENCES propyte_crm.copilot_cadencia_defs("tipo");
  END IF;
END $$;

-- ───────────────────────────── 6. disparador ─────────────────────────────
-- Lo que excluye a un contacto de TODAS las cadencias. Paridad con TIPOS_SIN_CADENCIA y
-- FLUJOS_SIN_CADENCIA de src/lib/copilot/cadencia-nuevos.ts.
CREATE OR REPLACE FUNCTION propyte_crm.copilot_contacto_vivo(c propyte_crm.contacts)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT c."deletedAt" IS NULL
     AND c."mergedIntoId" IS NULL
     AND coalesce(c."contactType"::text, '') NOT IN ('BROKER_EXTERNO', 'EMPLEO', 'PROVEEDOR', 'LEAD_VENDEDOR', 'OTRO')
     AND coalesce(c.flujo::text, '') NOT IN ('F1_CORRETAJE_VENDEDOR', 'F3_CAPTACION_MB', 'F6_BROKER', 'F7_INMOBILIARIA', 'F8_EMPLEO');
$$;

-- La cadencia general (#988): contacto vivo, sin No contactar, en Nuevo o Sin respuesta, y que no sea
-- un provisional de comentario.
CREATE OR REPLACE FUNCTION propyte_crm.copilot_aplica_cadencia(c propyte_crm.contacts)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT propyte_crm.copilot_contacto_vivo(c)
     AND NOT coalesce(c."doNotContact", false)
     AND c.estado::text IN ('NUEVO', 'SIN_RESPUESTA')
     AND coalesce(c."leadSourceDetail", '') NOT LIKE 'comentario:%';
$$;

CREATE OR REPLACE FUNCTION propyte_crm.copilot_cadencia_de_contacto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activa  record;
  def     record;
  sigue   boolean;
  general text;
  ahora   timestamp := now() AT TIME ZONE 'UTC';
  local   timestamp := now() AT TIME ZONE 'America/Cancun';
BEGIN
  SELECT k."id", k."tipo" INTO activa
    FROM propyte_crm.copilot_cadencias k
   WHERE k."contactId" = NEW."id" AND k."estado" = 'ACTIVA';

  IF activa."id" IS NOT NULL THEN
    SELECT * INTO def FROM propyte_crm.copilot_cadencia_defs d WHERE d."tipo" = activa."tipo";
    sigue := propyte_crm.copilot_contacto_vivo(NEW)
             AND (NOT coalesce(NEW."doNotContact", false) OR coalesce(def."ignoraNoContactar", false))
             AND NEW.estado::text = ANY (coalesce(def."estados", ARRAY['NUEVO', 'SIN_RESPUESTA']))
             -- La general, además, no sigue con los provisionales de comentario.
             AND (activa."tipo" NOT IN ('NUEVOS', 'BASE_DE_DATOS') OR propyte_crm.copilot_aplica_cadencia(NEW));
    IF NOT sigue THEN
      DELETE FROM propyte_crm.copilot_toques WHERE "cadenciaId" = activa."id" AND "resultado" IS NULL;
      UPDATE propyte_crm.copilot_cadencias
         SET "estado" = 'TERMINADA',
             "finAt" = ahora,
             "motivoFin" = CASE WHEN NEW.estado::text = ANY (coalesce(def."estados", ARRAY['NUEVO', 'SIN_RESPUESTA']))
                                THEN 'YA_NO_APLICA' ELSE 'SALIO_DEL_ESTADO' END
       WHERE "id" = activa."id";
    END IF;
    RETURN NULL;
  END IF;

  -- Inscripción en la cadencia general (#988). Las de las ramas las abre la clasificación.
  IF NOT propyte_crm.copilot_aplica_cadencia(NEW) THEN
    RETURN NULL;
  END IF;
  -- Esperando que el asesor clasifique una respuesta: no se abre otra.
  IF EXISTS (SELECT 1 FROM propyte_crm.copilot_cadencias k WHERE k."contactId" = NEW."id" AND k."estado" = 'PAUSADA') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."originalCreatedAt" IS NOT NULL AND NEW."originalCreatedAt" < ahora - interval '30 days' THEN
      RETURN NULL;
    END IF;
  ELSIF NEW.estado IS NOT DISTINCT FROM OLD.estado
        OR coalesce(OLD.estado::text, '') IN ('NUEVO', 'SIN_RESPUESTA') THEN
    RETURN NULL;
  END IF;

  general := CASE WHEN NEW."leadSource"::text = 'BASE_DE_DATOS' THEN 'BASE_DE_DATOS' ELSE 'NUEVOS' END;
  IF NOT EXISTS (SELECT 1 FROM propyte_crm.copilot_cadencia_defs d WHERE d."tipo" = general AND d."activa") THEN
    RETURN NULL;
  END IF;

  INSERT INTO propyte_crm.copilot_cadencias ("contactId", "tipo", "inicio", "diaInicio", "horaEntrada", "anclaAt", "anclaTipo")
  VALUES (NEW."id", general, ahora, local::date, extract(hour FROM local)::int, ahora, 'ALTA')
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_zz_copilot_cadencia ON propyte_crm.contacts;
CREATE TRIGGER trg_contacts_zz_copilot_cadencia
  AFTER INSERT OR UPDATE OF estado, "contactStatus", "contactType", flujo, "doNotContact", "deletedAt", "mergedIntoId"
  ON propyte_crm.contacts
  FOR EACH ROW
  EXECUTE FUNCTION propyte_crm.copilot_cadencia_de_contacto();

-- ───────────────────────────── 7. plantillas de las ramas ─────────────────────────────
-- Plantillas de las ramas (Anexo A del PDF «Cadencias por Rama»). Las que usan las cadencias de
-- esta entrega: A1–A5 (Agendar), B1–B4 (Baja, Ahora no, Reperfilar, Ya compró), C1a–C1d
-- (Nutrición) y C2a–C2d (Dejó de responder). Las de cita, no-show y post-cita (A6–A9, C3, D) entran
-- con sus cadencias (fase 2B). Asuntos: solo los que trae el PDF (en español).
INSERT INTO propyte_crm.copilot_plantillas ("codigo", "idioma", "variante", "canal", "nombre", "asunto", "cuerpo", "orden") VALUES
('R_A1', 'ES', '', 'WHATSAPP', 'A1 · Interesado: dos preguntas y dos horarios', NULL,
$p$¡Qué bueno, [NOMBRE]! Para no mandarte cosas que no te sirven, dos preguntas rápidas: ¿lo ves más como inversión o para usarlo tú? ¿Y en qué plazo te gustaría decidir? Con eso te armo lo que sí pasa el filtro y lo vemos en 20 min. ¿Te queda [HORARIO1] o [HORARIO2]?$p$, 200),
('R_A1', 'EN', '', 'WHATSAPP', 'A1 · Interesado: dos preguntas y dos horarios', NULL,
$p$Great, [NOMBRE]! So I don't send you things you don't need, two quick questions: is this more of an investment or for your own use? And what's your timeline to decide? With that I'll put together what actually clears the filter and we walk through it in 20 min. Does [HORARIO1] or [HORARIO2] work?$p$, 200),
('R_A2', 'ES', '', 'WHATSAPP', 'A2 · Contestó sin elegir horario', NULL,
$p$Perfecto, [NOMBRE], con eso ya tengo claro qué mostrarte. ¿Te va mejor [HORARIO1] o [HORARIO2]? Si ninguno, dime cuál sí y me acomodo.$p$, 201),
('R_A2', 'EN', '', 'WHATSAPP', 'A2 · Contestó sin elegir horario', NULL,
$p$Perfect, [NOMBRE], that tells me exactly what to show you. Does [HORARIO1] or [HORARIO2] work better? If neither, tell me what does and I'll adjust.$p$, 201),
('R_A3', 'ES', '', 'WHATSAPP', 'A3 · Tras llamada perdida', NULL,
$p$[NOMBRE], te acabo de marcar para lo de [PROYECTO]. Sin prisa: ¿te late que lo veamos [HORARIO1]?$p$, 202),
('R_A3', 'EN', '', 'WHATSAPP', 'A3 · Tras llamada perdida', NULL,
$p$[NOMBRE], I just tried calling about [PROYECTO]. No rush: want to go over it at [HORARIO1]?$p$, 202),
('R_A4', 'ES', '', 'CORREO', 'A4 · Lo que sí pasó el filtro', $p$[NOMBRE], lo que sí pasó el filtro$p$,
$p$Hola [NOMBRE]:

Con lo que me contaste, esto es lo que sí tiene sentido para ti en [ZONA] (y por qué):
· [OPCIÓN 1 — 1 línea con dato real]
· [OPCIÓN 2 — 1 línea con dato real]

Lo demás lo descarté. ¿Lo revisamos juntos en 20 min? Elige tu horario aquí: [LINK_AGENDA]

[firma]$p$, 203),
('R_A4', 'EN', '', 'CORREO', 'A4 · Lo que sí pasó el filtro', NULL,
$p$Hi [NOMBRE],

Based on what you told me, here's what actually makes sense for you in [ZONA] (and why):
· [OPTION 1 — 1 line, real data]
· [OPTION 2 — 1 line, real data]

I ruled out the rest. Want to go over it together in 20 min? Pick a time here: [LINK_AGENDA]

[signature]$p$, 203),
('R_A5', 'ES', '', 'WHATSAPP', 'A5 · ¿Esta semana o la próxima?', NULL,
$p$[NOMBRE], ¿lo vemos esta semana o prefieres que te escriba la próxima?$p$, 204),
('R_A5', 'EN', '', 'WHATSAPP', 'A5 · ¿Esta semana o la próxima?', NULL,
$p$[NOMBRE], should we go over it this week, or would you rather I reach out next week?$p$, 204),
('R_B1', 'ES', '', 'WHATSAPP', 'B1 · Confirmación de baja', NULL,
$p$Entendido, [NOMBRE]. Ya te di de baja y no te volveré a escribir. Gracias por avisarme.$p$, 210),
('R_B1', 'EN', '', 'WHATSAPP', 'B1 · Confirmación de baja', NULL,
$p$Understood, [NOMBRE]. I've removed you and won't reach out again. Thanks for letting me know.$p$, 210),
('R_B2a', 'ES', '', 'WHATSAPP', 'B2a · Ahora no: te escribo en [MES]', NULL,
$p$Te entiendo perfecto, [NOMBRE], una decisión así se toma a su tiempo. ¿Te parece si te escribo en [MES] para ver cómo vas? Mientras, no te lleno de mensajes.$p$, 211),
('R_B2a', 'EN', '', 'WHATSAPP', 'B2a · Ahora no: te escribo en [MES]', NULL,
$p$Totally get it, [NOMBRE], a decision like this happens on its own timeline. Mind if I check in around [MES] to see where you're at? Until then, I won't flood you with messages.$p$, 211),
('R_B2b', 'ES', '', 'CORREO', 'B2b · Un dato para tenerlo a la mano', $p$[ZONA], actualización de [MES]$p$,
$p$Hola [NOMBRE]:

Un solo dato para que lo tengas a la mano, sin compromiso: [DATO_NUEVO con fuente]. No todo lo aprovecha, pero sí te da una idea de hacia dónde va [ZONA].

Cuando quieras retomarlo, aquí sigo: [wa.me/NÚMERO]

[firma]$p$, 212),
('R_B2b', 'EN', '', 'CORREO', 'B2b · Un dato para tenerlo a la mano', NULL,
$p$Hi [NOMBRE],

One data point to keep handy, no strings attached: [DATO_NUEVO with source]. Not every property captures it, but it shows where [ZONA] is heading.

Whenever you want to pick it back up, I'm here: [wa.me/NÚMERO]

[signature]$p$, 212),
('R_B2c', 'ES', '', 'WHATSAPP', 'B2c · Llegó la fecha que pidió', NULL,
$p$Hola [NOMBRE], quedamos en hablar por estas fechas sobre [ZONA]. ¿Sigue en tus planes o lo movemos más adelante? Cualquiera de las dos me sirve.$p$, 213),
('R_B2c', 'EN', '', 'WHATSAPP', 'B2c · Llegó la fecha que pidió', NULL,
$p$Hi [NOMBRE], we said we'd reconnect around now about [ZONA]. Still on your radar, or should we push it further out? Either answer works.$p$, 213),
('R_B3a', 'ES', '', 'WHATSAPP', 'B3a · ¿Qué sí tendría que tener?', NULL,
$p$Gracias por decírmelo directo, [NOMBRE], me ahorra mandarte lo que no es. Para no fallarte otra vez: ¿qué sí tendría que tener (zona, rango o tipo) para que valiera la pena verlo?$p$, 214),
('R_B3a', 'EN', '', 'WHATSAPP', 'B3a · ¿Qué sí tendría que tener?', NULL,
$p$Thanks for being straight with me, [NOMBRE], it saves me sending you the wrong things. So I don't miss again: what would it need to have (area, range or type) to be worth a look?$p$, 214),
('R_B3b', 'ES', '', 'CORREO', 'B3b · Lo único que encaja (o la verdad)', NULL,
$p$Hola [NOMBRE]:

Me quedé con lo que me dijiste de [OBJECIÓN]. Revisé y [lo único que sí encaja es OPCIÓN — 1 línea con dato real / hoy no tengo algo que lo resuelva, y prefiero decírtelo]. Si cambia tu búsqueda, aquí estoy: [wa.me/NÚMERO]

[firma]$p$, 215),
('R_B3b', 'EN', '', 'CORREO', 'B3b · Lo único que encaja (o la verdad)', NULL,
$p$Hi [NOMBRE],

I kept in mind what you said about [OBJECIÓN]. I looked again and [the only thing that fits is OPTION — 1 line, real data / right now I don't have anything that solves it, and I'd rather tell you that]. If your search changes, I'm here: [wa.me/NÚMERO]

[signature]$p$, 215),
('R_B4', 'ES', '', 'WHATSAPP', 'B4 · Ya compró: felicitar', NULL,
$p$¡Qué buena noticia, [NOMBRE], felicidades! Si algún día quieres una segunda opinión sobre algo en [ZONA] o datos de cómo se mueve la zona, aquí estoy. ¿Te mando una actualización de vez en cuando o lo dejamos aquí?$p$, 216),
('R_B4', 'EN', '', 'WHATSAPP', 'B4 · Ya compró: felicitar', NULL,
$p$Great news, [NOMBRE], congratulations! If you ever want a second opinion on something in [ZONA] or data on how the area is moving, I'm here. Want me to send an occasional update, or leave it here?$p$, 216),
('R_C1a', 'ES', '', 'CORREO', 'C1a · Nutrición: un dato', $p$[ZONA] en [MES]: un dato$p$,
$p$Hola [NOMBRE]:

Hace unas semanas pediste información de [PROYECTO]. No te escribo para insistir, sino para dejarte un dato que vale la pena tener: [DATO_NUEVO con fuente]. No todo lo aprovecha; si quieres saber qué sí, me escribes: [wa.me/NÚMERO]

[firma]$p$, 220),
('R_C1a', 'EN', '', 'CORREO', 'C1a · Nutrición: un dato', NULL,
$p$Hi [NOMBRE],

A few weeks ago you asked about [PROYECTO]. I'm not writing to push, just to share one data point worth having: [DATO_NUEVO with source]. Not every property captures it; if you want to know which ones do, message me: [wa.me/NÚMERO]

[signature]$p$, 220),
('R_C1b', 'ES', '', 'CORREO', 'C1b · Nutrición: cómo se compra desde fuera', $p$Cómo se compra en [ZONA] desde fuera$p$,
$p$Hola [NOMBRE]:

La duda que más me llega es cómo se compra a distancia sin riesgos. Te lo resumo en 4 pasos: [PASO 1–4 en 1 línea c/u]. Si en algún momento lo quieres ver aplicado a tu caso, aquí sigo: [wa.me/NÚMERO]

[firma]$p$, 221),
('R_C1b', 'EN', '', 'CORREO', 'C1b · Nutrición: cómo se compra desde fuera', NULL,
$p$Hi [NOMBRE],

The question I get most is how to buy from abroad safely. Here it is in 4 steps: [STEP 1–4, 1 line each]. If you ever want it applied to your case, I'm here: [wa.me/NÚMERO]

[signature]$p$, 221),
('R_C1c', 'ES', '', 'WHATSAPP', 'C1c · Nutrición: algo nuevo', NULL,
$p$Hola [NOMBRE], soy [ASESOR], de Propyte. Hace un tiempo viste [PROYECTO]; te escribo porque hay algo nuevo: [NOVEDAD REAL en 1 línea]. ¿Te lo paso?$p$, 222),
('R_C1c', 'EN', '', 'WHATSAPP', 'C1c · Nutrición: algo nuevo', NULL,
$p$Hi [NOMBRE], it's [ASESOR] with Propyte. A while back you looked at [PROYECTO]; reaching out because there's something new: [REAL UPDATE in 1 line]. Want me to send it over?$p$, 222),
('R_C1d', 'ES', '', 'CORREO', 'C1d · Nutrición: cierro tu expediente', $p$Cierro tu expediente, [NOMBRE]$p$,
$p$Hola [NOMBRE]:

Para no seguir ocupando tu bandeja, archivo tu expediente de [PROYECTO]. Si más adelante [ZONA] vuelve a tus planes, respondes este correo y retomamos donde quedamos, sin empezar de cero.

[firma]$p$, 223),
('R_C1d', 'EN', '', 'CORREO', 'C1d · Nutrición: cierro tu expediente', NULL,
$p$Hi [NOMBRE],

So I'm not taking up space in your inbox, I'm filing away your [PROYECTO] inquiry. If [ZONA] comes back into your plans, just reply to this email and we'll pick up where we left off.

[signature]$p$, 223),
('R_C2a', 'ES', '', 'WHATSAPP', 'C2a · Dejó de responder: lo que quedó pendiente', NULL,
$p$[NOMBRE], me quedé con lo que me preguntaste de [PUNTO_PENDIENTE]. Ya lo tengo: ¿te lo mando por aquí o lo vemos en 10 min?$p$, 230),
('R_C2a', 'EN', '', 'WHATSAPP', 'C2a · Dejó de responder: lo que quedó pendiente', NULL,
$p$[NOMBRE], I kept thinking about your question on [PUNTO_PENDIENTE]. I have the answer: want it here, or should we go over it in 10 min?$p$, 230),
('R_C2b', 'ES', '', 'CORREO', 'C2b · Dejó de responder: por escrito', $p$Lo que quedó pendiente: [PUNTO_PENDIENTE]$p$,
$p$Hola [NOMBRE]:

Para que no se quede en el aire, aquí va lo que platicamos: [RESPUESTA / DATO / FICHA en 2–3 líneas]. Con esto ya puedes decidir si vale la pena dar el siguiente paso. ¿Lo vemos? [LINK_AGENDA]

[firma]$p$, 231),
('R_C2b', 'EN', '', 'CORREO', 'C2b · Dejó de responder: por escrito', NULL,
$p$Hi [NOMBRE],

So it doesn't get lost, here's what we discussed: [ANSWER / DATA / SHEET in 2–3 lines]. With this you can decide if the next step is worth it. Want to go over it? [LINK_AGENDA]

[signature]$p$, 231),
('R_C2c', 'ES', '', 'WHATSAPP', 'C2c · ¿Sigues viendo [ZONA]?', NULL,
$p$[NOMBRE], pregunta rápida: ¿sigues viendo [ZONA] o lo pausamos un tiempo? Cualquiera de las dos me sirve.$p$, 232),
('R_C2c', 'EN', '', 'WHATSAPP', 'C2c · ¿Sigues viendo [ZONA]?', NULL,
$p$[NOMBRE], quick question: still looking at [ZONA], or should we pause for a while? Either answer works.$p$, 232),
('R_C2d', 'ES', '', 'WHATSAPP', 'C2d · Lo dejo en pausa', NULL,
$p$[NOMBRE], lo dejo en pausa por mi lado para no saturarte. Todo lo que vimos queda guardado; cuando quieras retomarlo me escribes y seguimos justo donde nos quedamos.$p$, 233),
('R_C2d', 'EN', '', 'WHATSAPP', 'C2d · Lo dejo en pausa', NULL,
$p$[NOMBRE], I'll put this on pause on my end so I don't overload you. Everything we covered is saved; whenever you want to pick it back up, message me and we'll continue right where we left off.$p$, 233)
ON CONFLICT ("codigo", "idioma", "variante") DO NOTHING;

COMMIT;
