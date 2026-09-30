/**
 * one-line – collapses ALL tool blocks to exactly one line.
 *
 * Collapsed: EXACTLY ONE line per tool, e.g.
 *   "$ <command>  ✓ Took 0.3s [truncated]"
 *   "edit <path>  ✓ +3 −1 Took 0.2s"
 *   "read <path>  ✓ 42 lines Took 0.1s"
 *
 * Expanded (ctrl+o or click in fullscreen) and while the tool is running:
 * pi's standard rendering, unchanged (the original renderer is passed through).
 *
 * Rendering only – tool behaviour and execution stay entirely the built-ins.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

interface RenderState {
	startedAt?: number;
	endedAt?: number;
}

interface DetailsWithNotes {
	truncation?: { truncated?: boolean };
	fullOutputPath?: string;
}

function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const c = result.content.find((c) => c.type === "text");
	return c && typeof c.text === "string" ? c.text : "";
}

/** Kompakte Status-Spalte: ✓/✗ + Took Xs + optionale Hinweise */
function buildStatus(
	result: { isError?: boolean },
	theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2],
	context: { state: RenderState },
): { status: string; statusPlain: string } {
	context.state.endedAt ??= Date.now();
	const isError = Boolean(result.isError);

	let status: string;
	let statusPlain: string;
	if (context.state.startedAt !== undefined) {
		const dur = ((context.state.endedAt - context.state.startedAt) / 1000).toFixed(1);
		statusPlain = `${isError ? "✗" : "✓"} Took ${dur}s`;
		status = theme.fg(isError ? "error" : "success", isError ? "✗" : "✓");
		status += theme.fg("muted", ` Took ${dur}s`);
	} else {
		statusPlain = isError ? "✗ Fehler" : "✓";
		status = theme.fg(isError ? "error" : "success", isError ? "✗ Fehler" : "✓");
	}

	// Keep the important notices (truncation / full output) visible
	const details = (result as { details?: DetailsWithNotes }).details;
	const notes: string[] = [];
	if (details?.truncation?.truncated) notes.push("truncated");
	if (details?.fullOutputPath) notes.push("full output in file");
	if (notes.length > 0) {
		statusPlain += ` [${notes.join(", ")}]`;
		status += theme.fg("warning", ` [${notes.join(", ")}]`);
	}

	return { status, statusPlain };
}

/** One-line component: label (truncated) left, status right */
function oneLine(theme: Parameters<NonNullable<ToolDefinition["renderResult"]>>[2], label: string, status: string) {
	return {
		invalidate() {},
		render(width: number): string[] {
			const budget = Math.max(10, width - visibleWidth(status) - 4);
			const labelStr = truncateToWidth(label, budget);
			const line = theme.fg("accent", labelStr) + "  " + status;
			return [truncateToWidth(line, width)];
		},
	};
}

const emptyComponent = () => ({
	invalidate() {},
	render: () => [] as string[],
});

function passthroughCall(original: ToolDefinition, args: unknown, theme: unknown, context: unknown) {
	if (original.renderCall) return original.renderCall(args as never, theme as never, context as never);
	return emptyComponent();
}

function passthroughResult(
	original: ToolDefinition,
	result: unknown,
	options: { isPartial: boolean; expanded: boolean },
	theme: unknown,
	context: unknown,
) {
	if (original.renderResult) return original.renderResult(result as never, options as never, theme as never, context as never);
	return emptyComponent();
}

