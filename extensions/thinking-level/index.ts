import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	ThinkingSelectorComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const STATUS_KEY = "thinking-level";
const SHORTCUT = "ctrl+shift+t";
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const STATE_PATH = join(getAgentDir(), "extensions", "thinking-level", "state.json");

interface PersistedState {
	preferredLevel?: ThinkingLevel;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.includes(value as ThinkingLevel);
}

function loadState(): PersistedState {
	if (!existsSync(STATE_PATH)) return {};

	try {
		const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as PersistedState;
		return isThinkingLevel(parsed.preferredLevel) ? parsed : {};
	} catch {
		return {};
	}
}

function saveState(state: PersistedState): void {
	mkdirSync(join(getAgentDir(), "extensions", "thinking-level"), { recursive: true });
	const tempPath = `${STATE_PATH}.tmp`;
	writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n", "utf8");
	renameSync(tempPath, STATE_PATH);
}

export default function thinkingLevelExtension(pi: ExtensionAPI) {
	let preferredLevel: ThinkingLevel | undefined;

	function clearStatus(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	async function openPicker(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Thinking level picker requires interactive UI", "warning");
			return;
		}

		const selected = await ctx.ui.custom<ThinkingLevel | null>((tui, _theme, _kb, done) => {
			const selector = new ThinkingSelectorComponent(pi.getThinkingLevel(), LEVELS, (level) => done(level), () => done(null));

			return {
				render(width: number) {
					return selector.render(width);
				},
				invalidate() {
					selector.invalidate();
				},
				handleInput(data: string) {
					selector.getSelectList().handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;

		// Persist the user's preferred level, but let pi report the effective level
		// through thinking_level_select so model capability clamping is reflected in UI.
		preferredLevel = selected;
		saveState({ preferredLevel });
		pi.setThinkingLevel(selected);
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Open thinking level selector",
		handler: openPicker,
	});

	pi.on("session_start", async (_event, ctx) => {
		preferredLevel = loadState().preferredLevel;
		if (preferredLevel) {
			pi.setThinkingLevel(preferredLevel);
		}
		clearStatus(ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		clearStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		clearStatus(ctx);
	});
}
