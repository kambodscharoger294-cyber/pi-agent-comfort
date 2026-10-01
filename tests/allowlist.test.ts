import { describe, expect, test } from "bun:test";
import { isSafeCommand, extractTodoItems, extractDoneSteps, markCompletedSteps } from "../extensions/plan-mode/utils.ts";
// The allowlist is the security-relevant part of plan mode: in plan mode the
// agent must be able to look, but not to change anything.

describe("isSafeCommand — must be allowed (read-only)", () => {
	const safe = [
		"ls -la",
		"cat file.txt",
		"head -20 README.md",
		"tail -f log.txt",
		"grep -rn pattern src/",
		"rg pattern",
		"find . -name '*.ts'",
		"fd -e ts",
		"pwd",
		"tree -L 2",
		"git status",
		"git log --oneline -5",
		"git diff",
		"git branch",
		"npm list",
		"uname -a",
		"whoami",
		"date",
		"uptime",
		"wc -l file",
		"which node",
		"node --version",
	];
	for (const cmd of safe) {
		test(`allows: ${cmd}`, () => {
			expect(isSafeCommand(cmd)).toBe(true);
		});
	}
});

describe("isSafeCommand — must be blocked", () => {
	const unsafe = [
		// file modification
		"rm foo.txt",
		"rm -rf /tmp/x",
		"mv a b",
		"cp a b",
		"mkdir x",
		"touch x",
		"sed -i s/a/b/ f",
		"find . -delete",
		// git writes
		"git add .",
		"git commit -m x",
		"git push",
		"git reset --hard",
		"git checkout .",
		// package installs
		"npm install",
		"pip install x",
		"brew install x",
		// network writes to disk
		"curl -o file https://example.com",
		"curl -O https://example.com/x",
		"wget https://example.com/x",
		// system
		"sudo ls",
		"kill 123",
		"reboot",
		"shutdown -h now",
		// editors / interactive
		"vim f",
		"nano f",
	];
	for (const cmd of unsafe) {
		test(`blocks: ${cmd}`, () => {
			expect(isSafeCommand(cmd)).toBe(false);
		});
	}
});

describe("plan parsing", () => {
	test("extracts numbered steps from a Plan: section", () => {
		const text = ["Here is the plan:", "", "Plan:", "1. Read the auth module", "2. Add the rate limit", "3. Run the test suite"].join("\n");
		const todos = extractTodoItems(text);
		expect(todos.length).toBe(3);
		expect(todos[0].step).toBe(1);
		expect(todos[0].completed).toBe(false);
		// The widget shows compressed labels: the leading action verb and a
		// following "the" are stripped ("Read the auth module" → "Auth module").
		expect(todos[0].text).toBe("Auth module");
		expect(todos[1].text).toBe("Rate limit");
	});

	test("skips noise lines (too short, or the label ends up empty)", () => {
		// Dropped: <= 5 chars of text, labels starting with `/` or a backtick,
		// and labels that are only a filler verb ("Write the" → empty).
		const text = ["Plan:", "1. Read the auth module", "2. ok", "3. /reload now", "4. Write the"].join("\n");
		expect(extractTodoItems(text).length).toBe(1);
	});

	test("finds [DONE:n] markers regardless of case", () => {
		expect(extractDoneSteps("step one [DONE:1] and another [done:2]")).toEqual([1, 2]);
		expect(extractDoneSteps("no markers here")).toEqual([]);
	});

	test("marks completed steps via [DONE:n] and leaves the rest open", () => {
		const text = ["Plan:", "1. Read the auth module", "2. Add the rate limit", "3. Run the test suite"].join("\n");
		const todos = extractTodoItems(text);
		const marked = markCompletedSteps("1. Read the auth module [DONE:1]", todos);
		expect(marked).toBe(1);
		expect(todos[0].completed).toBe(true);
		expect(todos[1].completed).toBe(false);
		expect(todos[2].completed).toBe(false);
	});

	test("keeps steps that start with a backticked path (regression)", () => {
		// The noise filter used to drop every line starting with a backtick, which
		// silently lost steps like "2. `src/app.ts` schreiben – …" and made the
		// progress list shift by one.
		const text = ["Plan:", "1. Verzeichnis src anlegen", "2. `src/app.ts` schreiben", "3. `npm test`"].join("\n");
		const todos = extractTodoItems(text);
		expect(todos.length).toBe(2);
		expect(todos[1].text).toContain("rc/app.ts"); // cleanStepText capitalises the label
	});

	test("returns nothing when there is no Plan: header", () => {
		expect(extractTodoItems("Just a normal answer without a plan.").length).toBe(0);
	});
});

describe("[DONE:n] scanning", () => {
	function todos(count: number) {
		return Array.from({ length: count }, (_, i) => ({ step: i + 1, text: `Step ${i + 1}`, completed: false }));
	}

	test("scans thinking text: markers announced only in thinking still count (regression)", () => {
		// A model once announced "Let me write the final response with [DONE:n] tags"
		// in its thinking and then never emitted them in the visible text — progress
		// tracking must therefore also cover thinking blocks. The execution path
		// concatenates text + thinking before calling markCompletedSteps.
		const items = todos(3);
		const visibleText = "Alles grün. Zusammenfassung: …";
		const thinking = "Steps 1 and 2 are verified working. Marking them: [DONE:1] [DONE:2]";
		const marked = markCompletedSteps(`${visibleText}\n${thinking}`, items);
		expect(marked).toBe(2);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(true);
		expect(items[2].completed).toBe(false);
	});

	test("does not match the [DONE:n] placeholder from the instructions", () => {
		// The injected instructions contain the literal placeholder "[DONE:n]";
		// it must never tick a step.
		const items = todos(2);
		expect(markCompletedSteps("After completing a step, include a [DONE:n] tag.", items)).toBe(0);
		expect(items.every((t) => !t.completed)).toBe(true);
	});

	test("is idempotent: re-scanning the same text keeps completion state", () => {
		const items = todos(2);
		markCompletedSteps("first part [DONE:2]", items);
		markCompletedSteps("still there [DONE:2]", items);
		expect(items[1].completed).toBe(true);
		expect(items[0].completed).toBe(false);
	});
});
