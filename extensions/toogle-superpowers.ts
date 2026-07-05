// toogle-superpowers — a gated fork of obra/superpowers' pi extension.
//
// Upstream: https://github.com/obra/superpowers/blob/main/.pi/extensions/superpowers.ts
//
// Differences to upstream:
// - Adds an internal `superpowersEnabled` flag (default: false).
// - Skills are only contributed to `resources_discover` while the flag is true,
//   so pi cannot see or load the superpowers skills before activation.
// - The using-superpowers bootstrap injection is guarded by the same flag.
// - Registers a `/superpowers` command that clones obra/superpowers on first
//   use (into ~/.pi/agent/toogle-superpowers/superpowers), enables the flag,
//   persists that decision into the session, and reloads resources so the
//   skills get discovered.
// - There is deliberately no off-switch: the flag persists for the lifetime
//   of the session (it survives /reload and /resume via a session entry) and
//   resets to false only when a new session starts (/new).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "toogle-superpowers";
const SUPERPOWERS_REPO_URL = "https://github.com/obra/superpowers.git";
const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";

const cloneDir = join(getAgentDir(), "toogle-superpowers", "superpowers");
const skillsDir = join(cloneDir, "skills");
const bootstrapSkillPath = join(skillsDir, "using-superpowers", "SKILL.md");

let cachedBootstrap: string | undefined;

export default function toogleSuperpowersExtension(pi: ExtensionAPI) {
	/**
	 * Master switch. Default: false — pi must neither see the superpowers
	 * skills nor receive the bootstrap until /superpowers has been run in
	 * this session. Reconstructed from session entries on session_start, so
	 * /new (empty session) resets it to false while /resume restores it.
	 */
	let superpowersEnabled = false;
	/** Upstream behavior: inject only on the first agent run after session start / compaction. */
	let injectBootstrap = true;

	// --- state restore ------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		superpowersEnabled = readEnabledFromSession(ctx);
		injectBootstrap = true;
		updateStatus(ctx);
	});

	// --- skill discovery (guarded) -------------------------------------------

	pi.on("resources_discover", async () => {
		if (!superpowersEnabled) return; // before activation pi must not see the skills
		if (!existsSync(skillsDir)) return;
		return { skillPaths: [skillsDir] };
	});

	// --- bootstrap injection (upstream logic, guarded by the flag) -----------

	pi.on("session_compact", async () => {
		injectBootstrap = true;
	});

	pi.on("agent_end", async () => {
		injectBootstrap = false;
	});

	pi.on("context", async (event) => {
		if (!superpowersEnabled) return; // bootstrap only when /superpowers was run
		if (!injectBootstrap) return;
		if (event.messages.some(messageContainsBootstrap)) return;

		const bootstrap = getBootstrapContent();
		if (!bootstrap) return;

		const bootstrapMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: bootstrap }],
			timestamp: Date.now(),
		};

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				bootstrapMessage,
				...event.messages.slice(insertAt),
			],
		};
	});

	// --- /superpowers ---------------------------------------------------------

	pi.registerCommand("superpowers", {
		description:
			"Enable superpowers skills + bootstrap for this session (resets with /new)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "update", label: "update — git pull the superpowers clone" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const arg = (args ?? "").trim();
			if (arg === "update") {
				await updateClone(ctx);
				return;
			}

			if (superpowersEnabled) {
				notify(
					ctx,
					"Superpowers are already enabled for this session. Start a new session (/new) to reset.",
					"info",
				);
				return;
			}

			if (!(await ensureClone(ctx))) return;

			superpowersEnabled = true;
			injectBootstrap = true;
			// Persist into the session: survives /reload and /resume; a fresh
			// session (/new) has no such entry, so the default (false) applies.
			pi.appendEntry(CUSTOM_TYPE, { enabled: true, enabledAt: Date.now() });
			updateStatus(ctx);
			notify(ctx, "Superpowers enabled — discovering skills…", "info");

			// Re-run resource discovery so the skills become visible. The reload
			// re-instantiates this extension; session_start then restores the
			// flag from the entry appended above.
			await ctx.reload();
			return;
		},
	});

	// --- helpers --------------------------------------------------------------

	async function ensureClone(ctx: ExtensionCommandContext): Promise<boolean> {
		if (existsSync(join(cloneDir, ".git"))) return true;

		notify(ctx, `Cloning ${SUPERPOWERS_REPO_URL} …`, "info");
		try {
			mkdirSync(dirname(cloneDir), { recursive: true });
			const result = await pi.exec(
				"git",
				["clone", "--depth", "1", SUPERPOWERS_REPO_URL, cloneDir],
				{ timeout: 180_000 },
			);
			if (result.code !== 0) {
				notify(ctx, `git clone failed: ${truncate(result.stderr)}`, "error");
				return false;
			}
		} catch (error) {
			notify(ctx, `git clone failed: ${String(error)}`, "error");
			return false;
		}

		if (!existsSync(bootstrapSkillPath)) {
			notify(
				ctx,
				"Clone succeeded but skills/using-superpowers/SKILL.md is missing — upstream layout may have changed.",
				"warning",
			);
		}
		return true;
	}

	async function updateClone(ctx: ExtensionCommandContext): Promise<void> {
		if (!existsSync(join(cloneDir, ".git"))) {
			if (await ensureClone(ctx)) {
				notify(ctx, "Superpowers clone created.", "info");
			}
			return;
		}

		try {
			const result = await pi.exec("git", ["-C", cloneDir, "pull", "--ff-only"], {
				timeout: 180_000,
			});
			if (result.code !== 0) {
				notify(ctx, `git pull failed: ${truncate(result.stderr)}`, "error");
				return;
			}
			cachedBootstrap = undefined; // re-read SKILL.md on next injection
			notify(ctx, `Superpowers updated: ${truncate(result.stdout.trim())}`, "info");
			if (superpowersEnabled) {
				await ctx.reload(); // refresh discovered skill metadata
			}
		} catch (error) {
			notify(ctx, `git pull failed: ${String(error)}`, "error");
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(CUSTOM_TYPE, superpowersEnabled ? "⚡ superpowers" : undefined);
	}
}

// --- module-level helpers (fork of upstream) ---------------------------------

function readEnabledFromSession(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data as { enabled?: boolean } | undefined;
			if (data?.enabled === true) return true;
		}
	}
	return false;
}

function notify(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function truncate(text: string, max = 300): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function getBootstrapContent(): string | null {
	if (cachedBootstrap !== undefined) return cachedBootstrap;

	try {
		const skillContent = readFileSync(bootstrapSkillPath, "utf8");
		const body = stripFrontmatter(skillContent);
		cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

${piToolMapping()}
</EXTREMELY_IMPORTANT>`;
		return cachedBootstrap;
	} catch {
		// Do not cache failure: the clone may appear later in the session.
		return null;
	}
}

function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function piToolMapping(): string {
	return `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant \`SKILL.md\` with \`read\` when the skill applies, or let a human invoke \`/skill:name\` explicitly.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi does not ship a standard subagent tool. If a subagent tool such as \`subagent\` from \`pi-subagents\` is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.

Pi does not ship a standard task-list tool. If an installed todo/task tool is available, use it. Otherwise track work in plan files or a repo-local \`TODO.md\` when task tracking is needed. Treat older \`TodoWrite\` references as this task-tracking action.`;
}

function messageContainsBootstrap(message: unknown): boolean {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		return (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(BOOTSTRAP_MARKER)
		);
	});
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}
