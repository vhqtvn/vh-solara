#!/usr/bin/env python3
"""Offline, docker-free verification of the lane-4 flow-1 stream assertions.

Promoted from the B8 scratch stub
(tmp/agent-runs/page-load-perf-residuals/b8/test_decode_stub.py) and extended
to close the B8 c-F1 DEFER: the batch-absent (legacy-only) capture case is
SYNTHESIZED here, per the defer's own escape hatch ("synthesize in the offline
stub"), because a live batch-absent cold-boot capture could not be obtained
deterministically in the docker lane.

Two independent layers, both pure python3, no docker, no network:

1. DECODE STUB -- extracts the gzip64-decode python block VERBATIM from
   run.sh (so the test exercises the exact shipped code, not a copy) and
   feeds it synthetic SSE captures: positive, negative, malformed base64
   (must skip, not crash), non-gzip payloads, and noise frames.

2. GATE TRUTH TABLE -- re-implements in python the three flow-1 shell gate
   conditions exactly as run.sh expresses them, then drives them with
   synthetic captures of every wire shape:
     delivery gate : messages.batch>0 OR message.upsert>0      else FAIL
     part gate     : messages.batch>0 OR >=1 part.upsert line  else FAIL
                     (ONLY a messages.batch waives the per-part streaming
                     requirement; message.upsert alone does NOT)
     text gate     : raw substring present OR inside any decoded gzip64
                     messages.batch payload                      else FAIL

Run: python3 tests/e2e-docker/decode_check.py    (exit 0 = all cases green)
"""
import base64
import gzip
import json
import os
import subprocess
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RUN_SH = os.path.join(REPO, "tests", "e2e-docker", "run.sh")

with open(RUN_SH) as f:
    src = f.read()

START = "&& ! python3 -c '"
END = "' < \"$STREAM_FILE\"; then"
i = src.index(START) + len(START)
j = src.index(END, i)
PY_BLOCK = src[i:j]
assert "gzip.decompress" in PY_BLOCK and "FAKE-LLM reply" in PY_BLOCK, \
    "extraction landed on the wrong block"

# The exact shell fail messages the gate truth table must reproduce (run.sh,
# flow 1: "verifying the live /vh/stream delivered streaming events").
GATE_MSG_DELIVERY = "no message.upsert or messages.batch events on /vh/stream"
GATE_MSG_PART = "no part.upsert (streaming) events on /vh/stream"
GATE_MSG_TEXT = ("streamed assistant text not seen on /vh/stream "
                 "(raw or in a messages.batch payload)")

NOISE = "event: ping\ndata: {}\n\nid: 5\nevent: status\ndata: {\"ok\":true}\n\n"


def sse(kind, data):
    return "event: %s\ndata: %s\n\n" % (kind, data)


def make_upsert_frame(text, session="ses_e2e"):
    """Legacy per-event shape: message.upsert carrying the RAW text."""
    payload = {"info": {"id": "m1", "sessionID": session, "role": "assistant"},
               "parts": [{"id": "p1", "type": "text", "text": text}]}
    return sse("message.upsert", json.dumps(payload))


def make_part_frame(text):
    """Legacy streaming shape: part.upsert with the RAW text on its data line."""
    payload = {"id": "p1", "type": "text", "text": text}
    return sse("part.upsert", json.dumps(payload))


def make_batch_frame(text=None, session="ses_e2e"):
    """SSE messages.batch frame exactly like packageMessagesBatch
    (pkg/state/message_window.go): data = base64(gzip({"messages":[...]}))."""
    inner = {"messages": []}
    if text is not None:
        inner["messages"].append({
            "info": {"id": "m1", "sessionID": session, "role": "assistant"},
            "parts": [{"id": "p1", "type": "text", "text": text}],
        })
    raw = json.dumps(inner).encode()
    blob = base64.b64encode(gzip.compress(raw)).decode()
    payload = {"sessionID": session, "encoding": "gzip64",
               "data": blob, "window": {"count": len(inner["messages"])}}
    return sse("messages.batch", json.dumps(payload))


# --- layer 1: the verbatim decode stub ----------------------------------------

def run_stub(capture_text):
    """Run the extracted python block with the capture on stdin; return
    (exit_code, stderr)."""
    p = subprocess.run([sys.executable, "-c", PY_BLOCK], input=capture_text,
                       capture_output=True, text=True)
    return p.returncode, p.stderr


DECODE_CASES = [
    ("decode: text inside gzip64 batch",
     NOISE + make_batch_frame("hello FAKE-LLM reply body") + NOISE, 0),
    ("decode: batch without the text",
     NOISE + make_batch_frame("unrelated content"), 1),
    ("decode: empty capture", "", 1),
    ("decode: noise only (no batch)", NOISE, 1),
    ("decode: ping with encoding gzip64 but bad base64",
     'event: messages.batch\ndata: {"sessionID":"x","encoding":"gzip64","data":"!!!notb64!!!"}\n\n', 1),
    ("decode: gzip64 data that is valid b64 but not gzip",
     'event: messages.batch\ndata: {"sessionID":"x","encoding":"gzip64","data":"aGVsbG8="}\n\n', 1),
    ("decode: bad first frame, good second",
     'event: messages.batch\ndata: {"sessionID":"x","encoding":"gzip64","data":"!!!"}\n\n'
     + make_batch_frame("FAKE-LLM reply present here"), 0),
]

