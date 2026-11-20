import { describe, expect, it } from "vitest";
import type { SystemMessage, ToolCall } from "@earendil-works/pi-ai";
import {
	createLoopModels,
	getLoopModel,
	isOpenAIPlatformBaseUrl,
	OPENAI_COMPUTER_USE_API,
} from "../src/pi/index";

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = events
		.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function responseEvents(response: Record<string, unknown>): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [
		{ type: "response.created", response: { id: response.id, ...(response.service_tier ? { service_tier: response.service_tier } : {}) } },
	];
	for (const [outputIndex, item] of ((response.output as unknown[]) ?? []).entries()) {
		events.push({ type: "response.output_item.added", output_index: outputIndex, item });
		events.push({ type: "response.output_item.done", output_index: outputIndex, item });
	}
	events.push({ type: "response.completed", response });
	return events;
}

function createFetchMock(queue: Array<Record<string, unknown>>) {
	const payloads: Array<Record<string, unknown>> = [];
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		const rawBody = typeof init?.body === "string" ? init.body : "{}";
		payloads.push(JSON.parse(rawBody) as Record<string, unknown>);
		const next = queue.shift() ?? { id: "resp_default", status: "completed", usage: {}, output: [] };
		return sseResponse(responseEvents(next));
	};
	return { fetch, payloads };
}

const model = getLoopModel("openai:gpt-5.5");
const tools = [{ name: "lookup", description: "lookup", parameters: { type: "object" } as never }];

