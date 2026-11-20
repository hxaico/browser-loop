import { describe, expect, it, vi } from "vitest";
import { normalizeContext, type Model, type SystemMessage, type ToolCall } from "@earendil-works/pi-ai";
import { getLoopModel } from "../src/pi/index";
import * as openai from "../src/pi/providers/openai/provider";

const { responsesCreate } = vi.hoisted(() => ({ responsesCreate: vi.fn() }));

vi.mock("openai", () => ({
	default: class {
		responses = {
			create: (...args: unknown[]) => ({
				withResponse: async () => ({
					data: responseEvents(responsesCreate(...args)),
					response: { status: 200, headers: new Headers() },
				}),
			}),
		};
	},
}));

async function* responseEvents(response: Record<string, unknown>) {
	if (Symbol.asyncIterator in response) {
		yield* response as unknown as AsyncIterable<unknown>;
		return;
	}
	yield {
		type: "response.created",
		response: { id: response.id, ...(response.service_tier ? { service_tier: response.service_tier } : {}) },
	};
	for (const [outputIndex, item] of ((response.output as unknown[]) ?? []).entries()) {
		yield { type: "response.output_item.added", output_index: outputIndex, item };
		yield { type: "response.output_item.done", output_index: outputIndex, item };
	}
	yield { type: "response.completed", response: { status: "completed", ...response } };
}

const model = getLoopModel("openai:gpt-5.5") as Model<"openai-responses">;
const nativeModel = { ...model, api: openai.OPENAI_COMPUTER_USE_API } as unknown as Model<"openai-responses">;
const astra62Native = { ...getLoopModel("openai:gpt-6.2-astra"), api: openai.OPENAI_COMPUTER_USE_API } as unknown as Model<"openai-responses">;
const incoming = { openaiComputerName: "computer", googleNames: {}, googleExcludedNames: [], nativeToolNames: ["computer"] };

