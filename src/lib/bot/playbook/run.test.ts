import { describe, it, expect, vi, beforeEach } from "vitest";

const extractFields = vi.fn();
const coerceCapture = vi.fn();
const applyCapture = vi.fn();
const detectDuplicatesForContact = vi.fn();
const nextTask = vi.fn();
const buildObjective = vi.fn();
const buildRepreguntaObjective = vi.fn();

vi.mock("./extract", () => ({ extractFields: (...a: unknown[]) => extractFields(...a) }));
vi.mock("./capture", () => ({ coerceCapture: (...a: unknown[]) => coerceCapture(...a) }));
vi.mock("./apply", () => ({ applyCapture: (...a: unknown[]) => applyCapture(...a) }));
vi.mock("@/lib/contacts/duplicate-alert", () => ({ detectDuplicatesForContact: (...a: unknown[]) => detectDuplicatesForContact(...a) }));
vi.mock("./engine", () => ({
  nextTask: (...a: unknown[]) => nextTask(...a),
  buildObjective: (...a: unknown[]) => buildObjective(...a),
  buildRepreguntaObjective: (...a: unknown[]) => buildRepreguntaObjective(...a),
  COMPLETION_OBJECTIVE: "listo",
}));

import { runPlaybookStep } from "./run";

function makeDb(completedTaskKeys: string[] = []) {
  return {
    conversationPlaybookState: {
      upsert: vi.fn(async () => ({ id: "state1", completedTaskKeys })),
      update: vi.fn(async () => ({})),
    },
    contact: {
      findUnique: vi.fn(async () => ({ id: "contact1", firstName: "A" })),
    },
  };
}

const phoneTask = {
  key: "capture_phone", order: 1, objective: "pide el teléfono", targetField: "phone",
  captureType: "PHONE", enumOptions: null, required: true, skipIfFilled: true,
};
const emailTask = {
  key: "capture_email", order: 2, objective: "pide el email", targetField: "email",
  captureType: "EMAIL", enumOptions: null, required: true, skipIfFilled: true,
};
const textTask = {
  key: "capture_zone", order: 3, objective: "pide la zona", targetField: "preferredZone",
  captureType: "ZONE", enumOptions: null, required: false, skipIfFilled: true,
};

beforeEach(() => {
  [extractFields, coerceCapture, applyCapture, detectDuplicatesForContact, nextTask, buildObjective, buildRepreguntaObjective].forEach((m) => m.mockReset());
  applyCapture.mockResolvedValue(undefined);
  detectDuplicatesForContact.mockResolvedValue(undefined);
  nextTask.mockReturnValue(null);
  buildObjective.mockReturnValue("siguiente objetivo");
  buildRepreguntaObjective.mockReturnValue("repregunta");
});

