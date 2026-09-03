/**
 * The create-bot form's id validation.
 *
 * Two things are under test, and the second is the reason this file exists:
 *
 *  1. The venue cap reaches the form -- a Kraken account's id budget is applied
 *     in the field rather than discovered as a 400 after submitting.
 *
 *  2. THE FORM NO LONGER ACCEPTS IDS THE SERVER REJECTS. The old check was
 *     `/^[A-Za-z0-9._:-]+$/` with no length bound, which is looser than
 *     `BOT_INSTANCE_ID_PATTERN` in three separate ways. Each of those ways gets
 *     its own test below, because each was a real id an operator could type,
 *     watch pass validation, and then have refused by the API.
 */

import { describe, expect, it } from "vitest";
import { botInstanceIdError, maxBotInstanceIdLengthFor } from "./botId";
import { BOT_INSTANCE_ID_PATTERN, MAX_BOT_INSTANCE_ID_LENGTH } from "../../src/shared/idempotency";

/** The three shapes the old regex wrongly allowed, with what the server does. */
const LOOSER_THAN_THE_SERVER = [
  { id: "Bot-1", why: "uppercase" },
  { id: "bot.1", why: "a dot" },
  { id: "bot:1", why: "a colon" },
  { id: "a".repeat(21), why: "no length bound" },
] as const;

describe("botInstanceIdError -- the rules that are not venue-specific", () => {
  it("requires a value", () => {
    expect(botInstanceIdError("", "binance")).toBe("Required.");
    expect(botInstanceIdError("   ", "binance")).toBe("Required.");
  });

  it("accepts the ids the server accepts", () => {
    for (const id of ["bot-1toiyz", "prop-live-1", "v-spot-1", "bot_ts1", "a", "a".repeat(20)]) {
      expect(BOT_INSTANCE_ID_PATTERN.test(id), `${id} should be server-valid`).toBe(true);
      expect(botInstanceIdError(id, "binance"), `${id} should pass the form`).toBeNull();
    }
  });

  it("trims before judging, as the form submits trimmed", () => {
    expect(botInstanceIdError("  bot-1toiyz  ", "binance")).toBeNull();
  });

  describe("rejects what the old, looser regex let through", () => {
    for (const { id, why } of LOOSER_THAN_THE_SERVER) {
      it(`rejects ${JSON.stringify(id)} (${why})`, () => {
        // The premise: the server really does refuse this id.
        expect(BOT_INSTANCE_ID_PATTERN.test(id)).toBe(false);
        // The old check really did accept it.
        expect(/^[A-Za-z0-9._:-]+$/.test(id)).toBe(true);
        // And the form now refuses it too, before submitting.
        expect(botInstanceIdError(id, "binance")).not.toBeNull();
      });
    }
  });

  it("says how long is too long, rather than blaming the characters", () => {
    const error = botInstanceIdError("a".repeat(25), "binance");
    expect(error).toContain(String(MAX_BOT_INSTANCE_ID_LENGTH));
    expect(error).toContain("25");
  });

  it("still validates shape when no account is selected yet", () => {
    // An empty exchange means the venue rule is not knowable. The rules that do
    // not depend on it must still apply.
    expect(botInstanceIdError("Bot-1", "")).not.toBeNull();
    expect(botInstanceIdError("bot-1toiyz", "")).toBeNull();
  });
});

describe("botInstanceIdError -- the venue cap", () => {
  it("applies kraken's 10-character budget in the field", () => {
    // `grid-btcusd-01` is entry 90's worked example: server-valid, and 19
    // characters once it becomes `v1-grid-btcusd-01-7`.
    expect(BOT_INSTANCE_ID_PATTERN.test("grid-btcusd-01")).toBe(true);

    const error = botInstanceIdError("grid-btcusd-01", "kraken");
    expect(error).not.toBeNull();
    expect(error).toContain("kraken");
    expect(error).toContain("18"); // the venue's order-id cap
    expect(error).toContain("10"); // what to type to
  });

  it("accepts an id at exactly kraken's budget", () => {
    expect(botInstanceIdError("bot-1toiyz", "kraken")).toBeNull();
    expect(botInstanceIdError("a".repeat(10), "kraken")).toBeNull();
    expect(botInstanceIdError("a".repeat(11), "kraken")).not.toBeNull();
  });

  it("leaves binance and gemini exactly as they were", () => {
    for (const exchange of ["binance", "gemini"]) {
      // The id kraken refuses is fine on both.
      expect(botInstanceIdError("grid-btcusd-01", exchange)).toBeNull();
      expect(botInstanceIdError("prop-live-1", exchange)).toBeNull();
      // And their limit is still the scheme-wide one.
      expect(maxBotInstanceIdLengthFor(exchange)).toBe(MAX_BOT_INSTANCE_ID_LENGTH);
      expect(botInstanceIdError("a".repeat(MAX_BOT_INSTANCE_ID_LENGTH), exchange)).toBeNull();
    }
  });

  it("falls back to the scheme-wide maximum for an unknown or absent venue", () => {
    expect(maxBotInstanceIdLengthFor("")).toBe(MAX_BOT_INSTANCE_ID_LENGTH);
    expect(maxBotInstanceIdLengthFor("coinbase")).toBe(MAX_BOT_INSTANCE_ID_LENGTH);
    expect(maxBotInstanceIdLengthFor("kraken")).toBe(10);
  });
});

/**
 * The id the form prefills must fit the tightest venue this system knows, or
 * every fresh Kraken form would open holding an invalid value. It does, and this
 * pins the property rather than the implementation: 10 characters of `[a-z0-9-]`.
 */
describe("the prefilled bot id", () => {
  function generatedId(): string {
    // Mirrors `generatedId()` in CreateBot.tsx.
    return `bot-${Math.random().toString(36).slice(2, 8)}`;
  }

  it("is valid on every venue, over many draws", () => {
    for (let i = 0; i < 500; i += 1) {
      const id = generatedId();
      expect(id.length, id).toBeLessThanOrEqual(maxBotInstanceIdLengthFor("kraken"));
      for (const exchange of ["binance", "gemini", "kraken", ""]) {
        expect(botInstanceIdError(id, exchange), `${id} on ${exchange || "(no account)"}`).toBeNull();
      }
    }
  });
});