describe("OpenAI native computer Responses adapter", () => {
	it("emits one identity-selected local call with compound id, plural actions[], safety checks, and SSE stream callbacks", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_1",
			usage: {
				input_tokens: 1_000,
				output_tokens: 200,
				input_tokens_details: { cached_tokens: 300, cache_write_tokens: 500 },
				output_tokens_details: { reasoning_tokens: 50 },
			},
			output: [{
				type: "computer_call",
				id: "cu_item_1",
				call_id: "computer_1",
				actions: [{ type: "click", x: 10, y: 20 }, { type: "type", text: "hello" }],
				pending_safety_checks: [{ id: "check_1", code: "malicious_instructions" }],
			}],
		});
		const observedEvents: string[] = [];
		const message = await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			systemPrompt: "Use computer.",
			messages: [{ role: "user", content: "click", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), {
			apiKey: "test",
			loopIncomingToolPlan: incoming,
			onProviderStreamEvent: (event) => {
				observedEvents.push(String((event as { type: string }).type));
			},
			onPayload: (payload) => ({ ...(payload as Record<string, unknown>), tools: [{ type: "computer" }] }),
		}).result();

		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call).toMatchObject({
			id: "computer_1|cu_item_1",
			name: "computer",
			arguments: {
				actions: [{ type: "click", x: 10, y: 20 }, { type: "type", text: "hello" }],
				pending_safety_checks: [{ id: "check_1", code: "malicious_instructions" }],
			},
		});
		expect(message.responseId).toBe("resp_1");
		expect(message.usage.cacheRead).toBe(300);
		expect(message.usage.cacheWrite).toBe(500);
		expect(message.usage.input).toBe(200);
		expect(message.usage.reasoning).toBe(50);
		expect(observedEvents).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(payload.store).toBe(false);
		expect(payload.stream).toBe(true);
		expect(payload.instructions).toBeUndefined();
		expect(payload.previous_response_id).toBeUndefined();
	});

	it("normalizes singular action into plural actions[]", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_singular",
			usage: {},
			output: [{
				type: "computer_call",
				call_id: "computer_s",
				action: { type: "screenshot" },
			}],
		});
		const message = await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			messages: [{ role: "user", content: "shot", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		const call = message.content.find((part): part is ToolCall => part.type === "toolCall");
		expect(call?.arguments).toEqual({ actions: [{ type: "screenshot" }] });
	});

	it("keeps computer in top-level params.tools via additions toolSupport and emits leading developer breakpoint on platform URL", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_gpt62", usage: {}, output: [] });
		const addedSystem: SystemMessage = {
			role: "system",
			content: "",
			toolsAdded: [{ name: "extra_tool", description: "extra", parameters: { type: "object" } as never }],
			timestamp: 2,
		};
		await openai.streamOpenAIComputerUse(astra62Native, normalizeContext({
			systemPrompt: "Control the browser.",
			messages: [{ role: "user", content: "go", timestamp: 1 }, addedSystem],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), {
			apiKey: "test",
			sessionId: "session_native",
			promptCacheOptions: { ttl: "12h", prewarm: true, comparison_response_id: "resp_cmp" },
			loopIncomingToolPlan: incoming,
		}).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as {
			instructions?: unknown;
			tools?: Array<Record<string, unknown>>;
			input: Array<Record<string, unknown>>;
			prompt_cache_key?: string;
			prompt_cache_options?: Record<string, unknown>;
		};
		expect(payload.instructions).toBeUndefined();
		expect(payload.tools).toEqual([expect.objectContaining({ name: "computer" })]);
		expect(payload.input[0]).toEqual({
			role: "developer",
			content: [{ type: "input_text", text: "Control the browser.", prompt_cache_breakpoint: { mode: "explicit" } }],
		});
		expect(payload.input).toContainEqual(expect.objectContaining({ type: "tool_search_call", execution: "client" }));
		expect(payload.input).toContainEqual(expect.objectContaining({ type: "tool_search_output", execution: "client" }));
		expect(payload.prompt_cache_key).toBe("session_native");
		expect(payload.prompt_cache_options).toEqual({ ttl: "12h", prewarm: true, comparison_response_id: "resp_cmp" });
	});

	it("omits prompt_cache_breakpoint and prompt_cache_options on non-platform baseUrl / env.OPENAI_BASE_URL", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_proxy", usage: {}, output: [] });
		const unsetBaseModel = { ...astra62Native, baseUrl: "" };
		await openai.streamOpenAIComputerUse(unsetBaseModel, normalizeContext({
			systemPrompt: "Control the browser.",
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), {
			apiKey: "sk-test",
			env: { OPENAI_BASE_URL: "https://bedrock-mantle.us-east-1.api.aws/openai/v1" },
			promptCacheOptions: { ttl: "12h" },
			loopIncomingToolPlan: incoming,
		}).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(payload.prompt_cache_options).toBeUndefined();
		expect((payload.input as Array<Record<string, unknown>>)[0]).toEqual({
			role: "developer",
			content: "Control the browser.",
		});

		responsesCreate.mockReturnValueOnce({ id: "resp_mantle_url", usage: {}, output: [] });
		const mantleModel = { ...astra62Native, baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1" };
		await openai.streamOpenAIComputerUse(mantleModel, normalizeContext({
			systemPrompt: "Control the browser.",
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), {
			apiKey: "sk-test",
			promptCacheOptions: { ttl: "12h" },
			loopIncomingToolPlan: incoming,
		}).result();
		const mantlePayload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(mantlePayload.prompt_cache_options).toBeUndefined();
	});

	it("applies serviceTier pricing multipliers (flex 0.5x, fast 2x, gpt-5.5 priority 2.5x, ultrafast 3x)", async () => {
		const runTier = async (targetModel: Model<"openai-responses">, serviceTier: string) => {
			responsesCreate.mockReturnValueOnce({
				id: `resp_${serviceTier}`,
				service_tier: serviceTier,
				usage: { input_tokens: 100_000, output_tokens: 100_000 },
				output: [],
			});
			return openai.streamOpenAIComputerUse(targetModel, normalizeContext({
				messages: [{ role: "user", content: "go", timestamp: 1 }],
				tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
			}), { apiKey: "sk-test", serviceTier: serviceTier as never, loopIncomingToolPlan: incoming }).result();
		};

		// gpt-6.2-astra base (<=272k): $8/M input ($0.80) + $40/M output ($4.00) = $4.80 total
		expect((await runTier(astra62Native, "flex")).usage.cost.total).toBeCloseTo(2.4);
		expect((await runTier(astra62Native, "fast")).usage.cost.total).toBeCloseTo(9.6);
		expect((await runTier(astra62Native, "ultrafast")).usage.cost.total).toBeCloseTo(14.4);

		// gpt-5.5 priority -> 2.5x
		const base55 = nativeModel.cost.input * 0.1 + nativeModel.cost.output * 0.1;
		expect((await runTier(nativeModel, "priority")).usage.cost.total).toBeCloseTo(base55 * 2.5);
	});

	it("forwards reasoning, configuration_update, and thinkingSignature replay", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_reason_1",
			usage: {},
			output: [
				{ type: "reasoning", id: "rs_1", encrypted_content: "enc_1", summary: [{ type: "summary_text", text: "thinking..." }] },
				{ type: "computer_call", id: "cu_1", call_id: "call_1", actions: [{ type: "screenshot" }] },
			],
		});
		const first = await openai.streamOpenAIComputerUse(astra62Native, normalizeContext({
			messages: [{ role: "user", content: "go", timestamp: 1 }],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "sk-test", reasoning: "low", loopIncomingToolPlan: incoming }).result();

		expect(first.providerThinkingLevel).toBe("low");
		const firstPayload = responsesCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(firstPayload.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(firstPayload.include).toEqual(["reasoning.encrypted_content"]);

		responsesCreate.mockReturnValueOnce({ id: "resp_reason_2", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(astra62Native, normalizeContext({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				first,
				{
					role: "toolResult",
					toolCallId: "call_1|cu_1",
					toolName: "computer",
					content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "sk-test", reasoning: "high", loopIncomingToolPlan: incoming }).result();

		const secondPayload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(secondPayload.input).toContainEqual({ type: "configuration_update", reasoning: { effort: "low" } });
		expect(secondPayload.input).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_1", encrypted_content: "enc_1" }));
		expect(secondPayload.input).toContainEqual({
			type: "computer_call",
			id: "cu_1",
			call_id: "call_1",
			actions: [{ type: "screenshot" }],
		});
		expect(secondPayload.input).toContainEqual(expect.objectContaining({
			type: "computer_call_output",
			call_id: "call_1",
		}));
		expect(secondPayload.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
	});

	it("normalizes click buttons and strips button from double_click on computer_call replay, and omits non-cu ids", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_replay", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(astra62Native, normalizeContext({
			messages: [
				{
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "call_c1|call_not_cu",
						name: "computer",
						arguments: {
							actions: [
								{ type: "click", x: 1, y: 2 },
								{ type: "click", x: 3, y: 4, button: "middle" },
								{ type: "click", x: 5, y: 6, button: 3 },
								{ type: "double_click", x: 7, y: 8, button: "left" },
							],
							pending_safety_checks: [{ id: "check_1" }],
						},
					}],
					api: astra62Native.api,
					provider: astra62Native.provider,
					model: astra62Native.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call_c1|call_not_cu",
					toolName: "computer",
					content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		const replayedCall = payload.input.find((item) => item.type === "computer_call");
		expect(replayedCall).toEqual({
			type: "computer_call",
			call_id: "call_c1",
			actions: [
				{ type: "click", x: 1, y: 2, button: "left" },
				{ type: "click", x: 3, y: 4, button: "wheel" },
				{ type: "click", x: 5, y: 6, button: "right" },
				{ type: "double_click", x: 7, y: 8 },
			],
			pending_safety_checks: [{ id: "check_1" }],
		});
		expect(replayedCall).not.toHaveProperty("id");
		expect(replayedCall).not.toHaveProperty("status");
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "computer_call_output",
			call_id: "call_c1",
			acknowledged_safety_checks: [{ id: "check_1" }],
		}));
	});

	it("round-trips function-call namespaces beside the native computer adapter", async () => {
		responsesCreate.mockReturnValueOnce({
			id: "resp_namespace",
			usage: {},
			output: [{
				type: "function_call",
				id: "fc_lookup",
				call_id: "call_lookup",
				name: "lookup",
				namespace: "deferred_tools",
				arguments: '{"query":"status"}',
			}],
		});
		const first = await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			messages: [{ role: "user", content: "look it up", timestamp: 1 }],
			tools: [
				{ name: "computer", description: "placeholder", parameters: { type: "object" } as never },
				{ name: "lookup", description: "lookup", parameters: { type: "object" } as never },
			],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();
		const call = first.content.find((part): part is ToolCall => part.type === "toolCall") as ToolCall & { namespace?: string };
		expect(call.namespace).toBe("deferred_tools");

		responsesCreate.mockReturnValueOnce({ id: "resp_done", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			messages: [
				{ role: "user", content: "look it up", timestamp: 1 },
				first,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "ok" }],
					details: {},
					isError: false,
					timestamp: 2,
				},
			],
			tools: [
				{ name: "computer", description: "placeholder", parameters: { type: "object" } as never },
				{ name: "lookup", description: "lookup", parameters: { type: "object" } as never },
			],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>>; store?: unknown; previous_response_id?: unknown };
		expect(payload.input).toContainEqual(expect.objectContaining({
			type: "function_call",
			call_id: "call_lookup",
			name: "lookup",
			namespace: "deferred_tools",
		}));
		expect(payload.store).toBe(false);
		expect(payload.previous_response_id).toBeUndefined();
	});
});

