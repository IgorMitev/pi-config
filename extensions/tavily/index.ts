import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, execFile } from "node:child_process";

const HEARTBEAT_MS = 10_000;

function enumType(values: string[], description: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description });
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function parseJson(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function runTvly(args: string[], signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tvly", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let closed = false;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      closed = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `tvly exited with code ${code}`));
        return;
      }

      try {
        resolve(parseJson(stdout));
      } catch {
        reject(new Error(`Failed to parse tvly JSON output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error("tvly CLI not found. Install it with: curl -fsSL https://cli.tavily.com/install.sh | bash"));
        return;
      }
      reject(error);
    });

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!closed) proc.kill("SIGKILL");
        }, 3000);
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
}

function normalizeHttpUrls(input: any): string[] {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0) throw new Error("At least one URL is required");
  if (values.length > 20) throw new Error("Tavily extract supports at most 20 URLs per call");

  return values.map((value) => {
    if (typeof value !== "string") throw new Error("Each URL must be a string");
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http:// and https:// URLs are supported");
    }
    return parsed.href;
  });
}

function runTvlyWithHeartbeat(
  args: string[],
  signal: AbortSignal | undefined,
  onUpdate: any,
  startTime: number,
  message: () => string,
): Promise<any> {
  const timer = setInterval(() => {
    onUpdate?.({
      content: [{ type: "text" as const, text: message() }],
      details: { status: "running", elapsed: Math.round((Date.now() - startTime) / 1000) },
    });
  }, HEARTBEAT_MS);

  return runTvly(args, signal).finally(() => clearInterval(timer));
}

function textFromSearchResult(result: any, maxResults: number): string {
  const results = Array.isArray(result.results) ? result.results : [];
  const answer = result.answer ? `## Answer\n\n${result.answer}\n\n` : "";
  const items = results.slice(0, maxResults).map((item: any, index: number) => {
    const title = item.title ?? item.url ?? "Untitled";
    const url = item.url ?? "";
    const content = item.content ?? item.raw_content ?? "";
    return `${index + 1}. **${title}**\n   ${url}\n   ${String(content).slice(0, 500)}`;
  });

  return `${answer}Found ${results.length} result${results.length === 1 ? "" : "s"}.\n\n${items.join("\n\n")}`.trim();
}

function textFromExtractResult(result: any): string {
  const results = Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) return "No content extracted";

  return results.map((item: any) => {
    const title = item.title ?? item.url ?? "Untitled";
    const url = item.url ? `\n${item.url}` : "";
    const content = item.raw_content ?? item.content ?? "";
    return `## ${title}${url}\n\n${content}`.trim();
  }).join("\n\n---\n\n");
}

function modelForSpeed(speed: string | undefined): string {
  if (speed === "best") return "pro";
  if (speed === "balanced") return "auto";
  return "mini";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the public web using Tavily's AI-optimized search engine. Defaults to a balanced search: basic depth and 5 results. Returns ranked results with titles, URLs, snippets, and optionally an AI-generated answer or raw page content.",
    promptSnippet: "Search the public web using Tavily. Defaults to basic depth and 5 results for balanced cost/quality.",
    promptGuidelines: [
      "Call this tool directly as web_search({...}) — do NOT route through mcp().",
      "Use this for web discovery when you do not already have a specific URL.",
      "Default behavior is searchDepth=basic and maxResults=5; use that for normal searches.",
      "Use searchDepth=ultra-fast and maxResults=3 only when the user explicitly asks for the cheapest option or rough discovery is enough.",
      "Use searchDepth=advanced when the first search fails, the answer is time-sensitive, or exact facts matter (scores, releases, prices, legal/policy information).",
      "Use web_fetch when you already have specific public article/docs URLs and need readable extracted markdown/text.",
      "Use bash/curl instead of web_fetch for raw files, JSON/API endpoints, localhost/private URLs, GitHub raw URLs, and cases where exact raw bytes matter.",
      "Use deep_research for broader synthesis questions that need a cited report.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query." }),
      maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return, from 0 to 20. Defaults to 5." })),
      topic: Type.Optional(enumType(["general", "news", "finance"], "Optimize search for a specific topic.")),
      searchDepth: Type.Optional(enumType(["ultra-fast", "fast", "basic", "advanced"], "Search depth. Higher depth returns more detailed results.")),
      timeRange: Type.Optional(enumType(["day", "week", "month", "year"], "Filter results to a relative time window.")),
      afterDate: Type.Optional(Type.String({ description: "Only include results published after this date, in YYYY-MM-DD format." })),
      beforeDate: Type.Optional(Type.String({ description: "Only include results published before this date, in YYYY-MM-DD format." })),
      includeAnswer: Type.Optional(enumType(["basic", "advanced"], "Include a Tavily-generated answer with results.")),
      includeRawContent: Type.Optional(enumType(["markdown", "text"], "Include full page content for each result.")),
      includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Restrict results to these domains." })),
      excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains." })),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      try {
        const maxResults = Math.min(Math.max(Number(params.maxResults ?? 5), 0), 20);
        const searchDepth = params.searchDepth ?? "basic";
        const args = ["search", "--max-results", String(maxResults), "--depth", searchDepth, "--json"];
        if (params.topic) args.push("--topic", params.topic);
        if (params.timeRange) args.push("--time-range", params.timeRange);
        if (params.afterDate) args.push("--start-date", params.afterDate);
        if (params.beforeDate) args.push("--end-date", params.beforeDate);
        if (params.includeAnswer) args.push("--include-answer", params.includeAnswer);
        if (params.includeRawContent) args.push("--include-raw-content", params.includeRawContent);
        if (Array.isArray(params.includeDomains) && params.includeDomains.length > 0) args.push("--include-domains", params.includeDomains.join(","));
        if (Array.isArray(params.excludeDomains) && params.excludeDomains.length > 0) args.push("--exclude-domains", params.excludeDomains.join(","));
        args.push("--", params.query);

        const startTime = Date.now();
        onUpdate?.({
          content: [{ type: "text" as const, text: `🔎 Tavily search started · ${params.query}` }],
          details: { status: "running", query: params.query, maxResults },
        });

        const result = await runTvlyWithHeartbeat(args, signal, onUpdate, startTime, () => `🔎 Searching with Tavily · ${formatElapsed(startTime)}`);
        return {
          content: [{ type: "text" as const, text: textFromSearchResult(result, maxResults) }],
          details: result,
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: error.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch and extract clean readable content from one or more public URLs using Tavily Extract. Handles normal pages and can use advanced extraction for JavaScript-rendered pages.",
    promptSnippet: "Fetch readable content from known public URLs using Tavily Extract.",
    promptGuidelines: [
      "Call this tool directly as web_fetch({...}) — do NOT route through mcp().",
      "Use this when you have specific public article/docs URLs and need readable extracted markdown/text.",
      "Use bash/curl instead for raw files, JSON/API endpoints, localhost/private URLs, GitHub raw URLs, and cases where exact raw bytes matter.",
      "Use web_search first when you need to discover relevant URLs.",
    ],
    parameters: Type.Object({
      url: Type.Any({ description: "One public URL or an array of public URLs. Tavily supports up to 20 URLs per extract call." }),
      objective: Type.Optional(Type.String({ description: "Optional focus query used to rerank extracted chunks by relevance." })),
      chunksPerSource: Type.Optional(Type.Number({ description: "Number of content chunks per URL when objective is provided, from 1 to 5." })),
      extractDepth: Type.Optional(enumType(["basic", "advanced"], "Extraction depth. Advanced handles JavaScript-rendered pages.")),
      format: Type.Optional(enumType(["markdown", "text"], "Output format. Defaults to markdown.")),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      try {
        const urls = normalizeHttpUrls(params.url);
        const args = ["extract", "--json"];
        if (params.objective) args.push("--query", params.objective);
        if (params.chunksPerSource) args.push("--chunks-per-source", String(params.chunksPerSource));
        if (params.extractDepth) args.push("--extract-depth", params.extractDepth);
        if (params.format) args.push("--format", params.format);
        args.push("--", ...urls);

        const startTime = Date.now();
        onUpdate?.({
          content: [{ type: "text" as const, text: `📄 Tavily extract started · ${urls.length} URL${urls.length === 1 ? "" : "s"}` }],
          details: { status: "running", urls, objective: params.objective },
        });

        const result = await runTvlyWithHeartbeat(args, signal, onUpdate, startTime, () => `📄 Extracting with Tavily · ${formatElapsed(startTime)}`);
        return {
          content: [{ type: "text" as const, text: textFromExtractResult(result) }],
          details: result,
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: error.message }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description: "Run Tavily deep research on a topic. Tavily searches the web, synthesizes sources, and produces a cited report. This replaces Parallel.ai deep research for broad synthesis tasks, though output shape and model controls differ.",
    promptSnippet: "Run Tavily deep research for broad synthesis questions that need a cited report.",
    promptGuidelines: [
      "Call this tool directly as deep_research({...}) — do NOT route through mcp().",
      "Use for broad research, comparisons, current-state reports, and synthesis across sources.",
      "Use web_search instead for quick lookups or finding specific pages.",
      "Use web_fetch for specific public article/docs URLs that need readable extracted content; use bash/curl for raw/API/local/private URLs.",
      "speed=fast maps to Tavily mini, balanced maps to auto, and best maps to pro.",
    ],
    parameters: Type.Object({
      topic: Type.String({ description: "The research question or topic to investigate." }),
      context: Type.Optional(Type.String({ description: "Additional context prepended to the topic." })),
      speed: Type.Optional(enumType(["fast", "balanced", "best"], "Controls Tavily research model selection. fast=mini, balanced=auto, best=pro.")),
      citationFormat: Type.Optional(enumType(["numbered", "mla", "apa", "chicago"], "Citation style for the research report.")),
      timeout: Type.Optional(Type.Number({ description: "Maximum time to wait for results in seconds. Defaults to 600." })),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      try {
        const model = modelForSpeed(params.speed);
        const topic = params.context ? `${params.context}\n\n${params.topic}` : params.topic;
        const args = ["research", "run", "--model", model, "--timeout", String(params.timeout ?? 600), "--json"];
        if (params.citationFormat) args.push("--citation-format", params.citationFormat);
        args.push("--", topic);

        const startTime = Date.now();
        onUpdate?.({
          content: [{ type: "text" as const, text: `🔍 Tavily research started · ${model}` }],
          details: { status: "running", model, topic: params.topic },
        });

        const result = await runTvlyWithHeartbeat(args, signal, onUpdate, startTime, () => `🔍 Researching with Tavily · ${formatElapsed(startTime)}`);
        return {
          content: [{ type: "text" as const, text: result.content ?? JSON.stringify(result, null, 2) }],
          details: { ...result, model, elapsed: Math.round((Date.now() - startTime) / 1000) },
        };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: error.message }], details: {}, isError: true };
      }
    },
  });

  const checkTavilyStatus = async (_args: string[], ctx: any) => {
    execFile("tvly", ["--status", "--json"], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        ctx.ui.notify(
          `✗ Tavily CLI check failed\n\n${stderr || error.message}\n\nInstall: curl -fsSL https://cli.tavily.com/install.sh | bash\nAuthenticate: tvly login`,
          "error",
        );
        return;
      }

      try {
        const status = parseJson(stdout);
        if (status.authenticated) {
          ctx.ui.notify(`✓ Tavily CLI ${status.version ?? ""} · authenticated`, "success");
        } else {
          ctx.ui.notify("✗ Tavily CLI found but not authenticated\n\nRun: tvly login", "warning");
        }
      } catch {
        ctx.ui.notify("✗ Tavily CLI returned non-JSON status", "warning");
      }
    });
  };

  pi.registerCommand("tavily-setup", {
    description: "Check Tavily CLI installation and authentication status",
    handler: checkTavilyStatus,
  });

  pi.registerCommand("tavily-status", {
    description: "Check Tavily CLI installation and authentication status",
    handler: checkTavilyStatus,
  });
}
