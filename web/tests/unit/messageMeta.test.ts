// Unit tests for messageMeta (pure functions; node env, no jsdom needed).
//
// roleLabel/agentLabel/messageError/costLabel are dependency-free. modelLabel
// resolves the display name through the shared models store's findModel, which
// has no test-seed export — so we mock the models module with a findModel over
// a mutable seed. The fallback branch (findModel -> undefined) is the empty-seed
// case; the resolved-name branch pushes a model into the seed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { modelsSeed } = vi.hoisted(() => ({
  modelsSeed: [] as Array<{ providerID: string; modelID: string; name: string }>,
}));

vi.mock("../../src/models", () => ({
  findModel: (providerID: string, modelID: string) =>
    modelsSeed.find((m) => m.providerID === providerID && m.modelID === modelID),
}));

import { agentLabel, costLabel, messageError, modelLabel, roleLabel } from "../../src/components/chat/messageMeta";

beforeEach(() => {
  modelsSeed.length = 0;
});

describe("roleLabel", () => {
  it.each([
    ["user", "You"],
    ["assistant", "Assistant"],
    ["system", "system"],
    ["tool", "tool"],
  ])("maps %q -> %q", (role, expected) => {
    expect(roleLabel(role)).toBe(expected);
  });

  it("returns '' for undefined role", () => {
    expect(roleLabel(undefined)).toBe("");
  });

  it("returns '' for empty role", () => {
    expect(roleLabel("")).toBe("");
  });
});

describe("agentLabel", () => {
  it("returns '' for a non-assistant message even when agent is set", () => {
    expect(agentLabel({ role: "user", agent: "build" })).toBe("");
  });

  it("reads info.agent for an assistant message", () => {
    expect(agentLabel({ role: "assistant", agent: "build" })).toBe("build");
  });

  it("falls back to info.mode when info.agent is absent", () => {
    expect(agentLabel({ role: "assistant", mode: "plan" })).toBe("plan");
  });

  it("prefers info.agent over info.mode when both are set", () => {
    expect(agentLabel({ role: "assistant", agent: "build", mode: "plan" })).toBe("build");
  });

  it("trims whitespace around the agent name", () => {
    expect(agentLabel({ role: "assistant", agent: "  build  " })).toBe("build");
  });

  it("returns '' when neither agent nor mode is present", () => {
    expect(agentLabel({ role: "assistant" })).toBe("");
  });

  it("returns '' when agent is a non-string value", () => {
    expect(agentLabel({ role: "assistant", agent: 42 })).toBe("");
  });

  it("returns '' for null/undefined info", () => {
    expect(agentLabel(null)).toBe("");
    expect(agentLabel(undefined)).toBe("");
  });
});

describe("messageError", () => {
  it("returns null when there is no error", () => {
    expect(messageError({})).toBeNull();
  });

  it("returns null for undefined info", () => {
    expect(messageError(undefined)).toBeNull();
  });

  it("prefers error.data.message", () => {
    expect(messageError({ error: { data: { message: "boom" }, name: "Wrapped" } })).toBe("boom");
  });

  it("falls back to error.name when data.message is absent", () => {
    expect(messageError({ error: { name: "TimeoutError" } })).toBe("TimeoutError");
  });

  it("falls back to the literal 'error' when neither message nor name is set", () => {
    expect(messageError({ error: {} })).toBe("error");
  });

  it("treats an empty data.message as absent and falls through to name", () => {
    // "" is falsy under || chaining.
    expect(messageError({ error: { data: { message: "" }, name: "Named" } })).toBe("Named");
  });
});

describe("modelLabel", () => {
  it("returns '' for a non-assistant message", () => {
    expect(modelLabel({ role: "user", providerID: "p", modelID: "m1" })).toBe("");
  });

  it("returns '' when the assistant message carries no modelID", () => {
    expect(modelLabel({ role: "assistant" })).toBe("");
  });

  it("falls back to the raw modelID when findModel has no catalog entry", () => {
    // modelsSeed is empty here, so findModel returns undefined.
    expect(modelLabel({ role: "assistant", providerID: "p", modelID: "m1" })).toBe("m1");
  });

  it("reads modelID/model from the nested envelope shape too", () => {
    expect(modelLabel({ role: "assistant", model: { modelID: "m1" } })).toBe("m1");
  });

  it("resolves to the catalog display name when findModel matches", () => {
    modelsSeed.push({ providerID: "p", modelID: "m1", name: "Display Name" });
    expect(modelLabel({ role: "assistant", providerID: "p", modelID: "m1" })).toBe("Display Name");
  });

  it("appends a non-default variant as 'name · variant'", () => {
    expect(modelLabel({ role: "assistant", modelID: "m1", variant: "high" })).toBe("m1 · high");
  });

  it("reads the variant from the nested envelope shape too", () => {
    expect(modelLabel({ role: "assistant", model: { modelID: "m1", variant: "high" } })).toBe("m1 · high");
  });

  it("does NOT append the variant when it is 'default'", () => {
    expect(modelLabel({ role: "assistant", modelID: "m1", variant: "default" })).toBe("m1");
  });

  it("appends the variant to a resolved display name too", () => {
    modelsSeed.push({ providerID: "p", modelID: "m1", name: "Display Name" });
    expect(modelLabel({ role: "assistant", providerID: "p", modelID: "m1", variant: "high" })).toBe(
      "Display Name · high",
    );
  });
});

describe("costLabel", () => {
  const completed = { role: "assistant", time: { completed: 1 } } as const;

  it("returns '' for a non-assistant message", () => {
    expect(costLabel({ role: "user", cost: 1, tokens: { input: 1, output: 1 } })).toBe("");
  });

  it("returns '' when the assistant turn is not yet completed", () => {
    expect(costLabel({ role: "assistant", cost: 1, tokens: { input: 1, output: 1 } })).toBe("");
  });

  it("returns '' when there is no cost and no tokens", () => {
    expect(costLabel(completed)).toBe("");
  });

  it("suppresses a zero cost", () => {
    expect(costLabel({ ...completed, cost: 0 })).toBe("");
  });

  it("formats a cost as $X.XXXX", () => {
    expect(costLabel({ ...completed, cost: 0.5 })).toBe("$0.5000");
  });

  it("formats sub-1000 token totals as 'N tok'", () => {
    expect(costLabel({ ...completed, tokens: { input: 300, output: 200 } })).toBe("500 tok");
  });

  it("formats >=1000 token totals as 'N.Nk tok'", () => {
    expect(costLabel({ ...completed, tokens: { input: 800, output: 400 } })).toBe("1.2k tok");
  });

  it("joins cost and tokens with ' · '", () => {
    expect(costLabel({ ...completed, cost: 0.1, tokens: { input: 500, output: 500 } })).toBe(
      "$0.1000 · 1.0k tok",
    );
  });
});
