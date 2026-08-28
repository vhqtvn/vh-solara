// @vitest-environment jsdom
//
// Composer agent-select display states — the display half of the silent-flip
// fix (window (d) of the incident task contract). The Select's value and
// placeholder come from the SAME resolver the send gate uses
// (resolveAgentForSession), so what the composer SHOWS is what a send would
// send. These tests pin the three resolver outcomes as rendered:
//   pending     → placeholder "Resolving agent…" (NOT a fabricated default)
//   unavailable → placeholder "@<agent> unavailable — pick one" (no silent
//                 list[0]/config substitution)
//   agent       → the "@<name>" label of the evidence-backed agent
// Only ../../src/agents is mocked (controllable signals); the rest of the
// Composer graph runs real, as in Composer.zoom.test.tsx.
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import "./_matchMedia";

const AGENTS = [{ name: "supervisor" }, { name: "coordination" }];
const [list, setList] = createSignal(AGENTS);
const [resolution, setResolution] = createSignal<
  { state: "agent"; agent: string } | { state: "pending" } | { state: "unavailable"; agent: string }
>({ state: "agent", agent: "supervisor" });

vi.mock("../../src/agents", () => ({
  agents: () => list(),
  selectedAgent: () => "coordination",
  resolveAgentForSession: (_sid: string) => resolution(),
  selectAgentForSession: vi.fn(),
  loadAgents: async () => {},
  setSelectedAgent: vi.fn(),
}));

import { Composer, type ComposerProps } from "../../src/components/chat/Composer";
import type { Attachment } from "../../src/components/chat/createAttachments";

// Same minimal-props pattern as Composer.zoom.test.tsx — only what the
// agent Select path reads.
function makeProps(sessionId: () => string): ComposerProps {
  const [, setInput] = createSignal("");
  const [, setFocusMode] = createSignal(false);
  const [, setModelDialog] = createSignal(false);
  const [attachments] = createSignal<Attachment[]>([]);
  return {
    draft: () => false,
    sessionId,
    isChild: () => false,
    parentId: () => undefined,
    onOpenParent: () => {},
    input: () => "",
    setInput,
    focusMode: () => false,
    setFocusMode,
    working: () => false,
    sending: () => false,
    sendInFlight: () => false,
    readyToSend: () => false,
    curModel: () => undefined,
    curVariant: () => "",
    modelDialog: () => false,
    setModelDialog,
    ac: {
      acItems: () => [],
      acIndex: () => 0,
      acVisible: () => false,
      setAcIndex: () => {},
      onAcKeyDown: () => false,
      applyAc: () => {},
      dismissAc: () => {},
      syncCaret: () => {},
    },
    att: {
      attachments,
      setAttachments: () => {},
      uploading: () => false,
      addFiles: () => {},
      removeAttachment: () => {},
      reinsertInlineChip: () => {},
      flushPendingAttachments: async () => {},
      uploadFile: async () => null,
      inlineFiles: new Map(),
      presentInlineIds: () => new Set<string>(),
    },
    paste: {
      onPaste: () => {},
      pasteFromClipboard: async () => {},
      onPasteButtonDown: () => {},
      onPasteButtonUp: () => {},
      onPasteButtonClick: () => {},
      onPasteButtonBlur: () => {},
    },
    hist: { onHistoryKey: () => false, resetHistory: () => {} },
    recovery: { retract: async () => {}, markSent: async () => {} },
    send: async () => {},
    abort: () => {},
    refTa: () => {},
    refMirror: () => {},
    refFileInput: () => {},
    onPickFile: () => {},
  };
}

function composerHTML(sessionId = "ses_x"): string {
  const { container, unmount } = render(() => <Composer {...makeProps(() => sessionId)} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("Composer agent-select display states (silent-flip fix, window d)", () => {
  it("pending → shows the explicit resolving placeholder, never a fabricated default", () => {
    setList([...AGENTS]);
    setResolution({ state: "pending" });
    const html = composerHTML("ses_pending");
    expect(html).toContain("Resolving agent…");
    // No Select at all while pending — there is no honest value to show, so
    // there must not be an interactive picker implying one.
    expect(html).not.toContain("agent-select");
    expect(html).not.toContain("@coordination"); // the config default must not be displayed as if real
    expect(html).not.toContain("@supervisor");
  });

  it("unavailable → names the missing agent and asks for a pick, no silent substitution", () => {
    setList([...AGENTS]);
    setResolution({ state: "unavailable", agent: "retired-agent" });
    const html = composerHTML("ses_unavail");
    expect(html).toContain("retired-agent unavailable — pick an agent");
    expect(html).not.toContain("@supervisor"); // not list[0]
    expect(html).not.toContain("@coordination"); // not the config default
  });

  it("agent → shows the evidence-backed agent's label", () => {
    setList([...AGENTS]);
    setResolution({ state: "agent", agent: "supervisor" });
    const html = composerHTML("ses_ok");
    expect(html).toContain("@supervisor");
  });

  it("while the agent list itself has not loaded, the outer gate still says Loading agents…", () => {
    setList([]);
    setResolution({ state: "pending" });
    expect(composerHTML("ses_cold")).toContain("Loading agents…");
  });
});

cleanup();
