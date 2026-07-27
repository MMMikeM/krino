// The same false-pass-only invariant test/raw-mask.test.ts pins, swept over
// every string the published corpora hold — where the real Unicode lives.
import { expect, it } from "vitest";
import { charMask } from "../src/gates";
import { normalizeText, rawCharMask } from "../src/normalize";
import { CORPORA } from "./corpus";

it("rawCharMask never drops a bit over either corpus", { timeout: 300_000 }, () => {
	for (const { name, build } of CORPORA) {
		const list = build(100_000);
		// Collected rather than asserted per item: 100k assertions per corpus is
		// enough allocation to take the worker down with it.
		const drops: string[] = [];
		let extra = 0;
		for (const raw of list) {
			const eager = charMask(normalizeText(raw.trim()));
			const lazy = rawCharMask(raw);
			if (eager & ~lazy) drops.push(raw);
			else if (eager !== lazy) extra++;
		}
		process.stderr.write(`  ${name}: ${list.length} items, ${extra} carry extra bits\n`);
		expect(drops).toEqual([]);
	}
});