describe("OpenAI adapter routing", () => {
	it("streams a plain function-tool context through wrapped pi-ai openai-responses with namespace round-trip", async () => {
		const mock = createFetchMock([{
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1 },
			output: [{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: "{}",
				status: "completed",
			}],
		}]);

		const message = await createLoopModels().streamSimple(model, {
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools,
		}, { apiKey: "test", sessionId: "session_1", fetch: mock.fetch }).result();

		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call?.name).toBe("lookup");
		expect(call?.namespace).toBe("deferred_tools");

		const payload = mock.payloads[0]!;
		expect(payload.store).toBe(false);
		expect(payload.prompt_cache_key).toBe("session_1");
		expect(payload.previous_response_id).toBeUndefined();
	});

	it("reaches the Loop adapter when the model carries OPENAI_COMPUTER_USE_API", async () => {
		const mock = createFetchMock([{
			id: "resp_2",
			status: "completed",
			usage: { input_tokens: 10, output_tokens: 5 },
			output: [{
				type: "computer_call",
				id: "cu_2",
				call_id: "computer_1",
				actions: [{ type: "click", x: 10, y: 20, button: "left" }],
			}],
		}]);

		const computerModel = { ...model, api: OPENAI_COMPUTER_USE_API };
		const message = await createLoopModels().streamSimple(computerModel, {
			messages: [{ role: "user", content: "click it", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}, {
			apiKey: "test",
			fetch: mock.fetch,
			loopIncomingToolPlan: { openaiComputerName: "computer", googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] },
		} as never).result();

		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call).toMatchObject({
			id: "computer_1|cu_2",
			name: "computer",
			arguments: { actions: [{ type: "click", x: 10, y: 20, button: "left" }] },
		});
	});

	it("injects prompt_cache_breakpoint on the developer prompt after leading additional_tools before caller onPayload", async () => {
		const astra62 = getLoopModel("openai:gpt-6.2-astra");
		const mock = createFetchMock([{ id: "resp_gpt62", status: "completed", usage: {}, output: [] }]);
		let observedByCallerOnPayload: unknown;

		await createLoopModels().streamSimple(astra62, {
			systemPrompt: "Static system instructions.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools,
		}, {
			apiKey: "test",
			sessionId: "sess_gpt62",
			fetch: mock.fetch,
			onPayload: (payload) => {
				observedByCallerOnPayload = structuredClone(payload);
				return payload;
			},
		}).result();

		const payload = mock.payloads[0] as { input: Array<Record<string, unknown>>; tools?: unknown };
		expect(payload.tools).toBeUndefined();
		expect(payload.input[0]).toMatchObject({ type: "additional_tools", role: "developer" });
		expect(payload.input[1]).toEqual({
			role: "developer",
			content: [{
				type: "input_text",
				text: "Static system instructions.",
				prompt_cache_breakpoint: { mode: "explicit" },
			}],
		});
		expect(observedByCallerOnPayload).toEqual(payload);
	});

	it("gates prompt_cache_breakpoint and prompt_cache_options on isOpenAIPlatformBaseUrl", async () => {
		expect(isOpenAIPlatformBaseUrl(undefined)).toBe(true);
		expect(isOpenAIPlatformBaseUrl("https://api.openai.com/v1")).toBe(true);
		expect(isOpenAIPlatformBaseUrl("https://us.api.openai.com/v1")).toBe(true);
		expect(isOpenAIPlatformBaseUrl("https://bedrock-mantle.us-east-1.api.aws/openai/v1")).toBe(false);
		expect(isOpenAIPlatformBaseUrl(undefined, "https://proxy.example.com/v1")).toBe(false);
		expect(isOpenAIPlatformBaseUrl("not a url")).toBe(false);

		const mantleModel = {
			...getLoopModel("openai:gpt-6.2-astra"),
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
		};
		const mock = createFetchMock([{ id: "resp_mantle", status: "completed", usage: {}, output: [] }]);

		await createLoopModels().streamSimple(mantleModel, {
			systemPrompt: "Static system instructions.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools,
		}, {
			apiKey: "test",
			cacheRetention: "none",
			fetch: mock.fetch,
		}).result();

		const payload = mock.payloads[0]!;
		expect(payload.prompt_cache_options).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint");
	});

	it("scales usage cost by 3x on ultrafast serviceTier in streamOpenAIResponses", async () => {
		const astra62 = getLoopModel("openai:gpt-6.2-astra");
		const mock = createFetchMock([{
			id: "resp_ultra",
			status: "completed",
			service_tier: "ultrafast",
			usage: {
				input_tokens: 100_000,
				output_tokens: 100_000,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
			},
			output: [],
		}]);

		const events: Array<{ type: string; message?: { usage: { cost: Record<string, number> } } }> = [];
		const stream = createLoopModels().streamSimple(astra62, {
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools,
		}, {
			apiKey: "test",
			fetch: mock.fetch,
		});
		for await (const event of stream) {
			events.push(event as never);
		}
		const finalMessage = await stream.result();
		const doneEvent = events.find((e) => e.type === "done");

		// Base gpt-6.2-astra (<=272k): $8/M input ($0.80), $40/M output ($4.00) -> 3x ultrafast: $2.40 input, $12.00 output, $14.40 total.
		expect(doneEvent?.message?.usage.cost.input).toBeCloseTo(2.4);
		expect(doneEvent?.message?.usage.cost.output).toBeCloseTo(12);
		expect(doneEvent?.message?.usage.cost.total).toBeCloseTo(14.4);
		expect(finalMessage.usage.cost.total).toBeCloseTo(14.4);
	});

	it("round-trips mid-conversation SystemMessage tool additions through pi-ai openai-responses", async () => {
		const mock = createFetchMock([{
			id: "resp_tools",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1 },
			output: [{
				type: "function_call",
				id: "fc_3",
				call_id: "call_3",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: "{}",
				status: "completed",
			}],
		}]);

		const addedSystem: SystemMessage = {
			role: "system",
			content: "",
			toolsAdded: tools,
			timestamp: 2,
		};

		const message = await createLoopModels().streamSimple(getLoopModel("openai:gpt-6.2-astra"), {
			messages: [
				{ role: "user", content: "load and look it up", timestamp: 1 },
				addedSystem,
			],
		}, { apiKey: "test", fetch: mock.fetch }).result();

		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call?.namespace).toBe("deferred_tools");
		const payload = mock.payloads[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "additional_tools",
			role: "developer",
		}));
	});
});
