import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/twilio/client", () => ({
  validateTwilioSignature: vi.fn(async () => true),
}));

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
