-- #996 — «Agendar cita» cuenta como cita cuando el contacto pasa a Reunión (o más adelante),
-- aunque el asesor cambie el estado antes de registrar la reunión.
--
-- Por qué: en la prueba en vivo de la #993 (10-nov) el asesor pasó el contacto a Reunión y
-- después registró la reunión. El disparador de contactos cerró «Agendar cita» como
-- SALIO_DEL_ESTADO («el contacto cambió de estado»), y el proceso que busca reuniones ya no la vio
-- porque solo revisa cadencias activas. El contacto quedó bien, pero la cadencia no contó como cita.
--
-- Qué hace:
--   1. Reemplaza propyte_crm.copilot_cadencia_de_contacto() (la de la #993) con un solo cambio:
--      si la cadencia termina con cita (Agendar cita) y el contacto pasa a REUNION, DEMO,
--      RECORRIDO, PROPUESTA, APARTADO, FIRMA, ESCRITURA o POSTVENTA, el motivo es CITA_AGENDADA.
--      Todo lo demás queda idéntico (lo comprueba una prueba contra la migración de la #993).
--   2. Corrige las que ya se cerraron así: cadencias con «termina con cita», motivo
--      SALIO_DEL_ESTADO y contacto hoy en una de esas etapas.
--
-- No toca el disparador (sigue siendo trg_contacts_zz_copilot_cadencia, misma función y columnas).
-- Se puede correr más de una vez.
--
-- Revertir: volver a correr la sección 6 de 2026-11-09-cadencias-por-rama.sql (la función
-- anterior). Las filas corregidas en el paso 2 pueden quedarse: el motivo nuevo es el correcto.

BEGIN;

-- ───────────────────────────── 1. disparador de contactos ─────────────────────────────
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
                                THEN 'YA_NO_APLICA'
                                -- #996: en «Agendar cita», llegar a Reunión o más adelante es la cita,
                                -- aunque el asesor cambie el estado antes de registrar la reunión.
                                WHEN coalesce(def."terminaConCita", false)
                                     AND NEW.estado::text = ANY (ARRAY['REUNION', 'DEMO', 'RECORRIDO', 'PROPUESTA', 'APARTADO', 'FIRMA', 'ESCRITURA', 'POSTVENTA'])
                                THEN 'CITA_AGENDADA'
                                ELSE 'SALIO_DEL_ESTADO' END
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

-- ───────────────────────────── 2. las que ya se cerraron así ─────────────────────────────
UPDATE propyte_crm.copilot_cadencias k
   SET "motivoFin" = 'CITA_AGENDADA'
  FROM propyte_crm.copilot_cadencia_defs d, propyte_crm.contacts c
 WHERE d."tipo" = k."tipo"
   AND d."terminaConCita"
   AND c."id" = k."contactId"
   AND k."estado" = 'TERMINADA'
   AND k."motivoFin" = 'SALIO_DEL_ESTADO'
   AND c.estado::text = ANY (ARRAY['REUNION', 'DEMO', 'RECORRIDO', 'PROPUESTA', 'APARTADO', 'FIRMA', 'ESCRITURA', 'POSTVENTA']);

COMMIT;
