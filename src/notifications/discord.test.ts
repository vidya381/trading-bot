/**
 * `DiscordNotifier` (sections 2, 10).
 *
 * `fetch` is injected, so nothing here touches the network, and the webhook URL
 * is a mock -- never a real one, per the session's constraint.
 */

import { describe, expect, it } from "vitest";
import { DiscordNotifier, type FetchLike } from "./discord";
import type { NotifiableAlert } from "./notifier";

const MOCK_URL = "https://discord.example/api/webhooks/mock/token";

function alert(overrides: Partial<NotifiableAlert> = {}): NotifiableAlert {
  return {
    id: "alert-1",
    severity: "critical",
    category: "trading",
    alertType: "halt_stop_loss",
    botInstanceId: "dca-btc-1",
    source: "bot-instance",
    message: "stop_loss: price broke below the floor",
    createdAt: 1_760_000_000_000,
    ...overrides,
  };
}

/** A fetch that records its call and returns a canned response. */
function recordingFetch(response: Response): { fetch: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetch, calls };
}

describe("DiscordNotifier construction", () => {
  it("refuses an empty webhook URL", () => {
    expect(() => new DiscordNotifier("")).toThrow(/non-empty webhook URL/);
    expect(() => new DiscordNotifier("   ")).toThrow(/non-empty webhook URL/);
  });
});

describe("DiscordNotifier payload", () => {
  it("POSTs a JSON webhook body to the given URL", async () => {
    const { fetch, calls } = recordingFetch(new Response(null, { status: 204 }));
    await new DiscordNotifier(MOCK_URL, { fetch }).send(alert());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MOCK_URL);
    expect(calls[0]!.init!.method).toBe("POST");
    expect(new Headers(calls[0]!.init!.headers).get("content-type")).toBe("application/json");
  });

  it("carries the message, an ISO timestamp, and structural fields", async () => {
    const { fetch, calls } = recordingFetch(new Response(null, { status: 204 }));
    await new DiscordNotifier(MOCK_URL, { fetch }).send(alert());

    const body = JSON.parse(calls[0]!.init!.body as string);
    const embed = body.embeds[0];
    expect(embed.description).toBe("stop_loss: price broke below the floor");
    expect(embed.timestamp).toBe(new Date(1_760_000_000_000).toISOString());

    // Structurally distinguishable (section 10): category and severity are
    // their own fields, not buried in prose.
    const fields = Object.fromEntries(embed.fields.map((f: { name: string; value: string }) => [f.name, f.value]));
    expect(fields.Category).toBe("trading");
    expect(fields.Severity).toBe("critical");
    expect(fields.Bot).toBe("dca-btc-1");
    expect(embed.footer.text).toBe("alert alert-1");
  });

  it("labels account-wide alerts in the Bot field", async () => {
    const { fetch, calls } = recordingFetch(new Response(null, { status: 204 }));
    await new DiscordNotifier(MOCK_URL, { fetch }).send(
      alert({ botInstanceId: null, alertType: "circuit_breaker_tripped" }),
    );
    const embed = JSON.parse(calls[0]!.init!.body as string).embeds[0];
    const fields = Object.fromEntries(embed.fields.map((f: { name: string; value: string }) => [f.name, f.value]));
    expect(fields.Bot).toBe("account-wide");
  });

  it("makes the two section-10 categories visually distinguishable", async () => {
    const { fetch, calls } = recordingFetch(new Response(null, { status: 204 }));
    const notifier = new DiscordNotifier(MOCK_URL, { fetch });

    await notifier.send(alert({ category: "trading", severity: "critical" }));
    await notifier.send(alert({ category: "system", severity: "critical" }));

    const trading = JSON.parse(calls[0]!.init!.body as string).embeds[0];
    const system = JSON.parse(calls[1]!.init!.body as string).embeds[0];

    // Same severity, different category -> different colour and different label.
    expect(trading.color).not.toBe(system.color);
    expect(trading.title).toContain("[TRADING]");
    expect(system.title).toContain("[SYSTEM]");
  });
});

describe("DiscordNotifier delivery result", () => {
  it("reports delivered on a 204", async () => {
    const { fetch } = recordingFetch(new Response(null, { status: 204 }));
    expect(await new DiscordNotifier(MOCK_URL, { fetch }).send(alert())).toEqual({
      delivered: true,
    });
  });

  it("reports not-delivered with the status on a 5xx", async () => {
    const { fetch } = recordingFetch(new Response("boom", { status: 503 }));
    const result = await new DiscordNotifier(MOCK_URL, { fetch }).send(alert());
    expect(result.delivered).toBe(false);
    expect(result).toMatchObject({ delivered: false });
    if (!result.delivered) expect(result.reason).toContain("503");
  });

  it("surfaces retry-after on a 429", async () => {
    const { fetch } = recordingFetch(
      new Response("rate limited", { status: 429, headers: { "retry-after": "42" } }),
    );
    const result = await new DiscordNotifier(MOCK_URL, { fetch }).send(alert());
    expect(result.delivered).toBe(false);
    if (!result.delivered) {
      expect(result.reason).toContain("429");
      expect(result.reason).toContain("42");
    }
  });

  it("maps a network throw to a not-delivered result rather than rejecting", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("connection reset");
    };
    const result = await new DiscordNotifier(MOCK_URL, { fetch }).send(alert());
    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(result.reason).toContain("connection reset");
  });
});
