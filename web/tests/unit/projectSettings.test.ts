// @vitest-environment jsdom
// Unit tests for the display-only session-title replacement resolver in
// projectSettings.ts. Covers the PURE compile/apply functions (no global state)
// and the signal-backed displayName() (cache identity + never-throws).
import { describe, expect, it } from "vitest";
import {
	applyNameReplacements,
	compileNameReplacements,
	compileNameReplacementErrors,
	displayName,
	nameReplacementErrors,
	setNameReplacements,
	type NameReplacementRule,
} from "../../src/projectSettings";

// apply runs the pure pipeline on a fresh draft (no signal), used by most cases.
function apply(rules: NameReplacementRule[], title: string): string {
	return applyNameReplacements(compileNameReplacements(rules), title);
}

describe("compileNameReplacements / applyNameReplacements — pure pipeline", () => {
	it("no rules → original title unchanged", () => {
		expect(apply([], "[[IMPORTANT]] release")).toBe("[[IMPORTANT]] release");
	});

	it("literal replace (single, no flags)", () => {
		expect(apply([{ pattern: "release", replacement: "ship" }], "release v1")).toBe("ship v1");
	});

	it("flags control global vs single replace", () => {
		// Without g, only the first match is replaced.
		expect(apply([{ pattern: "x", replacement: "_" }], "x x x")).toBe("_ x x");
		// With g, all matches.
		expect(apply([{ pattern: "x", replacement: "_", flags: "g" }], "x x x")).toBe("_ _ _");
	});

	it("capture-group $1 and whole-match $&", () => {
		expect(apply([{ pattern: "(\\w+)@(\\w+)", replacement: "$2/$1" }], "user@host")).toBe(
			"host/user",
		);
		expect(apply([{ pattern: "bing", replacement: "[$&]" }], "bingo")).toBe("[bing]o");
	});

	it("rule array order is preserved", () => {
		// Two different literal rules; order shouldn't matter for non-overlapping
		// patterns, but the array must keep both.
		expect(
			apply(
				[
					{ pattern: "a", replacement: "1" },
					{ pattern: "b", replacement: "2" },
				],
				"ab",
			),
		).toBe("12");
	});

	it("sequential chaining: rule 2 consumes rule 1's output", () => {
		// Rule 1 turns AB→C; rule 2 turns C→D. Final must be D, proving rule 2
		// saw rule 1's output (not the original).
		expect(
			apply(
				[
					{ pattern: "AB", replacement: "C" },
					{ pattern: "C", replacement: "D" },
				],
				"AB",
			),
		).toBe("D");
	});

	it("multiple independent rules each apply", () => {
		expect(
			apply(
				[
					{ pattern: "foo", replacement: "F" },
					{ pattern: "bar", replacement: "B" },
					{ pattern: "baz", replacement: "Z", flags: "g" },
				],
				"foo bar baz baz",
			),
		).toBe("F B Z Z");
	});

	it("empty replacement deletes matches", () => {
		expect(apply([{ pattern: "\\[\\[IMPORTANT\\]\\]", replacement: "" }], "[[IMPORTANT]] release")).toBe(
			" release",
		);
	});

	it("intentionally empty full result is valid (not trimmed/normalized)", () => {
		// Replace the whole string with "" → empty result. Must NOT be trimmed or
		// otherwise post-processed (no normalization).
		expect(apply([{ pattern: "^.*$", replacement: "", flags: "g" }], "anything")).toBe("");
	});
});

