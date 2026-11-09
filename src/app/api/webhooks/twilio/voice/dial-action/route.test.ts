import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/twilio/client", () => ({
  validateTwilioSignature: vi.fn(async () => true),
}));
const handleCallStatus = vi.fn(async () => {});
vi.mock("@/lib/twilio/voice", () => ({ handleCallStatus: (...a: unknown[]) => handleCallStatus(...(a as [])) }));

import { POST } from "./route";

function formReq(fields: Record<string, string>) {
  return new Request(
    "https://crm.propyte.com/api/webhooks/twilio/voice/dial-action",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }
  ) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("voice/dial-action", () => {
  it("contestada → cuelga (sin buzón)", async () => {
    const res = await POST(formReq({ DialCallStatus: "completed" }));
    const xml = await res.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<Record");
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("%s → buzón", async (st) => {
    const xml = await (await POST(formReq({ DialCallStatus: st }))).text();
    expect(xml).toContain("<Record");
    expect(xml).not.toContain("<Hangup");
  });

  it("answered → Response vacío (sin buzón)", async () => {
    const res = await POST(formReq({ DialCallStatus: "answered" }));
    const xml = await res.text();
    expect(xml).not.toContain("<Record");
  });

  it("no-answer → buzón con Record", async () => {
    const res = await POST(formReq({ DialCallStatus: "no-answer" }));
    const xml = await res.text();
    expect(xml).toContain("<Record");
  });

  it("busy → buzón con Record", async () => {
    const res = await POST(formReq({ DialCallStatus: "busy" }));
    const xml = await res.text();
    expect(xml).toContain("<Record");
  });

  it("firma inválida → 403", async () => {
    const { validateTwilioSignature } = await import("@/lib/twilio/client");
    (
      validateTwilioSignature as unknown as {
        mockResolvedValueOnce: (v: boolean) => void;
      }
    ).mockResolvedValueOnce(false);
    const res = await POST(formReq({ DialCallStatus: "no-answer" }));
    expect(res.status).toBe(403);
  });
});

describe("voice/dial-action cierra la actividad de la entrante", () => {
  it("contestada: completa con la duración del tramo del asesor", async () => {
    await POST(formReq({ CallSid: "CApadre", DialCallStatus: "completed", DialCallDuration: "42" }));
    expect(handleCallStatus).toHaveBeenCalledWith(expect.objectContaining({ CallSid: "CApadre", CallStatus: "completed", CallDuration: "42" }));
  });
  it("cancelada (el cliente colgó timbrando) cuenta como no contestada", async () => {
    await POST(formReq({ CallSid: "CApadre", DialCallStatus: "canceled" }));
    expect(handleCallStatus).toHaveBeenCalledWith(expect.objectContaining({ CallStatus: "no-answer" }));
  });
  it("si cerrar la actividad falla, igual manda al buzón", async () => {
    handleCallStatus.mockRejectedValueOnce(new Error("bd caída"));
    const xml = await (await POST(formReq({ CallSid: "CApadre", DialCallStatus: "busy" }))).text();
    expect(xml).toContain("<Record");
  });
});
