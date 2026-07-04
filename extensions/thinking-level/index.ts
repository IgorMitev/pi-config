import { readFileSync } from "node:fs";
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
const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.includes(value as ThinkingLevel);
}

function loadDefaultThinkingLevel(): ThinkingLevel | undefined {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { defaultThinkingLevel?: unknown };
		return isThinkingLevel(parsed.defaultThinkingLevel) ? parsed.defaultThinkingLevel : undefined;
	} catch {
		return undefined;
	}
}

export default function thinkingLevelExtension(pi: ExtensionAPI) {

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

		pi.setThinkingLevel(selected);
	}

	pi.registerShortcut(SHORTCUT, {
		description: "Open thinking level selector",
		handler: openPicker,
	});

	pi.on("session_start", async (_event, ctx) => {
		const defaultThinkingLevel = loadDefaultThinkingLevel();
		if (defaultThinkingLevel) {
			pi.setThinkingLevel(defaultThinkingLevel);
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
