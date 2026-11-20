import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	attach,
	createLoopModels,
	type LoopContextualTool,
	type LoopHarnessLike,
} from "../src/pi/index";
import type Kernel from "@onkernel/sdk";
import type { KernelBrowser } from "../src/index";

const browser = { session_id: "browser_123", viewport: { width: 1440, height: 900 } } as KernelBrowser;
const client = {} as Kernel;

function assistant(model: Model<string>, content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function scriptedStream(turns: Array<(model: Model<string>) => AssistantMessage>): StreamFn {
	let call = 0;
	return (model) => {
		const stream = createAssistantMessageEventStream();
		const message = turns[call++]?.(model) ?? assistant(model);
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
		stream.end(message);
		return stream;
	};
}

function modelsFromStream(streamFn: StreamFn, provider = "openai") {
	const models = createLoopModels();
	models.setProvider({
		id: provider,
		name: "scripted",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => [],
		stream: streamFn,
		streamSimple: streamFn,
	} as never);
	return models;
}

function bindContextualTools<TContext extends object | undefined>(
	tools: readonly LoopContextualTool<TContext>[],
	toolContext: TContext,
): AgentTool[] {
	return tools.map((tool) => ({
		...tool,
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params, signal, onUpdate, toolContext),
	}));
}

/** Build a lightweight LoopHarnessLike wrapper over Agent that delivers `toolContext`. */
function openHarness<TContext extends object | undefined>(options: {
	models: ReturnType<typeof modelsFromStream>;
	tools: readonly LoopContextualTool<TContext>[];
	toolContext: TContext;
}): LoopHarnessLike<LoopContextualTool<TContext>> & { prompt(input: string): Promise<void> } {
	const handle = attach({ browser, client, models: options.models });
	const compiled = handle.compile<TContext>({ model: "openai:gpt-5.5", tools: options.tools });
	let currentTools = [...compiled.tools];
	const handlers = new Map<string, Set<(...args: any[]) => any>>();
	const emitSync = (event: string, payload: unknown): Record<string, unknown> | undefined => {
		for (const handler of handlers.get(event) ?? []) {
			const result = handler(payload);
			if (result !== undefined) return result as Record<string, unknown>;
		}
		return undefined;
	};
	const agent = new Agent({
		streamFn: (model, context, streamOptions) => compiled.models.streamSimple(model, context, streamOptions),
		initialState: {
			model: compiled.model,
			tools: bindContextualTools(currentTools, options.toolContext),
			systemPrompt: "",
		},
		beforeToolCall: async ({ toolCall }) => emitSync("tool_call", { toolName: toolCall.name }) as any,
		afterToolCall: async ({ toolCall, result, isError }) =>
			emitSync("tool_result", { toolName: toolCall.name, content: result.content, details: result.details, isError }) as any,
	});
	const harness: LoopHarnessLike<LoopContextualTool<TContext>> & { prompt(input: string): Promise<void> } = {
		getModel: () => agent.state.model,
		setModel: (model) => {
			agent.state.model = model;
		},
		getTools: () => currentTools,
		setTools: (tools) => {
			currentTools = [...tools];
			agent.state.tools = bindContextualTools(currentTools, options.toolContext);
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
	compiled.activate(harness);
	return harness;
}

describe("harness tool context", () => {
	it("delivers the exact supplied context object to custom harness tools", async () => {
		interface CustomContext {
			cwd: string;
			requestId: string;
		}
		const cwd = mkdtempSync(join(tmpdir(), "loop-harness-context-"));
		const toolContext: CustomContext = { cwd, requestId: "req-1" };
		const received: CustomContext[] = [];
		const custom: LoopContextualTool<CustomContext> = {
			name: "custom_context",
			label: "custom_context",
			description: "records its tool context",
			parameters: { type: "object", properties: {}, additionalProperties: false } as never,
			execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
				received.push(context);
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = openHarness<CustomContext>({
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "call-1", name: "custom_context", arguments: {} }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			])),
			tools: [custom],
			toolContext,
		});

		await harness.prompt("run the tool");

		expect(received.length).toBe(1);
		expect(received[0]).toBe(toolContext);
	});

	it("executes contextual write and read tools against the supplied workspace context", async () => {
		interface WorkspaceContext {
			cwd: string;
		}
		const cwd = mkdtempSync(join(tmpdir(), "loop-harness-tools-"));
		const writeTool: LoopContextualTool<WorkspaceContext> = {
			name: "write",
			label: "write",
			description: "write file",
			parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } as never,
			execute: async (_id, params: { path: string; content: string }, _signal, _onUpdate, context) => {
				writeFileSync(join(context.cwd, params.path), params.content);
				return { content: [{ type: "text", text: "wrote" }], details: {} };
			},
		};
		const readTool: LoopContextualTool<WorkspaceContext> = {
			name: "read",
			label: "read",
			description: "read file",
			parameters: { type: "object", properties: { path: { type: "string" } } } as never,
			execute: async (_id, params: { path: string }, _signal, _onUpdate, context) => ({
				content: [{ type: "text", text: readFileSync(join(context.cwd, params.path), "utf8") }],
				details: {},
			}),
		};
		const harness = openHarness<WorkspaceContext>({
			models: modelsFromStream(scriptedStream([
				(model) => assistant(model, [{ type: "toolCall", id: "write-1", name: "write", arguments: { path: "notes.txt", content: "goodbye loop\n" } }], "toolUse"),
				(model) => assistant(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.txt" } }], "toolUse"),
				(model) => assistant(model, [{ type: "text", text: "done" }]),
			])),
			tools: [writeTool, readTool],
			toolContext: { cwd },
		});
		const results = new Map<string, { content: Array<{ type: string; text?: string }>; isError: boolean }>();
		harness.on("tool_result", (event) => {
			results.set(event.toolName, { content: event.content, isError: event.isError });
			return undefined;
		});

		await harness.prompt("write and read a file");

		expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("goodbye loop\n");
		expect(results.get("write")?.isError).toBe(false);
		expect(results.get("read")?.content.some((block) => block.text?.includes("goodbye loop"))).toBe(true);
	});
});
