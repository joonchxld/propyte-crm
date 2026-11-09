import { describe, it, expect, vi, beforeEach } from "vitest";
const findContactByPhone = vi.fn();
const captureLead = vi.fn();
const create = vi.fn();
const destinatarios = vi.fn();
const contactFind = vi.fn();
const convFind = vi.fn();
vi.mock("@/lib/messaging/aviso-sin-dueno", () => ({ destinatariosHiloSinDueno: (...a: unknown[]) => destinatarios(...a) }));
vi.mock("@/lib/twilio/utils", () => ({ findContactByPhone: (...a: unknown[]) => findContactByPhone(...a) }));
vi.mock("@/lib/intake/capture-lead", () => ({ captureLead: (...a: unknown[]) => captureLead(...a) }));
vi.mock("@/lib/db", () => ({ prisma: { activity: { create: (...a: unknown[]) => create(...a) }, contact: { findUnique: (...a: unknown[]) => contactFind(...a) }, conversation: { findFirst: (...a: unknown[]) => convFind(...a) } } }));
vi.mock("@/lib/twilio/client", () => ({ validateTwilioSignature: vi.fn(async () => true) }));
import { POST } from "./route";
function formReq(fields: Record<string, string>) {
  return new Request("https://crm.propyte.com/api/webhooks/twilio/voice/incoming", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }) as unknown as import("next/server").NextRequest;
}
beforeEach(() => { [findContactByPhone, captureLead, create, destinatarios, contactFind, convFind].forEach(m => m.mockReset()); create.mockResolvedValue({ id: "a1" });
  contactFind.mockResolvedValue({ targetPlaza: "MERIDA" }); convFind.mockResolvedValue({ connectorId: "k1" });
  destinatarios.mockResolvedValue({ userIds: [], via: null, detalle: null }); });

describe("voice/incoming", () => {
  it("contacto conocido con asesor → Dial al Client del asesor + crea Activity CALL_INBOUND; sin buzón en este TwiML", async () => {
    findContactByPhone.mockResolvedValue({ id: "c1", assignedToId: "u1", firstName: "Ana", lastName: "Pérez & Co" });
    const res = await POST(formReq({ CallSid: "CA9", From: "+529991112233", To: "+52..." }));
    const xml = await res.text();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityType: "CALL_INBOUND",
          callSid: "CA9",
          contactId: "c1",
          userId: "u1",
        }),
      })
    );
    expect(xml).toContain("<Client>u1<Parameter");
    expect(xml).toContain('<Parameter name="contactId" value="c1" />');
    expect(xml).toContain('<Parameter name="nombre" value="Ana Pérez &amp; Co" />');
    expect(xml).toContain('<Parameter name="esNuevo" value="0" />');
    expect(xml).toContain('timeout="20"');
    expect(xml).toMatch(/action="[^"]*\/voice\/dial-action"/);
    expect(xml).not.toContain("<Record");
  });
  it("desconocido → captureLead LLAMADA_ENTRANTE y va a buzón si no hay asesor ni responsable; NO crea Activity", async () => {
    findContactByPhone.mockResolvedValue(null);
    captureLead.mockResolvedValue({ contactId: "c2", assignedToId: null });
    const res = await POST(formReq({ CallSid: "CA10", From: "+521000000000", To: "+52..." }));
    const xml = await res.text();
    expect(captureLead).toHaveBeenCalledWith(expect.objectContaining({ source: "LLAMADA_ENTRANTE", phone: "+521000000000" }));
    expect(xml).toContain("<Record");
    expect(create).not.toHaveBeenCalled();
  });
  it("#892: si el alta del número desconocido falla, queda en el log y la llamada va a buzón", async () => {
    findContactByPhone.mockResolvedValue(null);
    captureLead.mockResolvedValue({ contactId: null, isNew: false, assignedToId: null, error: "source inválido" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(formReq({ CallSid: "CA11", From: "+521000000001", To: "+52..." }));
    const xml = await res.text();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("[voice/incoming] no se pudo dar de alta"),
      "source inválido",
    );
    expect(xml).toContain("<Record");
    expect(create).not.toHaveBeenCalled();
    err.mockRestore();
  });
  it("firma inválida → 403", async () => {
    const { validateTwilioSignature } = await import("@/lib/twilio/client");
    (validateTwilioSignature as unknown as { mockResolvedValueOnce: (v: boolean) => void }).mockResolvedValueOnce(false);
    const res = await POST(formReq({ CallSid: "CA9", From: "+52", To: "+52" }));
    expect(res.status).toBe(403);
  });
  it("número nuevo con asesor → esNuevo=1 y nombre vacío", async () => {
    findContactByPhone.mockResolvedValue(null);
    captureLead.mockResolvedValue({ contactId: "c3", isNew: true, assignedToId: "u2" });
    const res = await POST(formReq({ CallSid: "CA12", From: "+521000000002", To: "+52..." }));
    const xml = await res.text();
    expect(xml).toContain("<Client>u2<Parameter");
    expect(xml).toContain('<Parameter name="nombre" value="" />');
    expect(xml).toContain('<Parameter name="esNuevo" value="1" />');
  });
  it("sin asesor → suena a varios Client (máx. 5) con sinAsesor=1 y registra Activity al primero", async () => {
    findContactByPhone.mockResolvedValue({ id: "c4", assignedToId: null, firstName: "Luis", lastName: "" });
    destinatarios.mockResolvedValue({ userIds: ["g1", "g2", "g3", "g4", "g5", "g6", "g7"], via: "gerencia_plaza", detalle: "MERIDA" });
    const xml = await (await POST(formReq({ CallSid: "CA20", From: "+521000000020", To: "+52..." }))).text();
    expect(destinatarios).toHaveBeenCalledWith({ connectorId: "k1", plaza: "MERIDA" });
    expect(xml.match(/<Client>/g)).toHaveLength(5);
    expect(xml).toContain("<Client>g1<Parameter");
    expect(xml).not.toContain("<Client>g6");
    expect(xml).toContain('<Parameter name="sinAsesor" value="1" />');
    expect(xml).toContain('timeout="20"');
    expect(xml).not.toContain("<Record");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "g1", callSid: "CA20", contactId: "c4", activityType: "CALL_INBOUND", status: "PENDIENTE" }) })
    );
  });
  it("con asesor → un solo Client, sin sinAsesor y sin consultar la cadena", async () => {
    findContactByPhone.mockResolvedValue({ id: "c1", assignedToId: "u1", firstName: "Ana", lastName: "" });
    const xml = await (await POST(formReq({ CallSid: "CA21", From: "+521000000021", To: "+52..." }))).text();
    expect(xml.match(/<Client>/g)).toHaveLength(1);
    expect(xml).not.toContain("sinAsesor");
    expect(destinatarios).not.toHaveBeenCalled();
  });
  it("sin asesor y sin destinatarios → buzón, sin Activity", async () => {
    findContactByPhone.mockResolvedValue({ id: "c5", assignedToId: null, firstName: "X", lastName: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = await (await POST(formReq({ CallSid: "CA22", From: "+521000000022", To: "+52..." }))).text();
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Client>");
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("si la cadena falla → buzón (no tumba la llamada)", async () => {
    findContactByPhone.mockResolvedValue({ id: "c6", assignedToId: null, firstName: "X", lastName: "" });
    destinatarios.mockRejectedValue(new Error("db"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = await (await POST(formReq({ CallSid: "CA23", From: "+521000000023", To: "+52..." }))).text();
    expect(xml).toContain("<Record");
    err.mockRestore(); warn.mockRestore();
  });
});
