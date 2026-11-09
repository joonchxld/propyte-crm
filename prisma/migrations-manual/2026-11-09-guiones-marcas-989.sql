-- #989 — Guion propio para el bot de Yaxnáh (y uno para Avica, que hoy tiene el bot apagado).
--
-- Por qué: ninguna de las dos marcas tenía guion (brands.playbookId NULL). Sin guion, el bot de una
-- marca solo contesta dudas: no tiene una lista de datos que conseguir ni guarda lo que el cliente
-- le da. Caso real (Bre, Messenger, 08-nov): dio su celular y su crédito FOVISSSTE, el bot contestó
-- «anoto tu número» pero el teléfono nunca llegó a la ficha y la conversación se quedó con el bot.
--
-- Con este guion el bot pide, una cosa a la vez y después de contestar la duda: nombre → WhatsApp →
-- forma de pago → recámaras. Lo que el cliente contesta se guarda en la ficha (teléfono en «phone»,
-- lo demás en campos propios). Lo que la ficha ya tiene (p. ej. nombre y teléfono del formulario de
-- Meta) se salta. «Messenger»/«Instagram» como nombre NO cuenta como nombre una vez desplegado el
-- código de la #989; antes de eso, el guion se salta la pregunta del nombre para esos contactos.
--
-- Con el código de la #989 desplegado, al completar el guion el bot avisa al cliente que un asesor
-- lo contacta y la conversación pasa al asesor con notificación. Sin ese código, el guion igual
-- funciona (pide y guarda los datos); solo falta ese paso automático.
--
-- Solo DATOS. Idempotente (ids fijos + ON CONFLICT). Una transacción.
-- Aplicar en el SQL Editor de Supabase (oaijxdpevakashxshhvm).

BEGIN;

