/**
 * Compile-time checks for the v1.0 overloads and types. tsconfig includes
 * test/**, so `pnpm lint:types` enforces these; the runtime bodies are incidental.
 */
import { describe, expect, it } from "vitest";
import { createFuzzySearch, fuzzyMatch, SCORES } from "../src/index";
import type { FieldSpec, FuzzyResult, MatchResult } from "../src/index";

type User = { name: string; email: string };

describe("types", () => {
	it("string overload infers FuzzyResult<string>", () => {
		const r: FuzzyResult<string> | undefined = createFuzzySearch(["a", "b"])("a")[0];
		expect(r === undefined || typeof r.item === "string").toBe(true);
	});

	it("getText overload infers the item type without a cast", () => {
		const users: User[] = [{ name: "Ada", email: "a@x.com" }];
		// If T weren't inferred as User, u.name would not typecheck.
		const r: FuzzyResult<User> | undefined = createFuzzySearch(users, (u) => u.name)("ada")[0];
		expect(r?.item.name ?? "Ada").toBe("Ada");
	});

	it("field-spec overload typechecks acronym/atBest", () => {
		const users: User[] = [{ name: "United States", email: "us@x.com" }];
		const fields: FieldSpec<User>[] = [
			{ text: (u) => u.name, acronym: true, atBest: SCORES.CONTAINS },
			{ text: (u) => u.email },
		];
		const first: MatchResult | null | undefined = createFuzzySearch(users, fields)("us")[0]
			?.fields[0];
		expect(first == null || typeof first.tier === "string").toBe(true);
	});

	it("primitive returns MatchResult", () => {
		const m: MatchResult | null = fuzzyMatch("banana", "ban", { acronym: false });
		expect(m?.tier).toBe("prefix");
	});
});
