import { describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
	type Model,
	type Models,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	attach,
	createLoopModels,
	delegateMutableModels,
	GOOGLE_INTERACTIONS_API,
	type LoopContextualTool,
	type LoopHarnessLike,
	type LoopSimpleStreamOptions,
	OPENAI_COMPUTER_USE_API,
} from "../src/pi/index";
import { type KernelBrowser, loop } from "../src/index";
import type Kernel from "@onkernel/sdk";
import { installLoopBehaviors, turnFailureStopMessage } from "../src/pi/attach";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function assistant(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function recordingStream(seen: { model: Model<string>; context: TranscriptContext; options?: LoopSimpleStreamOptions }[]): StreamFn {
	return (model, context, options) => {
		seen.push({ model, context: { ...context, messages: [...context.messages] } as TranscriptContext, options: options as LoopSimpleStreamOptions });
		const stream = createAssistantMessageEventStream();
		const message = assistant(model);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
		return stream;
	};
}

function createAgentHarness(options: {
	model: Model<any>;
	models: Models;
	tools: readonly LoopContextualTool<undefined>[];
}): LoopHarnessLike<LoopContextualTool<undefined>> & { prompt(input: string): Promise<void> } {
	let currentTools = [...options.tools];
	const handlers = new Map<string, Set<(...args: any[]) => any>>();
	const emitSync = (event: string, payload: unknown): Record<string, unknown> | undefined => {
		for (const handler of handlers.get(event) ?? []) {
			const result = handler(payload);
			if (result !== undefined) return result as Record<string, unknown>;
		}
		return undefined;
	};
	const agent = new Agent({
		streamFn: (model, context, streamOptions) => options.models.streamSimple(model, context, streamOptions),
		initialState: {
			model: options.model,
			tools: currentTools as unknown as AgentTool[],
			systemPrompt: "",
		},
		beforeToolCall: async ({ toolCall }) => emitSync("tool_call", { toolName: toolCall.name }) as any,
		afterToolCall: async ({ toolCall, result, isError }) =>
			emitSync("tool_result", { toolName: toolCall.name, content: result.content, details: result.details, isError }) as any,
	});
	return {
		getModel: () => agent.state.model,
		setModel: (model) => {
			agent.state.model = model;
		},
		getTools: () => currentTools,
		setTools: (tools) => {
			currentTools = [...tools];
			agent.state.tools = currentTools as unknown as AgentTool[];
		},
		on: (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		subscribe: (listener) => agent.subscribe((event, signal) => listener(event, signal)),
		followUp: (message) => {
			agent.followUp({ role: "user", content: message, timestamp: Date.now() });
		},
		prompt: async (input) => {
			for (const handler of handlers.get("before_agent_start") ?? []) handler();
			await agent.prompt(input);
		},
	};
}

describe("attach", () => {
	it("compiles a (model, tools) pair into plain pi objects", () => {
		const handle = attach({ browser, client });
		const compiled = handle.compile({
			model: "openai:gpt-5.5",
			tools: [loop.tools.browser.snapshot(), loop.tools.browser.click()],
		});

		expect(compiled.model.api).toBe("openai-responses");
		expect(compiled.tools.map((tool) => tool.name)).toEqual(["browser_snapshot", "browser_click"]);
		expect(compiled.agentTools.every((tool) => typeof tool.execute === "function")).toBe(true);
		expect(typeof compiled.models.streamSimple).toBe("function");
		expect(typeof compiled.models.getAuth).toBe("function");
	});

	it("derives the transport from the selected tools", () => {
		const handle = attach({ browser, client });
		const cdp = handle.compile({ model: "google:gemini-3.6-flash", tools: [loop.tools.browser.snapshot()] });
		const native = handle.compile({ model: "google:gemini-3.6-flash", tools: loop.providers.google.toolsets.browser() });

		expect(cdp.model.api).toBe("google-generative-ai");
		expect(native.model.api).toBe(GOOGLE_INTERACTIONS_API);
	});

	it("materializes a spec once per handle, across compiles", () => {
		const handle = attach({ browser, client });
		const snapshot = loop.tools.browser.snapshot();
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot] });
		handle.compile({ model: "openai:gpt-5.5", tools: [snapshot, loop.tools.browser.click()] });

		// The executable is cached per pool and per spec. Each compile wraps it to
		// install the execution scope, so the wrapper differs while the tool
		// underneath — and the implementation identity pi keys cache decisions on —
		// stays stable.
		expect(handle.resources.materialize(snapshot)).toBe(handle.resources.materialize(snapshot));
	});

	it("drives a plain pi Agent with no Loop agent class", async () => {
		const seen: { model: Model<string>; context: TranscriptContext; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });

		const agent = new Agent({
			streamFn: recordingStream(seen),
			initialState: { model: compiled.model, tools: [...compiled.agentTools], systemPrompt: "" },
		});
		await agent.prompt("go");

		expect(seen).toHaveLength(1);
		expect(seen[0]!.model.api).toBe("openai-responses");
		expect(getCurrentTools(seen[0]!.context.messages).map((tool) => tool.name)).toEqual(["browser_snapshot"]);
	});

	it("drives a LoopHarnessLike wrapper over Agent, with Loop's behaviors installed", async () => {
		const seen: { model: Model<string>; context: TranscriptContext; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client, models: modelsFromStream(recordingStream(seen)) });
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });

		const harness = createAgentHarness({
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
		});
		const release = compiled.activate(harness);

		await harness.prompt("go");
		expect(seen).toHaveLength(1);
		expect(getCurrentTools(seen[0]!.context.messages).map((tool) => tool.name)).toEqual(["browser_snapshot"]);
		expect(typeof release).toBe("function");
		release();
	});

	it("streams the live catalog's tool plan after a swap, not the one the harness was built with", async () => {
		const seen: { model: Model<string>; context: TranscriptContext; options?: LoopSimpleStreamOptions }[] = [];
		const handle = attach({ browser, client, models: modelsFromStream(recordingStream(seen)) });
		const first = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });

		const harness = createAgentHarness({
			model: first.model,
			models: first.models,
			tools: [...first.tools],
		});
		first.activate(harness);

		const second = handle.compile({ model: "openai:gpt-5.5", tools: [loop.providers.openai.tools.computer()] });
		await second.apply(harness);
		await harness.prompt("go");

		// pi fixes `models` at construction while the headers, payload transforms
		// and tool plan it carries are per-catalog, so a per-compile collection
		// would keep sending the first catalog's plan for the rest of the session.
		expect(seen).toHaveLength(1);
		expect(seen[0]!.options?.loopIncomingToolPlan?.openaiComputerName).toBe("computer");
		expect(seen[0]!.model.api).toBe(OPENAI_COMPUTER_USE_API);
	});

	it("runs the handle's onPayload even when the request carries its own", async () => {
		const seen: { model: Model<string>; context: TranscriptContext; options?: LoopSimpleStreamOptions }[] = [];
		const applied: string[] = [];
		const handle = attach({
			browser,
			client,
			models: modelsFromStream(recordingStream(seen)),
			onPayload: (payload) => {
				applied.push("handle");
				return payload as Record<string, unknown>;
			},
		});
		const compiled = handle.compile({ model: "openai:gpt-5.5", tools: [loop.tools.browser.snapshot()] });
		const harness = createAgentHarness({
			model: compiled.model,
			models: compiled.models,
			tools: [...compiled.tools],
		});
		compiled.activate(harness);
		await harness.prompt("go");

		await seen[0]!.options?.onPayload?.({}, compiled.model);
		expect(applied).toEqual(["handle"]);
	});

	it("spends an empty-response retry only when the follow-up is queued", async () => {
		const attempted: string[] = [];
		let reject = true;
		let emit!: (event: unknown, signal?: AbortSignal) => Promise<void>;
		const stub = {
			on: () => () => {},
			subscribe: (handler: (event: unknown, signal?: AbortSignal) => Promise<void>) => {
				emit = handler;
				return () => {};
			},
			followUp: async (message: string) => {
				attempted.push(message);
				if (reject) throw new Error("queue closed");
			},
		};
		const manager = { catalog: { entries: [] }, specFor: () => undefined };
		installLoopBehaviors(stub as never, manager as never, { followUp: "continue", maxAttempts: 1 });

		const emptyTurn = { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] } };
		await expect(emit(emptyTurn)).rejects.toThrow("queue closed");
		reject = false;
		await emit(emptyTurn);
		// The rejected queue left the turn untouched, so it must not have spent the
		// single attempt; the second follow-up does, and a third is refused.
		await emit(emptyTurn);

		expect(attempted).toEqual(["continue", "continue"]);
	});

	it("uses the blocked tool's own failure-stop message", () => {
		const entries = [
			{ identity: "computer", name: "computer" },
			{ identity: "browser", name: "browser" },
		];
		const messages = new Map([
			["computer", "computer stopped"],
			["browser", "browser stopped"],
		]);
		const manager = {
			catalog: { entries },
			specFor: (identity: string) => ({
				execution: { kind: "actions", stopTurnOnFailureMessage: messages.get(identity) },
			}),
		};

		expect(turnFailureStopMessage(manager as never, "browser")).toBe("browser stopped");
		expect(turnFailureStopMessage(manager as never, "computer")).toBe("computer stopped");
	});

	it("disposes the shared execution pool once, not per compile", async () => {
		const handle = attach({ browser, client });
		handle.compile({ model: "openai:gpt-5.5", tools: [] });
		handle.compile({ model: "anthropic:claude-opus-5", tools: [] });
		await expect(handle.dispose()).resolves.toBeUndefined();
	});
});

function modelsFromStream(streamFn: StreamFn) {
	const models = delegateMutableModels(createLoopModels());
	models.setProvider({
		id: "openai",
		name: "scripted",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}
