import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeAnswer } from "./judge.js";

const LOCAL = { strictness: 7, aiJudge: false };

async function verdict(submitted: string, canonical: string): Promise<string> {
	return (await judgeAnswer(submitted, canonical, "", LOCAL)).verdict;
}

test("judge: local matching accepts common equivalent forms", async () => {
	const correct: [string, string][] = [
		["shakespear", "William Shakespeare"],
		["bonapart", "Napoleon Bonaparte"],
		["atkinson", "Rowan Atkinson"],
		["james 1", "James I"],
		["world war two", "World War II"],
		["ussr", "Union of Soviet Socialist Republics"],
		["UK", "United Kingdom"],
		["john kennedy", "John Fitzgerald Kennedy"],
		["battle of hastings", "Hastings"],
		["river thames", "Thames"],
		["king henry 8", "Henry VIII"],
		["george gordon byron", "Lord Byron [accept George Gordon Byron; prompt on Byron]"],
		["bakerloo", "{Bakerloo} line"],
	];
	for (const [submitted, canonical] of correct) {
		assert.equal(await verdict(submitted, canonical), "correct", `${submitted} for ${canonical}`);
	}
});

test("judge: without the AI judge, partial answers prompt and the rest are incorrect", async () => {
	assert.equal(await verdict("byron", "Lord Byron [prompt on Byron]"), "prompt");
	assert.equal(await verdict("war", "Crimean War"), "prompt");
	assert.equal(await verdict("empire", "Holy Roman Empire"), "prompt");
	assert.equal(await verdict("roman empire", "Holy Roman Empire"), "prompt");
	assert.equal(await verdict("manet", "Claude Monet"), "incorrect");
	assert.equal(await verdict("gordon", "Lord Byron [do not accept Gordon]"), "incorrect");
	assert.equal(await verdict("cambridgeshire", "{Ely}, Cambridgeshire"), "incorrect");
	assert.equal(await verdict("", "Paris"), "incorrect");
});
