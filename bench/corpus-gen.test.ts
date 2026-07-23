/**
 * One-shot generator for the committed corpus-*.json snapshots. The corpora are
 * frozen as JSON so bench processes don't pay faker generation each run, and so
 * the data cannot drift when faker changes generator internals between versions.
 * Every rank/MRR table in docs/benchmarks.md derives from these sequences —
 * regenerating rewrites history for all of them, so it's gated:
 *   GEN_CORPUS=1 pnpm --filter=krino-bench exec vitest run corpus-gen
 * Generation logic is verbatim from the original corpus.ts builders: en corpus
 * from the four ascii generators; mixed replaces every 7th item from fr/pl
 * generators (~5% diacritic density). Single reseed then sequential generation,
 * so a prefix slice of the 100k file equals a smaller build (1k ⊂ 10k ⊂ 100k).
 */
import { writeFileSync } from "node:fs";
import { faker, fakerFR, fakerPL } from "@faker-js/faker";
import { it } from "vitest";

const MAX = 100_000;
const SEED = 20240607;

const seedAll = (): void => {
	faker.seed(SEED);
	fakerFR.seed(SEED);
	fakerPL.seed(SEED);
};

const ASCII_GENERATORS: Array<() => string> = [
	() => faker.commerce.productName(),
	() => faker.company.name(),
	() => faker.person.fullName(),
	() => `${faker.location.city()}, ${faker.location.country()}`,
];

const ACCENTED_GENERATORS: Array<() => string> = [
	() => fakerFR.person.fullName(),
	() => fakerPL.company.name(),
	() => fakerPL.person.fullName(),
];

const buildAscii = (n: number): string[] => {
	seedAll();
	const out: string[] = [];
	for (let i = 0; i < n; i++) out.push(ASCII_GENERATORS[i % ASCII_GENERATORS.length]());
	return out;
};

const buildMixed = (n: number): string[] => {
	seedAll();
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		out.push(
			i % 7 === 0
				? ACCENTED_GENERATORS[(i / 7) % ACCENTED_GENERATORS.length]()
				: ASCII_GENERATORS[i % ASCII_GENERATORS.length](),
		);
	}
	return out;
};

it.skipIf(!process.env.GEN_CORPUS)("regenerates the committed corpus snapshots", () => {
	writeFileSync(new URL("./corpus-ascii.json", import.meta.url), JSON.stringify(buildAscii(MAX)));
	writeFileSync(new URL("./corpus-mixed.json", import.meta.url), JSON.stringify(buildMixed(MAX)));
});
