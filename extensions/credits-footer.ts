/**
 * credits-footer – replaces the footer and shows the remaining credit
 * balance next to the session cost: $0.123/$10.75
 *
 * Written for OpenRouter (endpoint /api/v1/credits) because that is what
 * reports a remaining balance. Any OpenAI-compatible gateway exposing the same
 * response shape can be used through the env vars below.
 *
 *   PI_CREDITS_KEYCHAIN_SERVICE  keychain service name (default pi-openrouter)
 *   PI_CREDITS_KEYCHAIN_ACCOUNT  keychain account    (default $USER)
 *   PI_CREDITS_API_URL           credits endpoint
 *                                (default https://openrouter.ai/api/v1/credits)
 *   PI_CREDITS_API_KEY_ENV       env var holding the key, if the gateway uses one
 *                                (default OPENROUTER_API_KEY)
 *
 * Key resolution: keychain (macOS) → env var. The key is never printed.
 * Refresh: on start, after every agent response (at most every 60 s), and every
 * 5 minutes. /credits forces a refresh.
 *
 * Without a key or a reachable endpoint the balance shows as `--.--` and
 * everything else keeps working.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { relative, resolve, isAbsolute, sep } from "node:path";

const execFileP = promisify(execFile);

const REFRESH_MIN_MS = 60_000;

const KEYCHAIN_SERVICE = process.env.PI_CREDITS_KEYCHAIN_SERVICE || "pi-openrouter";
const KEYCHAIN_ACCOUNT = process.env.PI_CREDITS_KEYCHAIN_ACCOUNT || process.env.USER || "pi";
const CREDITS_URL = process.env.PI_CREDITS_API_URL || "https://openrouter.ai/api/v1/credits";
const API_KEY_ENV = process.env.PI_CREDITS_API_KEY_ENV || "OPENROUTER_API_KEY";

async function getApiKey(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileP("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-w",
		]);
		const key = stdout.trim();
		if (key) return key;
	} catch {
		// Fallback unten
	}
	return process.env[API_KEY_ENV];
}

// ---------------------------------------------------------------------------
// OpenRouter balance
// ---------------------------------------------------------------------------

let balance: number | null = null;
let balanceState: "loading" | "ok" | "error" = "loading";
let lastFetch = 0;
let inFlight = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function fetchBalance(): Promise<number | null> {
	const key = await getApiKey();
	if (!key) return null;
	const res = await fetch(CREDITS_URL, {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) return null;
	const json: unknown = await res.json();
	const data = (json as { data?: { total_credits?: number; total_usage?: number } }).data;
	if (typeof data?.total_credits === "number" && typeof data?.total_usage === "number") {
		return data.total_credits - data.total_usage;
	}
	return null;
}

async function refreshBalance(tui?: { requestRender(): void }, force = false): Promise<void> {
	if (inFlight) return;
	if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return;
	inFlight = true;
	lastFetch = Date.now();
	try {
		const b = await fetchBalance();
		balanceState = b === null ? "error" : "ok";
		balance = b;
	} catch {
		balanceState = "error";
	} finally {
		inFlight = false;
		tui?.requestRender();
	}
}

function formatBalance(): string {
	if (balanceState === "ok" && balance !== null) return `$${balance.toFixed(2)}`;
	if (balanceState === "loading") return `$…`;
	return `$--.--`;
}

// ---------------------------------------------------------------------------
// Footer helpers (mirrors the built-in FooterComponent)
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatCwdForFooter(cwd: string, home: string): string {
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let currentTui: { requestRender(): void } | undefined;

	const apply = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			currentTui = tui;
			return {
				invalidate() {},
				dispose() {
					currentTui = undefined;
				},
				render(width: number): string[] {
					// --- usage totals over all session entries ---
					let input = 0,
						output = 0,
						cacheRead = 0,
						cacheWrite = 0,
						cost = 0;
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "usage") {
							const u = (entry as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }).usage;
							input += u?.input ?? 0;
							output += u?.output ?? 0;
							cacheRead += u?.cacheRead ?? 0;
							cacheWrite += u?.cacheWrite ?? 0;
							cost += u?.cost?.total ?? 0;
						} else if (entry.type === "message" && entry.message.role === "assistant") {
							const u = entry.message.usage;
							input += u?.input ?? 0;
							output += u?.output ?? 0;
							cacheRead += u?.cacheRead ?? 0;
							cacheWrite += u?.cacheWrite ?? 0;
							cost += u?.cost?.total ?? 0;
							const promptTokens = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
							if (promptTokens > 0) {
								latestCacheHitRate = ((u?.cacheRead ?? 0) / promptTokens) * 100;
							}
						} else if (entry.type === "message" && entry.message.role === "toolResult") {
							const u = (entry.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }).usage;
							input += u?.input ?? 0;
							output += u?.output ?? 0;
							cacheRead += u?.cacheRead ?? 0;
							cacheWrite += u?.cacheWrite ?? 0;
							cost += u?.cost?.total ?? 0;
						} else if ((entry.type === "branch_summary" || entry.type === "compaction")) {
							const u = (entry as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }).usage;
							input += u?.input ?? 0;
							output += u?.output ?? 0;
							cacheRead += u?.cacheRead ?? 0;
							cacheWrite += u?.cacheWrite ?? 0;
							cost += u?.cost?.total ?? 0;
						}
					}

					// --- context usage ---
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== undefined && contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					// --- left: pwd + branch + session name ---
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE || "");
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					// --- stats line ---
					const statsParts: string[] = [];
					if (input) statsParts.push(`↑${formatTokens(input)}`);
					if (output) statsParts.push(`↓${formatTokens(output)}`);
					if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					if (cost || balance !== null) {
						// Session cost + remaining credit: $0.123/$10.75
						statsParts.push(`$${cost.toFixed(3)}/${formatBalance()}`);
					}

					const autoIndicator = " (auto)";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
					if (contextPercentValue > 90) {
						statsParts.push(theme.fg("error", contextPercentDisplay));
					} else if (contextPercentValue > 70) {
						statsParts.push(theme.fg("warning", contextPercentDisplay));
					} else {
						statsParts.push(contextPercentDisplay);
					}

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// --- right: model + thinking level (+ provider if several) ---
					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = ctx.thinkingLevel || "off";
						rightSideWithoutProvider = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}
					let rightSide = rightSideWithoutProvider;
					const minPadding = 2;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth)) + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					// --- extension statuses ---
					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const sortedStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		apply(ctx);
		void refreshBalance(undefined, true);
		// Intervall nur EINMAL anlegen (session_start feuert bei jedem /new, /resume …)
		if (!refreshTimer) {
			refreshTimer = setInterval(() => void refreshBalance(currentTui), 5 * 60_000);
			refreshTimer.unref?.();
		}
	});

	pi.on("agent_end", async () => {
		void refreshBalance(currentTui);
	});

	// Manuelles Refresh mit Notify
	pi.registerCommand("credits", {
		description: "Refresh the credit balance now",
		handler: async (_args, ctx) => {
			await refreshBalance(currentTui, true);
			if (balanceState === "ok" && balance !== null) {
				ctx.ui.notify(`Credit balance: $${balance.toFixed(2)} available`, "info");
			} else {
				ctx.ui.notify(`Credit balance not available (${CREDITS_URL})`, "warning");
			}
		},
	});
}