describe("runPlaybookStep — hook de detección de duplicados (Caso 1)", () => {
  it("captura exitosa de PHONE → llama detectDuplicatesForContact con el contactId", async () => {
    const db = makeDb();
    extractFields.mockResolvedValue({ capture_phone: "9991112233" });
    coerceCapture.mockReturnValue({ ok: true, writes: [{ field: "phone", value: "+529991112233" }] });
    await runPlaybookStep(db as never, {
      playbook: { id: "pb1", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });
    expect(applyCapture).toHaveBeenCalled();
    expect(detectDuplicatesForContact).toHaveBeenCalledWith("contact1");
  });

  it("captura exitosa de EMAIL → también dispara la detección", async () => {
    const db = makeDb();
    extractFields.mockResolvedValue({ capture_email: "ana@x.com" });
    coerceCapture.mockReturnValue({ ok: true, writes: [{ field: "email", value: "ana@x.com" }] });
    await runPlaybookStep(db as never, {
      playbook: { id: "pb1", tasks: [emailTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });
    expect(detectDuplicatesForContact).toHaveBeenCalledWith("contact1");
  });

  it("captura exitosa de un captureType distinto (ZONE) → NO dispara la detección", async () => {
    const db = makeDb();
    extractFields.mockResolvedValue({ capture_zone: "Tulum" });
    coerceCapture.mockReturnValue({ ok: true, writes: [{ field: "preferredZone", value: "Tulum" }] });
    await runPlaybookStep(db as never, {
      playbook: { id: "pb1", tasks: [textTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });
    expect(applyCapture).toHaveBeenCalled();
    expect(detectDuplicatesForContact).not.toHaveBeenCalled();
  });

  it("coerción fallida (ok:false) → no aplica ni detecta duplicados", async () => {
    const db = makeDb();
    extractFields.mockResolvedValue({ capture_phone: "no es un teléfono" });
    coerceCapture.mockReturnValue({ ok: false, writes: [] });
    await runPlaybookStep(db as never, {
      playbook: { id: "pb1", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });
    expect(applyCapture).not.toHaveBeenCalled();
    expect(detectDuplicatesForContact).not.toHaveBeenCalled();
  });

  it("si detectDuplicatesForContact lanza, el step NO se rompe (best-effort)", async () => {
    const db = makeDb();
    extractFields.mockResolvedValue({ capture_phone: "9991112233" });
    coerceCapture.mockReturnValue({ ok: true, writes: [{ field: "phone", value: "+529991112233" }] });
    detectDuplicatesForContact.mockRejectedValue(new Error("boom"));
    nextTask.mockReturnValue({ key: "capture_email", order: 2, objective: "x", targetField: "email" });
    const result = await runPlaybookStep(db as never, {
      playbook: { id: "pb1", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });
    expect(result.status).toBe("IN_PROGRESS");
    expect(result.objective).toBe("siguiente objetivo");
  });
});

// Marcas del agente (2026-10-09, revisión final): el hilo tiene UN solo ConversationPlaybookState.
// Si es de otro playbook (p. ej. el global corrió antes de asignarle una marca a la cuenta), sus
// tareas cumplidas no son avance del playbook de la marca. Con `ignoreForeignState` se reinicia
// para este playbook; sin la bandera (camino sin marca) todo queda exactamente igual.
describe("runPlaybookStep — extractionHint llega al extractor", () => {
  it("una tarea con pista la manda en ExtractTaskLite; sin pista va null", async () => {
    const hintTask = { ...textTask, key: "colchon", extractionHint: "Convierte meses a rango." };
    extractFields.mockResolvedValue({});
    await runPlaybookStep(makeDb() as any, {
      playbook: { id: "pb1", tasks: [hintTask, phoneTask] },
      conversationId: "conv1", contact: { id: "contact1" }, messages: [], model: "m",
    });
    expect(extractFields).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ key: "colchon", extractionHint: "Convierte meses a rango." }),
          expect.objectContaining({ key: "capture_phone", extractionHint: null }),
        ],
      }),
    );
  });
});

describe("runPlaybookStep — estado de otro playbook (ignoreForeignState)", () => {
  function dbWithState(state: { playbookId: string; completedTaskKeys: string[] }) {
    const db = makeDb(state.completedTaskKeys);
    db.conversationPlaybookState.upsert = vi.fn(async () => ({ id: "state1", ...state }));
    return db;
  }

  it("con la bandera y estado de OTRO playbook → se reinicia para este y sus tareas no cuentan", async () => {
    const db = dbWithState({ playbookId: "pb-global", completedTaskKeys: ["capture_phone"] });
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(phoneTask);

    const result = await runPlaybookStep(db as never, {
      playbook: { id: "pb-yax", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
      ignoreForeignState: true,
    });

    expect(db.conversationPlaybookState.update).toHaveBeenCalledWith({
      where: { conversationId: "conv1" },
      data: expect.objectContaining({
        playbookId: "pb-yax",
        status: "IN_PROGRESS",
        currentTaskKey: null,
        completedTaskKeys: [],
        completedAt: null,
      }),
    });
    // la tarea "capture_phone" del otro playbook NO cuenta: sigue pendiente y se extrae
    expect(extractFields).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: [expect.objectContaining({ key: "capture_phone" })] }),
    );
    expect(nextTask).toHaveBeenCalledWith(expect.anything(), [], expect.anything());
    expect(result.objective).toBe("siguiente objetivo");
  });

  it("con la bandera y estado del MISMO playbook → se conserva el avance (no se reinicia)", async () => {
    const db = dbWithState({ playbookId: "pb-yax", completedTaskKeys: ["capture_phone"] });

    await runPlaybookStep(db as never, {
      playbook: { id: "pb-yax", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
      ignoreForeignState: true,
    });

    const resets = db.conversationPlaybookState.update.mock.calls.filter(
      (c: unknown[]) => (c[0] as { data: { playbookId?: string } }).data.playbookId !== undefined,
    );
    expect(resets).toHaveLength(0);
    expect(nextTask).toHaveBeenCalledWith(expect.anything(), ["capture_phone"], expect.anything());
  });

  it("SIN la bandera, el estado de otro playbook se usa tal cual (comportamiento de siempre)", async () => {
    const db = dbWithState({ playbookId: "pb-global", completedTaskKeys: ["capture_phone"] });

    await runPlaybookStep(db as never, {
      playbook: { id: "pb-yax", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [],
      model: "m",
    });

    const resets = db.conversationPlaybookState.update.mock.calls.filter(
      (c: unknown[]) => (c[0] as { data: { playbookId?: string } }).data.playbookId !== undefined,
    );
    expect(resets).toHaveLength(0);
    expect(nextTask).toHaveBeenCalledWith(expect.anything(), ["capture_phone"], expect.anything());
  });
});

describe("runPlaybookStep — respuesta que no se pudo registrar (prueba reclutamiento 2026-11-04)", () => {
  function dbEn(currentTaskKey: string | null) {
    const db = makeDb([]);
    db.conversationPlaybookState.upsert = vi.fn(async () => ({ id: "state1", completedTaskKeys: [], currentTaskKey }));
    return db;
  }
  const args = (db: unknown, messages: { role: "user" | "assistant"; content: string }[]) =>
    runPlaybookStep(db as never, {
      playbook: { id: "pb", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages,
      model: "m",
    });

  it("el cliente contestó y la misma tarea sigue pendiente → objetivo de repregunta", async () => {
    extractFields.mockResolvedValue({ capture_phone: null });
    nextTask.mockReturnValue(phoneTask);
    const r = await args(dbEn("capture_phone"), [
      { role: "assistant", content: "¿Me pasas tu teléfono?" },
      { role: "user", content: "Sip" },
    ]);
    expect(r.objective).toBe("repregunta");
    expect(buildRepreguntaObjective).toHaveBeenCalledWith(phoneTask);
  });

  it("la tarea pendiente es nueva (antes perseguía otra) → objetivo normal", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(phoneTask);
    const r = await args(dbEn("capture_email"), [{ role: "user", content: "hola" }]);
    expect(r.objective).toBe("siguiente objetivo");
    expect(buildRepreguntaObjective).not.toHaveBeenCalled();
  });

  it("primer turno (sin tarea previa) → objetivo normal", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(phoneTask);
    const r = await args(dbEn(null), [{ role: "user", content: "hola" }]);
    expect(r.objective).toBe("siguiente objetivo");
  });

  it("el último mensaje es del bot (no contestó el cliente) → objetivo normal", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(phoneTask);
    const r = await args(dbEn("capture_phone"), [{ role: "assistant", content: "¿Me pasas tu teléfono?" }]);
    expect(r.objective).toBe("siguiente objetivo");
  });
});

