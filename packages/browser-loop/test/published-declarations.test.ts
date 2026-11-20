import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "..", "..");

/**
 * Downstream consumer compiled against the packaged declarations (dist/) with
 * skipLibCheck disabled, so transitive declaration issues in this package, pi,
 * or TypeBox surface here instead of after publish.
 */
const CONSUMER = `
import { Type } from "typebox";
import {
	loop,
	type LoopAgentTool,
	type LoopHarnessTool,
	type KernelBrowser,
} from "@onkernel/browser-loop";
import {
	Agent,
} from "@earendil-works/pi-agent-core";
import {
	attach,
	delegateModels,
	getLoopModel,
	isOpenAIPlatformBaseUrl,
	type LoopContextualTool,
	type LoopHarnessLike,
	type OpenAIPromptCacheOptions,
} from "@onkernel/browser-loop/pi";
import type Kernel from "@onkernel/sdk";

declare const browser: KernelBrowser;
declare const client: Kernel;

interface CustomContext {
	requestId: string;
}

const custom: LoopContextualTool<CustomContext> = {
	name: "custom",
	label: "custom",
	description: "custom tool",
	parameters: Type.Object({}),
	execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
		const delivered: CustomContext = context;
		void delivered;
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

const harnessTools: readonly LoopHarnessTool<CustomContext>[] = [
	...loop.toolsets.browser(),
	custom,
];

const agentTools: readonly LoopAgentTool[] = [...loop.toolsets.browser()];

declare const harness: LoopHarnessLike<LoopContextualTool<CustomContext>>;

async function build() {
	const handle = attach({ browser, client });
	const cacheOptions: OpenAIPromptCacheOptions = { mode: "explicit", ttl: "12h", prewarm: true };
	const isPlatform: boolean = isOpenAIPlatformBaseUrl("https://api.openai.com/v1");
	void cacheOptions;
	void isPlatform;

	const compiled = handle.compile<CustomContext>({ model: "openai:gpt-6.2-sol", tools: harnessTools });
	const delegatedModels = delegateModels(compiled.models, {});
	const release = compiled.activate(harness);
	// A swap compiles for the same tool context the harness delivers.
	await handle.compile<CustomContext>({ model: getLoopModel("openai:gpt-6.2-astra"), tools: [] }).apply(harness);

	const lowLevel = handle.compile({ model: "openai:gpt-5.6-sol", tools: agentTools });
	const agent = new Agent({
		streamFn: (model, context, options) => delegatedModels.streamSimple(model, context, options),
		initialState: { model: lowLevel.model, tools: [...lowLevel.agentTools] },
	});

	// @ts-expect-error the browser and client belong to attach(), not to a compile
	handle.compile({ browser, model: "openai:gpt-5.6-sol", tools: [] });

	return { harness, agent, release };
}

void build;
`;

function run(command: string, args: string[], cwd: string): void {
	try {
		execFileSync(command, args, { cwd, stdio: "pipe" });
	} catch (error) {
		const failure = error as { stdout?: Buffer; stderr?: Buffer };
		throw new Error(
			`${command} ${args.join(" ")} failed:\n${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
			{ cause: error },
		);
	}
}

// skipLibCheck: false checks the whole reachable declaration graph. Two
// vendored SDK typings cannot compile under it in a hoisted node_modules
// layout, independent of loop: @anthropic-ai/sdk unions import() fallbacks
// for nested layouts that cannot resolve, and @google/genai references an
// optional MCP package and DOM event globals. Tolerate exactly those two
// files' errors; anything else — above all our dist declarations, pi's, or
// TypeBox's — fails the test.
const TOLERATED = [
	/node_modules\/\@anthropic-ai\/sdk\/.*TS2307/,
	/node_modules\/\@google\/genai\/.*TS(2307|2304|2552)/,
];

function runTsc(tsconfigDir: string): void {
	try {
		execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfigDir], { stdio: "pipe" });
		return;
	} catch (error) {
		const failure = error as { stdout?: Buffer; stderr?: Buffer };
		const output = `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`;
		const errors = output.trim().split("\n").filter((line) => line.length > 0);
		const unexpected = errors.filter((line) => !TOLERATED.some((pattern) => pattern.test(line)));
		if (unexpected.length === 0) return;
		throw new Error(`tsc reported unexpected declaration errors:\n${unexpected.join("\n")}`, { cause: error });
	}
}

describe("published declarations", () => {
	it("compile a downstream consumer with skipLibCheck: false", { timeout: 300_000 }, () => {
		const dir = mkdtempSync(join(tmpdir(), "loop-declarations-"));
		// Built beside dist/ rather than over it, because the pi extension tests
		// import dist/ while this test runs, and inside the package so the emitted
		// declarations resolve pi and TypeBox exactly as the published ones do.
		const out = join(packageRoot, "dist-published");
		run("npx", ["tsdown", "--out-dir", out], packageRoot);
		writeFileSync(join(dir, "consumer.ts"), CONSUMER);
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				lib: ["ES2022"],
				types: ["node"],
				typeRoots: [join(repoRoot, "node_modules", "@types")],
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				baseUrl: repoRoot,
				paths: {
					"@onkernel/browser-loop": [join(out, "index.d.ts")],
					"@onkernel/browser-loop/pi": [join(out, "pi", "index.d.ts")],
					"*": ["./node_modules/*"],
				},
			},
			include: ["consumer.ts"],
		}, null, 2));

		runTsc(dir);
	});
});
