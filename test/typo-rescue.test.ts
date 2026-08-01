// One extra ("generric"), one missing ("genric"), one wrong ("genaric");
// the adjacent swap has its own file.
import { describe, expect, it } from "vite-plus/test";
import { createFuzzySearch, fuzzyMatch, SCORES } from "../src/index";

describe("a query missing a character", () => {
	it("a dropped keystroke in an otherwise exact word", () => {
		const r = fuzzyMatch("generic", "genric");
		expect(r?.tier).toBe("corrected");
		expect(r?.corrected).toBe("generic");
		expect(r?.score).toBeCloseTo(2.1); // exact (0) + penalty
		expect(r?.ranges).toEqual([[0, 6]]);
	});

	it("highlights the whole corrected word, not the two fragments", () => {
		expect(fuzzyMatch("ergonomic", "ergonmic")?.ranges).toEqual([[0, 8]]);
	});

	it("scores off the tier the corrected query would have earned", () => {
		// Corrected query is the whole field but not case-identical → the
		// normalised-exact tier (0.1), not the raw exact tier (0).
		expect(fuzzyMatch("Wooden Table", "wooden tble")?.score).toBeCloseTo(2.2);
		// Corrected query sits at a word boundary inside a longer field → 1 + 2.1.
		expect(fuzzyMatch("Tasty Silk Towels", "towls")?.score).toBeCloseTo(3.1);
	});

	it("holds the same 4-character minimum as every other rescue", () => {
		// The chain may still survive ("cat" is a genuine subsequence of "coat"),
		// just not the typo tier and the rank that comes with it.
		expect(fuzzyMatch("coat", "cat")?.tier).toBe("fuzzy");
		expect(fuzzyMatch("axb", "ab")?.tier).toBe("fuzzy");
		expect(fuzzyMatch("the", "hte")).toBeNull(); // transposed, for comparison
		expect(fuzzyMatch("South Raven, Bangladesh", "soth")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "south",
		});
		expect(fuzzyMatch("Small Silk Chair", "smll")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "small",
		});
	});

	describe("a skipped separator is not a typo", () => {
		// Promoting concatenated-word matching to a typo tier would rank it on
		// the strength of a space the user never had to type.
		it("stays in the fuzzy tier when the gap is a word separator", () => {
			const r = fuzzyMatch("big cat", "bigcat");
			expect(r?.tier).toBe("fuzzy");
			expect(r?.score).toBeCloseTo(2.4);
		});

		it("holds for a longer separator-skipping query", () => {
			expect(fuzzyMatch("hello world", "helloworld")?.tier).toBe("fuzzy");
		});
	});
});

describe("a query with one character too many", () => {
	it("a doubled keystroke in an otherwise exact word", () => {
		const r = fuzzyMatch("generic", "generric");
		expect(r?.tier).toBe("corrected");
		expect(r?.corrected).toBe("generic");
		expect(r?.score).toBeCloseTo(2.1);
		expect(r?.ranges).toEqual([[0, 6]]);
	});

	it("recovers a doubled keystroke anywhere in the query", () => {
		expect(fuzzyMatch("ergonomic", "ergonomiic")?.corrected).toBe("ergonomic");
		expect(fuzzyMatch("administrator", "administtrator")?.corrected).toBe("administrator");
	});

	it("scores off the corrected query's tier inside a longer field", () => {
		expect(fuzzyMatch("Silk Towels", "towells")?.score).toBeCloseTo(3.1);
		expect(fuzzyMatch("Silk Towels", "towells")?.ranges).toEqual([[5, 10]]);
	});

	it("recovers an extra character the field does not contain at all", () => {
		// Only survives because the mask gate tolerates one missing class, and
		// only the drop family can explain it.
		const r = fuzzyMatch("generic", "genexric");
		expect(r?.tier).toBe("corrected");
		expect(r?.score).toBeCloseTo(2.1);
	});
});

describe("a query with one wrong character", () => {
	it("a mistyped character in an otherwise exact word", () => {
		const r = fuzzyMatch("generic", "genaric");
		expect(r?.tier).toBe("corrected");
		expect(r?.corrected).toBe("generic");
		expect(r?.score).toBeCloseTo(2.1);
		expect(r?.ranges).toEqual([[0, 6]]);
	});

	it("works when the wrong character is absent from the field entirely", () => {
		expect(fuzzyMatch("ergonomic", "ergonomiq")?.corrected).toBe("ergonomic");
	});

	it("finds the window when the surviving half is the second one", () => {
		expect(fuzzyMatch("ergonomic", "ergonomic".replace("e", "z"))?.corrected).toBe("ergonomic");
	});

	it("applies a length floor that scales with the field", () => {
		// Chance windows are a multiple-comparisons problem: six characters
		// identify a short label and are pure noise inside a document.
		expect(fuzzyMatch("wooden", "woaden")?.corrected).toBe("wooden");

		const document = `${"lorem ipsum dolor sit amet ".repeat(60)}wooden`;
		expect(document.length).toBeGreaterThan(1024);
		expect(fuzzyMatch(document, "woaden")).toBeNull();
	});
});

