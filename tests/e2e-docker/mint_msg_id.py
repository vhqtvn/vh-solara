#!/usr/bin/env python3
"""Mint a valid ascending OpenCode message id (caller-minted messageID).

Replicates pkg/opencode/id.go MintMessageID byte-for-byte, which itself mirrors
sst/opencode v1.17.18 Identifier.ascending("message")
(packages/opencode/src/id/id.ts). See
researches/sources/opencode-v1.17.18-messageid-exact-lookup.md §1 for the
authoritative byte layout.

Layout (EXACT):
    "msg_" + hex(6 bytes) + base62(14)
where the 6 bytes are the big-endian low 48 bits of
    now = unixMilli * 0x1000 + counter
and counter starts at 1 on the first mint within a millisecond (id.ts:
`counter = 0; counter++`). The 12-hex prefix is monotonically non-decreasing
with wall-clock time so the id interleaves correctly with real OpenCode ids
under OpenCode's string-based latest()/pagination ordering; the trailing 14
base62 chars are random and unordered.

This mints ONE fresh id per invocation and prints it to stdout (no newline
trailing junk beyond the standard one). It is the caller-id a test threads into
prompt_async's `messageID` body key; OpenCode v1.17.18 persists it verbatim
(caller-id-wins, no remint), which is the contract under test.

Why a faithful ascending mint (not just "msg_" + anything): OpenCode's brand
check accepts any `msg_`-prefixed value, but ONLY a byte-exact ascending id
sorts correctly relative to real OpenCode ids. Using the real format keeps the
docker-gold probe representative of what vh-solara's queue actually mints.
"""
import secrets
import time

# Mirrors opencodeIDAlphabet in pkg/opencode/id.go (id.ts randomBase62):
# digits, then UPPER-case, then lower-case. The within-alphabet ordering does
# not affect sort order (ordering is the time-ordered hex prefix); only the
# length (14) and the 62-symbol charset matter for format fidelity.
_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_SUFFIX_BASE62_LEN = 14  # opencodeIDSuffixLen(26) - 12 hex = 14


def mint_message_id() -> str:
    ms = int(time.time() * 1000)
    # counter = 1: first mint within this ms (id.ts: counter = 0; counter++).
    now = (ms * 0x1000) + 1
    low48 = now & ((1 << 48) - 1)
    # 6 bytes big-endian -> 12 lowercase hex chars (mirrors id.ts timeBytes +
    # Go hex.EncodeToString(tb[:])).
    hexpart = low48.to_bytes(6, "big").hex()
    # 14 base62 chars from crypto-grade randomness, modulo the 62-symbol
    # alphabet. The modulo bias is intentional fidelity to id.ts's randomBase62
    # (it affects neither sort order nor uniqueness).
    rb = secrets.token_bytes(_SUFFIX_BASE62_LEN)
    suffix = "".join(_ALPHABET[b % len(_ALPHABET)] for b in rb)
    return "msg_" + hexpart + suffix


if __name__ == "__main__":
    print(mint_message_id())
