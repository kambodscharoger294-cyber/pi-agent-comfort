// Throwaway smoke test for the plan_done tool + thinking scan.
import { mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// plan files are persisted under <cwd>/.pi/plans — run from a temp dir so the
// smoke test never writes into the repo.
const tmp = path.join(os.tmpdir(), "plan-mode-smoke");
mkdirSync(tmp, { recursive: true });
process.chdir(tmp);

import planModeExtension from "../extensions/plan-mode/index.ts";

type Handler = (event: any, ctx?: any) => any;

const registered: Record<string, any> = {};
const handlers: Record<string, Handler[]> = {};
let activeTools: string[] = ["read", "bash", "edit", "write", "subagent"];

const theme = {
	fg: (_k: string, s: string) => s,
	strikethrough: (s: string) => s,
};

const pi: any = {
	registerFlag: () => {},
	registerCommand: (n: string, def: any) => (registered[`cmd:${n}`] = def),
	registerShortcut: (_k: any, def: any) => (registered.shortcut = def),
	registerTool: (def: any) => (registered.tool = def),
	on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
	appendEntry: () => {},
	getActiveTools: () => [...activeTools],
	setActiveTools: (tools: string[]) => (activeTools = tools),
	getFlag: () => false,
	sendMessage: () => {},
	sendUserMessage: () => {},
};

planModeExtension(pi);

const baseCtx: any = {
	ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {}, theme },
	hasUI: false,
	sessionManager: { getEntries: () => [] },
};

const toggle = () => (registered["cmd:plan"].handler as (a: any, c: any) => Promise<void>)(undefined, baseCtx);
const emit = async (event: string, payload: any, ctx: any) => {
	for (const h of handlers[event] ?? []) await h(payload, ctx);
};

const planMsg = {
	role: "assistant",
	content: [{ type: "text", text: "Plan:\n1. Erst tasten\n2. Dann prüfen\n3. Zum Schluss melden" }],
};

// 1. Plan mode: write tools and subagent off, plan_done never active
await toggle();
if (activeTools.includes("plan_done")) throw new Error("plan_done active in plan mode");
if (activeTools.includes("edit") || activeTools.includes("subagent")) throw new Error("plan mode leaks write access");

// 2. Execution mode via the menu: plan_done must be activated
const execCtx: any = {
	...baseCtx,
	hasUI: true,
	ui: { ...baseCtx.ui, select: async () => "Execute the plan (track progress)", editor: async () => undefined },
};
await emit("agent_end", { messages: [planMsg] }, execCtx);
if (!activeTools.includes("plan_done")) throw new Error("plan_done not activated for execution");
// note: subagent is intentionally active again during execution — it is only
// blocked in plan mode, where delegated agents would escape the restrictions.

// 3. turn_end marks steps announced only in thinking blocks
await emit("turn_end", {
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Step 1 verified. [DONE:1]" },
			{ type: "text", text: "Erster Schritt erledigt." },
		],
	},
}, baseCtx);

// 4. plan_done marks (1 already ticked via thinking scan → 2/3), is idempotent,
//    and rejects unknown steps
const tool = registered.tool;
if (!tool || tool.name !== "plan_done") throw new Error("plan_done tool not registered");
const resultText = (r: { content?: Array<{ type: string; text?: string }> }) =>
	(r.content ?? []).map((c) => c.text ?? "").join("");
const marked = await tool.execute("t1", { step: 2 }, undefined, undefined, baseCtx);
if (!resultText(marked).includes("2/3")) throw new Error(`plan_done marking failed: ${resultText(marked)}`);
const repeat = await tool.execute("t2", { step: 2 }, undefined, undefined, baseCtx);
if (!resultText(repeat).includes("2/3")) throw new Error("plan_done not idempotent");
const unknown = await tool.execute("t3", { step: 9 }, undefined, undefined, baseCtx);
if (!resultText(unknown).includes("No plan step 9")) throw new Error("unknown-step guard failed");

// 5. In normal (non-execution) mode plan_done is dropped again
await toggle();
if (activeTools.includes("plan_done")) throw new Error("plan_done active after toggle-off");

// 6. Regression: a "Plan: Titel" header with the title on the SAME line must
// still be extracted and persisted (strict "Plan:\n" regex silently dropped it)
const titledPlan = {
	role: "assistant",
	content: [
		{ type: "text", text: "Plan: Jev-Loop Prototyp\n\n1. Repo anlegen\n2. Env kapseln\n3. Loop bauen" },
	],
};
await emit("agent_end", { messages: [titledPlan] }, baseCtx);
const savedPlans = readdirSync(path.join(tmp, ".pi", "plans"));
if (!savedPlans.some((f) => f.includes("repo-anlegen"))) {
	throw new Error(`titled plan not persisted, dir contains: ${savedPlans.join(", ")}`);
}

console.log("SMOKE OK — tool activation, thinking scan, marking, guards, titled-plan persistence all intact");