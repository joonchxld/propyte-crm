import { describe, it, expect, vi, beforeEach } from "vitest";
const findContactByPhone = vi.fn();
const captureLead = vi.fn();
const create = vi.fn();
vi.mock("@/lib/twilio/utils", () => ({ findContactByPhone: (...a: unknown[]) => findContactByPhone(...a) }));
vi.mock("@/lib/intake/capture-lead", () => ({ captureLead: (...a: unknown[]) => captureLead(...a) }));
vi.mock("@/lib/db", () => ({ prisma: { activity: { create: (...a: unknown[]) => create(...a) } } }));
vi.mock("@/lib/twilio/client", () => ({ validateTwilioSignature: vi.fn(async () => true) }));
import { POST } from "./route";
function formReq(fields: Record<string, string>) {
  return new Request("https://crm.propyte.com/api/webhooks/twilio/voice/incoming", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }) as unknown as import("next/server").NextRequest;
}
beforeEach(() => { [findContactByPhone, captureLead, create].forEach(m => m.mockReset()); create.mockResolvedValue({ id: "a1" }); });

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
  it("desconocido → captureLead LLAMADA_ENTRANTE y va a buzón si no hay asesor; NO crea Activity", async () => {
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
});