export default function (pi: ExtensionAPI) {
	// ------------------------------------------------------------------- Bash
	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bash.description,
		parameters: bash.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(bash, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(bash, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);
			const cmd = ((context.args as { command?: string })?.command ?? "").replaceAll("\n", " ").trim();
			return oneLine(theme, `$ ${cmd}`, status);
		},
	});

	// ------------------------------------------------------------------- Edit
	const edit = createEditToolDefinition(process.cwd());
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: edit.description,
		parameters: edit.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return edit.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(edit, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(edit, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);

			// Diff statistics (+A/−D) counted from the display diff
			const isError = Boolean(result.isError);
			let extra = "";
			const details = (result as { details?: { diff?: string } }).details;
			if (!isError && details?.diff) {
				let add = 0;
				let del = 0;
				for (const l of details.diff.split("\n")) {
					if (l.startsWith("+++") || l.startsWith("---")) continue;
					if (l.startsWith("+")) add++;
					else if (l.startsWith("-")) del++;
				}
				if (add > 0 || del > 0) {
					extra = theme.fg("success", ` +${add}`) + theme.fg("error", ` −${del}`);
				}
			}

			const args = context.args as { path?: string; edits?: unknown[] };
			let label = `edit ${shortenPath(args?.path ?? "")}`;
			if ((args?.edits?.length ?? 0) > 1) label += ` (+${args!.edits!.length - 1} edits)`;
			return oneLine(theme, label, extra + status);
		},
	});

	// ------------------------------------------------------------------ Write
	const write = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		name: "write",
		label: "write",
		description: write.description,
		parameters: write.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return write.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(write, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(write, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);

			const args = context.args as { path?: string; content?: string };
			const isError = Boolean(result.isError);
			let linesStyled = "";
			if (!isError && args?.content !== undefined) {
				const lines = args.content.split("\n").length;
				linesStyled = theme.fg("muted", `${lines} Zeilen `);
			}
			const label = `write ${shortenPath(args?.path ?? "")}`;
			return oneLine(theme, label, linesStyled + status);
		},
	});

	// ------------------------------------------------------------------- Read
	const read = createReadToolDefinition(process.cwd());
	pi.registerTool({
		name: "read",
		label: "read",
		description: read.description,
		parameters: read.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return read.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(read, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(read, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);

			const args = context.args as { path?: string };
			const isError = Boolean(result.isError);
			const content = result.content[0];
			let extra = "";
			if (!isError) {
				if (content?.type === "image") {
					extra = theme.fg("muted", "Bild ");
				} else {
					const text = firstText(result);
					const lines = text ? text.split("\n").length : 0;
					extra = theme.fg("muted", `${lines} Zeilen `);
				}
			}
			return oneLine(theme, `read ${shortenPath(args?.path ?? "")}`, extra + status);
		},
	});

	// ------------------------------------------------------------- find/grep/ls
	const find = createFindToolDefinition(process.cwd());
	pi.registerTool({
		name: "find",
		label: "find",
		description: find.description,
		parameters: find.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return find.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(find, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(find, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);
			const args = context.args as { pattern?: string; path?: string };
			const count = firstText(result).trim().split("\n").filter(Boolean).length;
			const extra = theme.fg("muted", `${count} Treffer `);
			return oneLine(theme, `find ${args?.pattern ?? ""}${args?.path ? ` in ${shortenPath(args.path)}` : ""}`, extra + status);
		},
	});

	const grep = createGrepToolDefinition(process.cwd());
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: grep.description,
		parameters: grep.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return grep.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(grep, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(grep, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);
			const args = context.args as { pattern?: string };
			const count = firstText(result).trim().split("\n").filter(Boolean).length;
			const extra = theme.fg("muted", `${count} Treffer `);
			return oneLine(theme, `grep /${args?.pattern ?? ""}/`, extra + status);
		},
	});

	const ls = createLsToolDefinition(process.cwd());
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: ls.description,
		parameters: ls.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return ls.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.isPartial || context.expanded) return passthroughCall(ls, args, theme, context);
			return emptyComponent();
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial || options.expanded) return passthroughResult(ls, result, options, theme, context);
			const { status } = buildStatus(result, theme, context);
			const args = context.args as { path?: string };
			const count = firstText(result).trim().split("\n").filter(Boolean).length;
			const extra = theme.fg("muted", `${count} entries `);
			return oneLine(theme, `ls ${shortenPath(args?.path ?? ".")}`, extra + status);
		},
	});
}