describe("compileNameReplacements — fail-soft on invalid rules", () => {
	it("invalid pattern is skipped and flagged, not thrown", () => {
		const set = compileNameReplacements([{ pattern: "([", replacement: "x" }]); // unterminated class
		expect(set.rules.length).toBe(0); // skipped
		expect(set.errors[0]).toBeTruthy();
	});

	it("invalid/duplicate flags are skipped and flagged", () => {
		const invalidFlag = compileNameReplacements([{ pattern: "x", replacement: "y", flags: "q" }]);
		expect(invalidFlag.rules.length).toBe(0);
		expect(invalidFlag.errors[0]).toBeTruthy();
		const dupFlag = compileNameReplacements([{ pattern: "x", replacement: "y", flags: "gg" }]);
		expect(dupFlag.rules.length).toBe(0);
		expect(dupFlag.errors[0]).toBeTruthy();
	});

	it("one invalid rule does not suppress later valid rules", () => {
		const rules: NameReplacementRule[] = [
			{ pattern: "good", replacement: "G" },
			{ pattern: "(unclosed", replacement: "BAD" }, // invalid
			{ pattern: "ok", replacement: "OK", flags: "g" },
		];
		const set = compileNameReplacements(rules);
		// Two valid rules survived (indices 0 and 2); the invalid middle one was
		// skipped but recorded in errors at its own position.
		expect(set.rules.length).toBe(2);
		expect(set.errors[0]).toBeUndefined();
		expect(set.errors[1]).toBeTruthy();
		expect(set.errors[2]).toBeUndefined();
		// Apply proves the surviving rules still run over the title.
		expect(applyNameReplacements(set, "good ok ok")).toBe("G OK OK");
	});

	it("compileNameReplacementErrors exposes per-rule errors for a draft", () => {
		const errs = compileNameReplacementErrors([
			{ pattern: "a", replacement: "b" },
			{ pattern: "(?P<bad", replacement: "x" },
		]);
		expect(errs[0]).toBeUndefined();
		expect(errs[1]).toBeTruthy();
	});

	it("applyNameReplacements never throws on non-string input", () => {
		const set = compileNameReplacements([{ pattern: "x", replacement: "y" }]);
		// @ts-expect-error — defensive: a non-string must not throw.
		expect(applyNameReplacements(set, undefined)).toBe("");
		// @ts-expect-error
		expect(applyNameReplacements(set, null)).toBe("");
		// @ts-expect-error
		expect(applyNameReplacements(set, 42)).toBe("");
	});
});

describe("displayName() — signal-backed resolver", () => {
	it("reflects the saved rules", () => {
		setNameReplacements([{ pattern: "\\[\\[IMPORTANT\\]\\]", replacement: "❗", flags: "g" }]);
		expect(displayName("[[IMPORTANT]] release")).toBe("❗ release");
	});

	it("never throws — invalid rule in the signal is skipped, not fatal", () => {
		setNameReplacements([
			{ pattern: "(unclosed", replacement: "x" },
			{ pattern: "ok", replacement: "OK" },
		]);
		// The invalid rule is skipped; the valid one still applies; no throw.
		expect(() => displayName("ok here")).not.toThrow();
		expect(displayName("ok here")).toBe("OK here");
	});

	it("never throws — non-string / pathological input returns safely", () => {
		setNameReplacements([{ pattern: "x", replacement: "y" }]);
		// @ts-expect-error — defensive: non-string must not throw.
		expect(() => displayName(undefined)).not.toThrow();
		// @ts-expect-error
		expect(() => displayName(null)).not.toThrow();
		// @ts-expect-error
		expect(() => displayName(123)).not.toThrow();
	});

	it("nameReplacementErrors mirrors the saved rules' validity", () => {
		setNameReplacements([
			{ pattern: "a", replacement: "b" },
			{ pattern: "(bad", replacement: "c" },
		]);
		const errs = nameReplacementErrors();
		expect(errs[0]).toBeUndefined();
		expect(errs[1]).toBeTruthy();
	});

	it("compiles once across repeated titles and only recompiles after a signal change", () => {
		// Observe RegExp construction count by wrapping the global constructor
		// for the duration of this test (restored in finally). The module
		// resolves `RegExp` via the global at call time, so the wrap intercepts
		// the cache-miss compile path; cache hits do not construct.
		const realRegExp = globalThis.RegExp;
		let constructions = 0;
		const countingCtor = function PatternCountingRegExp(this: any, ...args: any[]) {
			constructions++;
			// Construct a REAL RegExp so instanceof / replace keep working.
			return new (realRegExp as unknown as new (...a: any[]) => RegExp)(...args);
		} as unknown as RegExpConstructor;
		const restore = () => {
			Object.defineProperty(globalThis, "RegExp", {
				value: realRegExp,
				writable: true,
				configurable: true,
			});
		};
		Object.defineProperty(globalThis, "RegExp", {
			value: countingCtor,
			writable: true,
			configurable: true,
		});
		try {
			setNameReplacements([{ pattern: "foo", replacement: "bar" }]);
			displayName("foo"); // prime the cache (one compile)
			const afterPrime = constructions;
			expect(afterPrime).toBeGreaterThanOrEqual(1);
			// Many subsequent titles must NOT recompile.
			for (let i = 0; i < 50; i++) {
				displayName("foo bar foo " + i);
			}
			expect(constructions).toBe(afterPrime);
			// A new signal value (new array identity) forces a recompile.
			setNameReplacements([{ pattern: "baz", replacement: "qux" }]);
			displayName("baz");
			expect(constructions).toBeGreaterThan(afterPrime);
		} finally {
			restore();
		}
	});
});
