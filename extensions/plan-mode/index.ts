/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "subagent"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
	currentPlanFile?: string;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let toolsBeforePlanMode: string[] | undefined;
	let currentPlanFile: string | undefined;
	let lastPlanText: string | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			if (currentPlanFile) {
				lines.push(ctx.ui.theme.fg("muted", `💾 ${currentPlanFile}`));
			}
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
			currentPlanFile,
		});
	}

	// --- Auto-persist plans to markdown files (extension writes, agent stays read-only) ---

	function slugify(text: string): string {
		const slug = text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40);
		return slug || "plan";
	}

	function getPlansDir(): string {
		const cwd = process.cwd();
		if (cwd === os.homedir()) {
			return path.join(os.homedir(), ".pi", "agent", "plans");
		}
		return path.join(cwd, ".pi", "plans");
	}

	function planSectionText(message: string): string {
		const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
		if (!headerMatch) return "";
		return message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length).trim();
	}

	function persistPlanFile(planText: string, todos: TodoItem[], isNewPlan: boolean): string | undefined {
		if (todos.length === 0) return currentPlanFile;
		if (isNewPlan || currentPlanFile === undefined) {
			const first = todos[0];
			if (!first) return currentPlanFile;
			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
			currentPlanFile = path.join(getPlansDir(), `plan-${stamp}-${slugify(first.text)}.md`);
		}
		mkdirSync(path.dirname(currentPlanFile), { recursive: true });
		const progress = todos.map((t) => `- [${t.completed ? "x" : " "}] ${t.step}. ${t.text}`).join("\n");
		const section = planSectionText(planText);
		const content = `# Plan: ${todos[0].text}\n\n_Gespeichert: ${new Date().toISOString()}\nDatei: ${currentPlanFile}_\n\n${section ? `${section}\n\n` : ""}## Progress\n\n${progress}\n`;
		writeFileSync(currentPlanFile, content, "utf-8");
		return currentPlanFile;
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Built-in write tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- The subagent tool is disabled - delegated agents would run outside these restrictions
- Bash is restricted to an allowlist of read-only commands (ls, cat, head/tail, grep, rg, fd, find, git status/log/diff/branch, npm list, uname, date, …). Read-only subcommands of a local memory CLI (mnemon recall/search/status/log/related/store list) are allowed too, if one is installed.

If something is unclear, ask clarifying questions directly in your response.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.
Plans are saved automatically to .pi/plans/plan-*.md - do not try to write files yourself.
Do not modify persistent state while in plan mode (memory files, config, indexes) - defer that until plan mode is off.
Do not use the subagent tool while in plan mode.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			// Keep the persisted plan file's progress section in sync
			if (currentPlanFile) {
				persistPlanFile(lastPlanText ?? "", todoItems, false);
			}
		}
		persistState();
	});

	// Show plan steps and the action menu (used by agent_end and /plan-next)
	async function showPlanMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (executionMode) {
			ctx.ui.notify("Plan execution in progress - /todos shows progress.", "info");
			return;
		}
		if (todoItems.length === 0) {
			ctx.ui.notify("No plan yet. Ask me to create one - responses with a Plan: header set it up.", "info");
			return;
		}
		persistState();

		const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
		const planFileLine = currentPlanFile ? `\n\n💾 Plan gespeichert: \`${currentPlanFile}\`` : "";
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}${planFileLine}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
After completing a step, include a [DONE:n] tag in your response.`;
			pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	}

	pi.registerCommand("plan-next", {
		description: "Re-show plan steps and the action menu",
		handler: async (_args, ctx) => showPlanMenu(ctx),
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		let startNewPlanFile = false;
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			// A fresh Plan: header means a topic change - abandon the running execution
			const lastMsg = [...event.messages].reverse().find(isAssistantMessage);
			const freshPlan = lastMsg ? extractTodoItems(getTextContent(lastMsg)) : [];
			if (freshPlan.length === 0) {
				if (todoItems.every((t) => t.completed)) {
					const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
					pi.sendMessage(
						{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
						{ triggerTurn: false },
					);
					// Final sync of the plan file before clearing state
					if (currentPlanFile) {
						persistPlanFile(lastPlanText ?? "", todoItems, false);
					}
					currentPlanFile = undefined;
					lastPlanText = undefined;
					executionMode = false;
					todoItems = [];
					updateStatus(ctx);
					persistState(); // Save cleared state so resume doesn't restore old execution mode
				}
				return;
			}
			// Switch to the new plan and show the action menu
			executionMode = false;
			planModeEnabled = true;
			enablePlanModeTools();
			todoItems = freshPlan;
			startNewPlanFile = true;
			updateStatus(ctx);
			persistState();
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Extract todos from last assistant message
		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const planText = getTextContent(lastAssistant);
			const extracted = extractTodoItems(planText);
			if (extracted.length > 0) {
				const isNewPlan = startNewPlanFile || todoItems.length === 0;
				todoItems = extracted;
				lastPlanText = planText;
				persistPlanFile(planText, todoItems, isNewPlan);
			} else {
				// No plan in the last response: drop stale todos so the
				// "what next?" dialog never shows an outdated plan
				todoItems = [];
				currentPlanFile = undefined;
				lastPlanText = undefined;
			}
		}
		startNewPlanFile = false;

		if (todoItems.length === 0) return;
		await showPlanMenu(ctx);
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
			currentPlanFile = planModeEntry.data.currentPlanFile ?? currentPlanFile;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