describe("the rescue takes the cheapest explanation", () => {
	it("a decoy chain does not pre-empt a clean one-edit reading", () => {
		expect(fuzzyMatch("Small Bronze Ball", "smaall")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "small",
		});
		expect(fuzzyMatch("Rustic Plastic Bike", "rusttic")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "rustic",
		});
		expect(fuzzyMatch("Bradford Barrows III", "bradi")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "brad",
		});
	});

	it("prefers a boundary variant over a mid-word one enumerated earlier", () => {
		expect(fuzzyMatch("zzenerric generic", "generric")).toMatchObject({
			score: 3.0,
			tier: "corrected",
			corrected: "generic",
			ranges: [[10, 16]],
		});
	});

	it("prefers a prefix substitution window over a mid-word one found first", () => {
		expect(fuzzyMatch("gxnaric xgeneric", "genaric")).toMatchObject({
			score: 2.6,
			tier: "corrected",
			corrected: "gxnaric",
			ranges: [[0, 6]],
		});
	});

	it("prefers a substitution window the chain would have hidden", () => {
		expect(fuzzyMatch("xgeneric gxnaric", "genaric")).toMatchObject({
			score: 3.0,
			tier: "corrected",
		});
	});
});

describe("the correction is applied to the query, not the field", () => {
	it("scores exactly the corrected query's own tier, in every casing", () => {
		for (const [field, typed, corrected] of [
			["silk towels", "towells", "towels"],
			["Silk Towels", "towells", "towels"],
			["silk towels", "TOWELLS", "TOWELS"],
			["generic", "genric", "generic"],
			["Generic", "genric", "generic"],
			["generic", "GENRIC", "GENERIC"],
		] as const) {
			const rescued = fuzzyMatch(field, typed);
			const literal = fuzzyMatch(field, corrected);
			expect(rescued?.score, `${field} / ${typed} → ${rescued?.tier}`).toBeCloseTo(
				(literal?.score as number) + 2.1,
			);
		}
	});

	it("does not credit a mismatched-case query with the exact-case tiers", () => {
		expect(fuzzyMatch("generic", "GENRIC")?.score).toBeCloseTo(2.2);
		expect(fuzzyMatch("silk towels", "TOWELLS")?.score).toBeCloseTo(3.1);
	});

	it("still credits a case-identical query with the exact-case tiers", () => {
		expect(fuzzyMatch("generic", "genric")?.score).toBeCloseTo(2.1);
		expect(fuzzyMatch("silk towels", "towells")?.score).toBeCloseTo(3.0);
	});
});

describe("the relaxed mask gate matches what a rescue can explain", () => {
	// Primitive and searcher assert together: a searcher stricter than the
	// matcher silently drops hits, a looser one scans for nothing.

	it("a query too short to correct through a missing class finds nothing", () => {
		expect(fuzzyMatch("gene", "genx")).toBeNull();
		expect(createFuzzySearch(["gene"])("genx")).toHaveLength(0);
	});

	it("one character longer, and both agree it can", () => {
		expect(fuzzyMatch("genes", "genxs")?.tier).toBe("corrected");
		expect(createFuzzySearch(["genes"])("genxs")[0]?.fields[0]?.tier).toBe("corrected");
	});

	it("a multi-word query relaxes once its mistyped word is long enough", () => {
		expect(fuzzyMatch("wooden table", "wooden tablx")?.tier).toBe("corrected");
		expect(createFuzzySearch(["wooden table"])("wooden tablx")[0]?.fields[0]?.tier).toBe(
			"corrected",
		);
	});

	it("a multi-word query keeps the strict gate while every word is under the floor", () => {
		expect(fuzzyMatch("big oak", "big oakx")).toBeNull();
		expect(createFuzzySearch(["big oak"])("big oakx")).toHaveLength(0);
	});
});

describe("one edit only", () => {
	it("two edits stay unmatched", () => {
		// An extra "y" AND a missing "a" — edit distance 2.
		expect(fuzzyMatch("keyboard", "keyybord")).toBeNull();
	});

	it("two substitutions stay unmatched", () => {
		expect(fuzzyMatch("ergonomic", "ergqnomiq")).toBeNull();
	});
});

describe("a certain match always beats a speculative one", () => {
	// The penalty is sized so the *best* possible correction — a corrected exact
	// hit, 0 + 2.1 — still sorts below the *weakest* genuine tier, contains (2).
	// Sized any lower and a one-character guess about what the user meant
	// outranks a literal substring they actually typed, which measurably sank
	// infix ranking (MRR 0.973 → 0.906 at a 0.9 penalty).
	it("every one-edit correction scores above SCORES.CONTAINS", () => {
		for (const [field, query] of [
			["generic", "genric"], // deleted
			["generic", "generric"], // inserted
			["generic", "genaric"], // substituted
			["generic", "geenric"], // transposed
		] as const) {
			const r = fuzzyMatch(field, query);
			expect(r?.score, `${query} → ${r?.tier}`).toBeGreaterThan(SCORES.CONTAINS);
		}
	});

	it("a literal infix hit outranks another item's typo correction", () => {
		// "eneri" is a genuine infix of one item and one substitution from the other.
		const search = createFuzzySearch(["Enero Calendar", "Generic Widget"]);
		const results = search("eneri");
		expect(results[0]?.item).toBe("Generic Widget");
		expect(results[0]?.fields[0]?.tier).toBe("contains");
	});

	it("an item excluded by a shorter query's strict gate is still reachable", () => {
		// The gate relaxes at the 5th character, so the survivor set built at 4
		// is not a valid superset — and every query is typed through 4.
		const search = createFuzzySearch(["Ergonomic Granite Hat"]);
		search("ergq");
		expect(search("ergqnomic")[0]?.fields[0]?.tier).toBe("corrected");
	});

	it("a corrected hit still beats no hit at all", () => {
		const search = createFuzzySearch(["Silk Towels", "Cotton Rug"]);
		const results = search("towles");
		expect(results[0]?.item).toBe("Silk Towels");
		expect(results[0]?.fields[0]?.tier).toBe("corrected");
		expect(results[0]?.fields[0]?.corrected).toBe("towels");
	});
});