-- ── Yaxnáh Caucel ──
INSERT INTO "propyte_crm"."bot_playbooks" ("id", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES ('98900000-0000-4000-8000-00000000a001',
        'Yaxnáh — casa propia con crédito',
        'Leads de Yaxnáh Caucel (#989): nombre, WhatsApp, forma de pago (INFONAVIT, FOVISSSTE, bancario o contado) y recámaras. Al completarse, la conversación pasa al asesor para agendar visita o llamada.',
        true, now(), now())
ON CONFLICT ("id") DO UPDATE
   SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "isActive" = true,
       "deletedAt" = NULL, "updatedAt" = now();

INSERT INTO "propyte_crm"."bot_tasks"
  ("id", "playbookId", "order", "key", "objective", "targetField", "captureType", "enumOptions", "extractionHint", "required", "skipIfFilled", "isActive", "createdAt", "updatedAt")
SELECT t.id, '98900000-0000-4000-8000-00000000a001', t.ord, t.key, t.objective, t.target,
       t.capture::"propyte_crm"."CaptureType", t.opciones::jsonb, t.hint, true, true, true, now(), now()
  FROM (VALUES
    ('98900000-0000-4000-8000-00000000a101', 0, 'nombre',
     'Pregunta su nombre para dirigirte a él o ella de forma personal',
     'firstName', 'FULL_NAME', '[]', NULL),
    ('98900000-0000-4000-8000-00000000a102', 1, 'whatsapp',
     'Pide su número de celular con WhatsApp (10 dígitos) para que un asesor le comparta fotos, planos y disponibilidad y revise su crédito con él. Primero contesta lo que haya preguntado. Si dice que prefiere seguir por este chat, respétalo y no lo vuelvas a pedir',
     'phone', 'PHONE', '[]', 'Solo el número de celular, aunque venga con espacios o guiones.'),
    ('98900000-0000-4000-8000-00000000a103', 2, 'forma_pago',
     'Pregunta cómo piensa pagar su casa: con INFONAVIT, FOVISSSTE, crédito bancario o de contado',
     'custom.forma_pago', 'ENUM',
     '[{"value":"INFONAVIT","synonyms":["infonavit","info navit","cofinavit","apoyo infonavit"]},{"value":"FOVISSSTE","synonyms":["fovissste","fovisste","foviste","fovi"]},{"value":"BANCARIO","synonyms":["bancario","banco","credito bancario","hipotecario","hipoteca"]},{"value":"CONTADO","synonyms":["contado","efectivo","recurso propio","recursos propios"]},{"value":"NO_SABE","synonyms":["no se","no tengo credito","todavia no","aun no se"]}]',
     'Si menciona INFONAVIT junto con otro crédito (p. ej. «infonavit con mi esposa» o «cofinavit»), es INFONAVIT.'),
    ('98900000-0000-4000-8000-00000000a104', 3, 'recamaras',
     'Pregunta si busca casa de 2 o de 3 recámaras',
     'custom.recamaras', 'ENUM',
     '[{"value":"3","synonyms":["3","tres","kannah"]},{"value":"2","synonyms":["2","dos","muyal","kante","kanté","aruma"]}]',
     'Si menciona el modelo Kannah son 3; Muyal, Kanté o Aruma son 2.')
  ) AS t(id, ord, key, objective, target, capture, opciones, hint)
ON CONFLICT ("id") DO UPDATE
   SET "order" = EXCLUDED."order", "key" = EXCLUDED."key", "objective" = EXCLUDED."objective",
       "targetField" = EXCLUDED."targetField", "captureType" = EXCLUDED."captureType",
       "enumOptions" = EXCLUDED."enumOptions", "extractionHint" = EXCLUDED."extractionHint",
       "isActive" = true, "updatedAt" = now();

UPDATE "propyte_crm"."brands"
   SET "playbookId" = '98900000-0000-4000-8000-00000000a001', "updatedAt" = now()
 WHERE "slug" = 'yaxnah' AND "deletedAt" IS NULL;

-- ── Avica ──
-- Su bot está APAGADO (brands.botEnabled = false): hoy cada conversación de Avica pasa directo a
-- una persona. El guion queda listo para cuando se decida prenderlo; no cambia nada mientras tanto.
INSERT INTO "propyte_crm"."bot_playbooks" ("id", "name", "description", "isActive", "createdAt", "updatedAt")
VALUES ('98900000-0000-4000-8000-00000000b001',
        'Avica — datos para el asesor',
        'Leads de AVICA (#989): nombre, WhatsApp, desarrollo de interés (Nativa Tulum o Yaxnáh Caucel) y forma de pago. Al completarse, la conversación pasa al asesor.',
        true, now(), now())
ON CONFLICT ("id") DO UPDATE
   SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "isActive" = true,
       "deletedAt" = NULL, "updatedAt" = now();

INSERT INTO "propyte_crm"."bot_tasks"
  ("id", "playbookId", "order", "key", "objective", "targetField", "captureType", "enumOptions", "extractionHint", "required", "skipIfFilled", "isActive", "createdAt", "updatedAt")
SELECT t.id, '98900000-0000-4000-8000-00000000b001', t.ord, t.key, t.objective, t.target,
       t.capture::"propyte_crm"."CaptureType", t.opciones::jsonb, t.hint, true, true, true, now(), now()
  FROM (VALUES
    ('98900000-0000-4000-8000-00000000b101', 0, 'nombre',
     'Pregunta su nombre para dirigirte a él o ella de forma personal',
     'firstName', 'FULL_NAME', '[]', NULL),
    ('98900000-0000-4000-8000-00000000b102', 1, 'whatsapp',
     'Pide su número de celular con WhatsApp (10 dígitos) para que un asesor de AVICA le dé seguimiento. Primero contesta lo que haya preguntado. Si dice que prefiere seguir por este chat, respétalo y no lo vuelvas a pedir',
     'phone', 'PHONE', '[]', 'Solo el número de celular, aunque venga con espacios o guiones.'),
    ('98900000-0000-4000-8000-00000000b103', 2, 'desarrollo',
     'Pregunta si le interesa un departamento en Nativa Tulum o una casa en Yaxnáh Caucel (Mérida)',
     'custom.desarrollo_interes', 'ENUM',
     '[{"value":"NATIVA_TULUM","synonyms":["nativa","tulum","departamento","depa"]},{"value":"YAXNAH_CAUCEL","synonyms":["yaxnah","yaxnáh","caucel","merida","mérida","casa"]},{"value":"NORTE_MERIDA","synonyms":["norte de merida","nuevo proyecto","norte"]}]',
     NULL),
    ('98900000-0000-4000-8000-00000000b104', 3, 'forma_pago',
     'Pregunta cómo piensa pagar: con INFONAVIT, FOVISSSTE, crédito bancario, financiamiento de AVICA o de contado',
     'custom.forma_pago', 'ENUM',
     '[{"value":"INFONAVIT","synonyms":["infonavit","info navit","cofinavit","apoyo infonavit"]},{"value":"FOVISSSTE","synonyms":["fovissste","fovisste","foviste","fovi"]},{"value":"BANCARIO","synonyms":["bancario","banco","credito bancario","hipotecario","hipoteca"]},{"value":"FINANCIAMIENTO_AVICA","synonyms":["financiamiento","financiamiento directo","a plazos","mensualidades"]},{"value":"CONTADO","synonyms":["contado","efectivo","recurso propio","recursos propios"]},{"value":"NO_SABE","synonyms":["no se","no tengo credito","todavia no","aun no se"]}]',
     NULL)
  ) AS t(id, ord, key, objective, target, capture, opciones, hint)
ON CONFLICT ("id") DO UPDATE
   SET "order" = EXCLUDED."order", "key" = EXCLUDED."key", "objective" = EXCLUDED."objective",
       "targetField" = EXCLUDED."targetField", "captureType" = EXCLUDED."captureType",
       "enumOptions" = EXCLUDED."enumOptions", "extractionHint" = EXCLUDED."extractionHint",
       "isActive" = true, "updatedAt" = now();

UPDATE "propyte_crm"."brands"
   SET "playbookId" = '98900000-0000-4000-8000-00000000b001', "updatedAt" = now()
 WHERE "slug" = 'avica' AND "deletedAt" IS NULL;

COMMIT;

-- Comprobación (2 filas, 4 tareas cada una):
--   SELECT b."name", b."botEnabled", p."name" AS guion,
--          (SELECT count(*) FROM "propyte_crm"."bot_tasks" t WHERE t."playbookId" = p."id" AND t."isActive") AS tareas
--     FROM "propyte_crm"."brands" b JOIN "propyte_crm"."bot_playbooks" p ON p."id" = b."playbookId"
--    WHERE b."slug" IN ('yaxnah', 'avica');
--
-- Deshacer (las marcas vuelven a quedar sin guion; los guiones quedan guardados pero sin usarse):
--   UPDATE "propyte_crm"."brands" SET "playbookId" = NULL, "updatedAt" = now() WHERE "slug" IN ('yaxnah', 'avica');