# --- layer 2: the flow-1 gate truth table (mirrors the shell conditions) ------

def count_event(capture, kind):
    """Mirror of: grep -c '^event: <kind>' (line-prefix match, like grep)."""
    return sum(1 for ln in capture.splitlines()
               if ln.startswith("event: " + kind))


def batch_text_found(capture, needle="FAKE-LLM reply"):
    """Mirror of the run.sh text gate: raw substring OR inside any decoded
    gzip64 batch payload (base64 -> gunzip -> search); skip-not-crash."""
    if needle in capture:
        return True
    for line in capture.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            d = json.loads(line[6:])
        except Exception:
            continue
        if d.get("encoding") != "gzip64":
            continue
        try:
            inner = gzip.decompress(base64.b64decode(d.get("data", "")))
        except Exception:
            continue
        if needle.encode() in inner:
            return True
    return False


def flow1_gates(capture):
    """Return the list of run.sh flow-1 fail messages that WOULD fire for
    this capture (empty list = all gates pass). Mirrors the shell exactly:
    batch>0 waives the part.upsert requirement; both-zero fails delivery;
    text = raw OR decoded."""
    failures = []
    batch = count_event(capture, "messages.batch")
    upsert = count_event(capture, "message.upsert")
    parts = count_event(capture, "part.upsert")
    if batch == 0 and upsert == 0:
        failures.append(GATE_MSG_DELIVERY)
    if batch == 0 and parts == 0:
        failures.append(GATE_MSG_PART)
    if not batch_text_found(capture):
        failures.append(GATE_MSG_TEXT)
    return failures


GATE_CASES = [
    # (name, capture, expected_failures)
    ("gate: legacy-only capture (BATCH-ABSENT) -> all gates PASS "
     "[c-F1 closure: message.upsert + part.upsert + raw text, no batch]",
     NOISE + make_upsert_frame("FAKE-LLM reply: legacy raw shape")
          + make_part_frame("FAKE-LLM reply: legacy raw shape"), []),
    ("gate: batch-only capture (B8 run2 cold-boot shape) -> all gates PASS "
     "[batch waives part.upsert; text found via gzip64 decode]",
     NOISE + make_batch_frame("FAKE-LLM reply inside gzip64"), []),
    ("gate: mixed capture (upsert + part + batch) -> all gates PASS",
     make_upsert_frame("user prompt echo") + make_part_frame("stream chunk")
     + make_batch_frame("FAKE-LLM reply in batch"), []),
    ("gate: empty capture -> delivery + part + text gates ALL FAIL",
     "", [GATE_MSG_DELIVERY, GATE_MSG_PART, GATE_MSG_TEXT]),
    ("gate: noise-only capture -> delivery + part + text gates ALL FAIL",
     NOISE, [GATE_MSG_DELIVERY, GATE_MSG_PART, GATE_MSG_TEXT]),
    ("gate: upsert WITHOUT part.upsert -> ONLY the part gate FAILS "
     "[message.upsert does NOT waive the per-part requirement]",
     make_upsert_frame("FAKE-LLM reply raw in upsert data"), [GATE_MSG_PART]),
    ("gate: batch WITHOUT the needle -> ONLY the text gate FAILS "
     "[delivery + part both waived by batch]",
     NOISE + make_batch_frame("unrelated content"), [GATE_MSG_TEXT]),
]


def main():
    failures = 0
    total = 0
    print("layer 1: verbatim decode stub extracted from run.sh")
    for name, capture, want in DECODE_CASES:
        total += 1
        code, err = run_stub(capture)
        ok = code == want
        failures += 0 if ok else 1
        print("  %s %s (want exit %d, got %d)%s"
              % ("PASS" if ok else "FAIL", name, want, code,
                 (" stderr: " + err.strip()) if (err.strip() and not ok) else ""))
    print("layer 2: flow-1 gate truth table on synthetic captures")
    for name, capture, want_failures in GATE_CASES:
        total += 1
        got = flow1_gates(capture)
        ok = got == want_failures
        failures += 0 if ok else 1
        want_detail = "none" if not want_failures else " | ".join(want_failures)
        got_detail = "none" if not got else " | ".join(got)
        print("  %s %s" % ("PASS" if ok else "FAIL", name))
        print("      expected fails: %s" % want_detail)
        print("      observed fails: %s" % got_detail)
    print("decode_check: %d/%d cases passed" % (total - failures, total))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