describe("computer_call_output serialization", () => {
	async function sendWithResult(content: Array<{ type: string; [k: string]: unknown }>, isError: boolean) {
		responsesCreate.mockReturnValueOnce({ id: "resp_ser", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "computer", arguments: {} }], stopReason: "toolUse" },
				{ role: "toolResult", toolCallId: "c1", toolName: "computer", content, isError, timestamp: 1 },
			] as never,
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();
		return JSON.stringify(responsesCreate.mock.calls.at(-1)?.[0]);
	}

	it("never emits an error key, and always carries a valid screenshot", async () => {
		const sent = await sendWithResult([{ type: "text", text: "click failed" }], true);
		expect(sent).not.toContain('"error"');
		expect(sent).toContain("computer_screenshot");
		expect(sent).toContain("image_url");
		expect(sent).toContain("computer action produced no screenshot");
	});

	it("uses the real screenshot when the result carries one", async () => {
		const sent = await sendWithResult([{ type: "image", data: "aW1n", mimeType: "image/png" }], false);
		expect(sent).toContain("data:image/png;base64,aW1n");
		expect(sent).not.toContain("produced no screenshot");
	});

	it("replays assistant text as output_text", async () => {
		responsesCreate.mockReturnValueOnce({ id: "resp_turn2", usage: {}, output: [] });
		await openai.streamOpenAIComputerUse(nativeModel, normalizeContext({
			messages: [
				{ role: "user", content: "say hi" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				{ role: "user", content: "say hi again" },
			] as never,
			tools: [{ name: "computer", description: "placeholder", parameters: { type: "object" } as never }],
		}), { apiKey: "test", loopIncomingToolPlan: incoming }).result();

		const payload = responsesCreate.mock.calls.at(-1)?.[0] as { input: Array<Record<string, unknown>> };
		expect(payload.input).toContainEqual({ role: "assistant", content: [{ type: "output_text", text: "hi" }] });
	});
});
