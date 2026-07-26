/**
 * Builds one bundle per combination of src/flags.ts switches, so index
 * experiments can be measured against each other by the ordinary harness:
 * speed.ts gives each variant a build/cold/warm cell, memory.ts a footprint,
 * hits.test.ts a rank and MRR.
 *
 * Copy-and-rewrite rather than a runtime option, because the point is to
 * compare index designs and a runtime switch would put dispatch in the scan
 * loop being measured. Each bundle here is byte-identical to what would ship if
 * that variant won.
 *
 *   node bench/variants.ts               # build every variant in VARIANTS
 *   node bench/variants.ts baseline dispatch
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("./.variants/", import.meta.url);

/** Flag combinations worth measuring. `baseline` is every switch off. */
export const VARIANTS: Record<string, string[]> = {
	baseline: [],
	dispatch: ["MISSING_CLASS_DISPATCH"],
	lazy: ["LAZY_FIELDS"],
	"lazy+dispatch": ["LAZY_FIELDS", "MISSING_CLASS_DISPATCH"],
	all: ["MISSING_CLASS_DISPATCH", "LAZY_FIELDS"],
};

export const variantEntry = (name: string): string =>
	fileURLToPath(new URL(`./${name}/index.mjs`, OUT));

const buildVariant = (name: string, enabled: string[]): void => {
	const work = fileURLToPath(new URL(`./.work-${name}/`, OUT));
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	cpSync(fileURLToPath(new URL("./src/", ROOT)), `${work}/src`, { recursive: true });

	const flagsPath = `${work}/src/flags.ts`;
	let flags = readFileSync(flagsPath, "utf8");
	for (const flag of enabled) {
		const before = flags;
		flags = flags.replace(`export const ${flag}: boolean = false;`, `export const ${flag}: boolean = true;`);
		if (flags === before) throw new Error(`variant '${name}': no flag named '${flag}' in src/flags.ts`);
	}
	writeFileSync(flagsPath, flags);

	// Minified, matching the shipped build: the dead branch is removed outright
	// rather than left as an inlined `if (false)`.
	execFileSync(
		"pnpm",
		["exec", "tsdown", "--entry", `${work}/src/index.ts`, "--format", "esm", "--no-dts", "--minify", "--out-dir", fileURLToPath(new URL(`./${name}/`, OUT))],
		{ cwd: fileURLToPath(ROOT), stdio: ["ignore", "ignore", "inherit"] },
	);
	rmSync(work, { recursive: true, force: true });
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(VARIANTS);
mkdirSync(fileURLToPath(OUT), { recursive: true });
for (const name of names) {
	const enabled = VARIANTS[name];
	if (!enabled) throw new Error(`unknown variant '${name}' — have ${Object.keys(VARIANTS).join(", ")}`);
	buildVariant(name, enabled);
	console.error(`built ${name.padEnd(16)} ${enabled.length ? enabled.join(" + ") : "(all flags off)"}`);
}