// #989: botRespond pasa el hilo al asesor cuando el guion de una marca se completa. Tiene que
// saber si se completó EN ESTE turno, para no pasarlo otra vez en cada mensaje posterior.
describe("runPlaybookStep — recienCompletado (#989)", () => {
  function dbConEstado(status: string) {
    const db = makeDb([]);
    db.conversationPlaybookState.upsert = vi.fn(async () => ({ id: "s", playbookId: "pb", status, completedTaskKeys: [] }));
    return db;
  }
  const correr = (db: ReturnType<typeof makeDb>) =>
    runPlaybookStep(db as never, {
      playbook: { id: "pb", tasks: [phoneTask] },
      conversationId: "conv1",
      contact: { id: "contact1" },
      messages: [{ role: "user", content: "9982144097" }],
      model: "m",
    });

  it("estaba en curso y ya no queda tarea → COMPLETED con recienCompletado", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(null);
    const r = await correr(dbConEstado("IN_PROGRESS"));
    expect(r).toMatchObject({ status: "COMPLETED", recienCompletado: true });
  });

  it("ya estaba COMPLETED → sin recienCompletado", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(null);
    const r = await correr(dbConEstado("COMPLETED"));
    expect(r.status).toBe("COMPLETED");
    expect(r).not.toHaveProperty("recienCompletado");
  });

  it("queda tarea pendiente → sin recienCompletado", async () => {
    extractFields.mockResolvedValue({});
    nextTask.mockReturnValue(phoneTask);
    const r = await correr(dbConEstado("IN_PROGRESS"));
    expect(r.status).toBe("IN_PROGRESS");
    expect(r).not.toHaveProperty("recienCompletado");
  });
});
