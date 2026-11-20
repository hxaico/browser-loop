import OpenAI from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	getSystemMessageText,
	renderSystemMessageUpdate,
	resolveTranscript,
	resolveTranscriptTools,
	ToolCallArgumentsStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type ImageContent,
	type JsonObject,
	type JsonValue,
	type Message,
	type Model,
	type OpenAIResponsesOptions as PiOpenAIResponsesOptions,
	type StreamFunction,
	type SystemMessage,
	type TextContent,
	type ThinkingContent,
	type ThinkingLevel,
	type Tool,
	type ToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { stream as piStreamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { retryProviderRequest } from "@earendil-works/pi-ai/utils/provider-retry";
import { OPENAI_COMPUTER_USE_API, type LoopIncomingToolPlan } from "../../../core/tool-catalog";
import type { LoopSimpleStreamOptions } from "../common";

export { OPENAI_COMPUTER_USE_API };

/**
 * 64x64 black PNG, used when a computer action produced no screenshot so the
 * `computer_screenshot` output stays valid. A 1x1 image is rejected by the
 * Responses API even though the vision endpoint accepts it.
 */
const BLANK_SCREENSHOT_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIklEQVR4nO3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAA8G4wQAABiwCo9wAAAABJRU5ErkJggg==";
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

export type OpenAIPromptCacheTtl = "30m" | "12h";

export interface OpenAIPromptCacheOptions {
	mode?: "explicit";
	ttl?: OpenAIPromptCacheTtl;
	prewarm?: boolean;
	comparison_response_id?: string;
}

export interface OpenAIResponsesOptions extends PiOpenAIResponsesOptions {
	/** @internal Identity-addressed native dispatch compiled from selected tools. */
	loopIncomingToolPlan?: LoopIncomingToolPlan;
	promptCacheOptions?: OpenAIPromptCacheOptions;
	explicitDeveloperCacheBreakpoint?: boolean;
}

export type LoopOpenAISimpleStreamOptions = LoopSimpleStreamOptions &
	Partial<Pick<OpenAIResponsesOptions, "serviceTier" | "reasoningSummary" | "promptCacheOptions" | "explicitDeveloperCacheBreakpoint">>;

/** The request fields both the function-tool and native-computer paths read, whichever option shape the caller passed. */
type OpenAIRequestOptions = Pick<
	OpenAIResponsesOptions,
	"apiKey" | "cacheRetention" | "env" | "fetch" | "headers" | "sessionId" | "promptCacheOptions"
>;

/**
 * Return whether requests to this OpenAI endpoint go directly to OpenAI's
 * platform API (`api.openai.com` or its subdomains). Third-party OpenAI-compatible
 * endpoints such as AWS Bedrock Mantle reject OpenAI-only prompt cache fields.
 */
export function isOpenAIPlatformBaseUrl(baseUrl: string | undefined, envBaseUrl?: string): boolean {
	const effective = baseUrl?.trim() || envBaseUrl?.trim();
	if (!effective) return true;
	try {
		const { hostname } = new URL(effective);
		return hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
	} catch {
		return false;
	}
}

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (model, context, options) => {
	const envBaseUrl = options?.env?.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL;
	const isPlatform = isOpenAIPlatformBaseUrl(model.baseUrl, envBaseUrl);
	const retention = cacheRetention(options);
	const shouldInjectBreakpoint =
		model.compat?.supportsExplicitPromptCacheMode === true &&
		isPlatform &&
		retention !== "none" &&
		options?.explicitDeveloperCacheBreakpoint !== false;

	let echoedServiceTier: string | undefined;
	const callerOnPayload = options?.onPayload;
	const callerOnProviderEvent = options?.onProviderStreamEvent;

	const wrappedOptions: OpenAIResponsesOptions = {
		...options,
		onPayload: async (payload, currentModel) => {
			let nextPayload = prepareResponsesPayload(payload, {
				isPlatform,
				shouldInjectBreakpoint,
				promptCacheOptions: options?.promptCacheOptions,
			});
			if (callerOnPayload) {
				nextPayload = (await callerOnPayload(nextPayload, currentModel)) ?? nextPayload;
			}
			return nextPayload;
		},
		onProviderStreamEvent: async (event, currentModel) => {
			if (isRecord(event) && isRecord(event.response) && typeof event.response.service_tier === "string") {
				echoedServiceTier = event.response.service_tier;
			}
			await callerOnProviderEvent?.(event, currentModel);
		},
	};

	const source = piStreamOpenAIResponses(model, context, wrappedOptions);
	const relay = createAssistantMessageEventStream();
	void relayResponsesStream(relay, source, model, () => echoedServiceTier ?? options?.serviceTier, options?.signal);
	return relay;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", LoopOpenAISimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return streamOpenAIResponses(model, context, {
		...base,
		...(options?.toolChoice !== undefined ? { toolChoice: options.toolChoice as OpenAIResponsesOptions["toolChoice"] } : {}),
		...(options?.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
		...(options?.reasoningSummary !== undefined ? { reasoningSummary: options.reasoningSummary } : {}),
		...(options?.promptCacheOptions !== undefined ? { promptCacheOptions: options.promptCacheOptions } : {}),
		...(options?.explicitDeveloperCacheBreakpoint !== undefined
			? { explicitDeveloperCacheBreakpoint: options.explicitDeveloperCacheBreakpoint }
			: {}),
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
		loopIncomingToolPlan: options?.loopIncomingToolPlan,
	});
};

function prepareResponsesPayload(
	payload: unknown,
	config: {
		isPlatform: boolean;
		shouldInjectBreakpoint: boolean;
		promptCacheOptions: OpenAIPromptCacheOptions | undefined;
	},
): unknown {
	if (!isRecord(payload)) return payload;
	let next: Record<string, unknown> = payload;

	if (!config.isPlatform) {
		if ("prompt_cache_options" in next) {
			const { prompt_cache_options: _dropped, ...rest } = next;
			next = rest;
		}
	} else if (config.promptCacheOptions !== undefined) {
		const merged = isRecord(next.prompt_cache_options)
			? { ...next.prompt_cache_options, ...config.promptCacheOptions }
			: { ...config.promptCacheOptions };
		next = { ...next, prompt_cache_options: merged };
	}

	if (config.shouldInjectBreakpoint && Array.isArray(next.input)) {
		let injected = false;
		const input = next.input.map((item) => {
			if (injected || !isRecord(item) || item.role !== "developer" || item.type === "additional_tools") {
				return item;
			}
			injected = true;
			if (typeof item.content !== "string" || item.content.length === 0) return item;
			return {
				...item,
				content: [{
					type: "input_text",
					text: item.content,
					prompt_cache_breakpoint: { mode: "explicit" },
				}],
			};
		});
		next = { ...next, input };
	}

	return next;
}

async function relayResponsesStream(
	relay: AssistantMessageEventStream,
	source: AssistantMessageEventStream,
	model: Model<"openai-responses">,
	resolveServiceTier: () => string | null | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	let terminal: AssistantMessage | undefined;
	let scaled = false;
	const scaleIfUltrafast = (message: AssistantMessage): void => {
		if (scaled) return;
		scaled = true;
		if (resolveServiceTier() === "ultrafast") {
			scaleUsageCost(message.usage, 3);
		}
	};

	try {
		for await (const event of source) {
			if (event.type === "done") {
				scaleIfUltrafast(event.message);
				terminal = event.message;
			} else if (event.type === "error") {
				terminal = event.error;
			}
			relay.push(event);
		}
		const finalMessage = terminal ?? await source.result();
		if (finalMessage.stopReason !== "error" && finalMessage.stopReason !== "aborted") {
			scaleIfUltrafast(finalMessage);
		}
		relay.end(finalMessage);
	} catch (error) {
		const failure = initialAssistantMessage(model);
		failure.stopReason = signal?.aborted ? "aborted" : "error";
		failure.errorMessage = error instanceof Error ? error.message : String(error);
		relay.push({ type: "error", reason: failure.stopReason, error: failure });
		relay.end(failure);
	}
}

/** Responses adapter for models the catalog compiled onto {@link OPENAI_COMPUTER_USE_API}, i.e. those whose selected tools include OpenAI's native computer. */
export const streamOpenAIComputerUse: StreamFunction<
	typeof OPENAI_COMPUTER_USE_API,
	OpenAIResponsesOptions | LoopOpenAISimpleStreamOptions
> = (model, context, options) =>
	streamOpenAINativeComputer(model as unknown as Model<"openai-responses">, context, options);

function streamOpenAINativeComputer(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | LoopOpenAISimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = initialAssistantMessage(model);
	void runNativeComputer(stream, output, model, context, options);
	return stream;
}

async function runNativeComputer(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | LoopOpenAISimpleStreamOptions | undefined,
): Promise<void> {
	try {
		const apiKey = openAIApiKey(options);
		const nativeName = options?.loopIncomingToolPlan?.openaiComputerName;
		if (!nativeName) throw new Error("OpenAI native computer incoming plan is missing");

		const compat = model.compat;
		const normalized = resolveTranscript(context, compat?.supportsMidConvoSystemMessages);
		const toolSupport = compat?.supportsToolSearch ? "additions" : "none";
		const transcriptTools = resolveTranscriptTools(normalized.messages, toolSupport);
		const envBaseUrl = options?.env?.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL;
		const isPlatform = isOpenAIPlatformBaseUrl(model.baseUrl, envBaseUrl);
		const retention = cacheRetention(options);
		const requestedEffort = resolveRequestedEffort(model, options);
		const configurationUpdateEffort =
			compat?.supportsMidConvoEffort && requestedEffort && !isChatGPTSignIn(model, apiKey)
				? (model.thinkingLevelMap?.[requestedEffort] ?? requestedEffort)
				: undefined;
		if (configurationUpdateEffort !== undefined) {
			output.providerThinkingLevel = configurationUpdateEffort;
		}

		let payload: Record<string, unknown> = {
			model: model.id,
			input: convertNativeComputerMessages(model, normalized.messages, nativeName, {
				toolSupport,
				foldedSystemMessages: transcriptTools.foldedSystemMessages,
				isPlatform,
				cacheRetention: retention,
				explicitDeveloperCacheBreakpoint: options?.explicitDeveloperCacheBreakpoint,
				configurationUpdateEffort,
			}),
			stream: true,
			max_output_tokens: Math.max(options?.maxTokens ?? model.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS),
			...promptCacheFields(model, options, isPlatform),
			store: false,
		};
		if (transcriptTools.requestTools.length > 0) {
			payload.tools = convertTools(transcriptTools.requestTools);
		}
		if (options?.temperature !== undefined) payload.temperature = options.temperature;
		const serviceTier = (options as OpenAIResponsesOptions | undefined)?.serviceTier;
		if (serviceTier !== undefined) payload.service_tier = serviceTier;
		const toolChoice = (options as OpenAIResponsesOptions | undefined)?.toolChoice;
		if (toolChoice !== undefined) payload.tool_choice = toolChoice;
		applyNativeReasoningParams(payload, model, requestedEffort, (options as OpenAIResponsesOptions | undefined)?.reasoningSummary, configurationUpdateEffort);

		payload = ((await options?.onPayload?.(payload, model)) ?? payload) as Record<string, unknown>;
		const client = createOpenAIClient(model, options, apiKey);
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: 0,
		};
		const { data: openaiStream, response: rawResponse } = await retryProviderRequest(
			() => client.responses.create(payload as never, requestOptions).withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);
		if (options?.signal?.aborted) throw new Error("Request was aborted");

		stream.push({ type: "start", partial: output });
		await processNativeComputerStream(
			openaiStream as unknown as AsyncIterable<ResponseStreamEvent>,
			output,
			stream,
			model,
			nativeName,
			options,
		);
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		if (output.stopReason === "pending") {
			throw new Error("OpenAI Responses stream ended without a stop reason");
		}
		if (output.stopReason === "error" || output.stopReason === "aborted") {
			throw new Error(output.errorMessage || "OpenAI response ended unsuccessfully");
		}
		stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		stream.end(output);
	} catch (error) {
		for (const block of output.content) delete (block as ToolCall & { partialJson?: string }).partialJson;
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end(output);
	}
}

function resolveRequestedEffort(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | LoopOpenAISimpleStreamOptions | undefined,
): ThinkingLevel | undefined {
	const responsesEffort = (options as OpenAIResponsesOptions | undefined)?.reasoningEffort;
	if (responsesEffort) return responsesEffort;
	const simpleReasoning = (options as LoopOpenAISimpleStreamOptions | undefined)?.reasoning;
	if (!simpleReasoning) return undefined;
	const clamped = clampThinkingLevel(model, simpleReasoning);
	return clamped === "off" ? undefined : clamped;
}

function applyNativeReasoningParams(
	payload: Record<string, unknown>,
	model: Model<"openai-responses">,
	requestedEffort: ThinkingLevel | undefined,
	reasoningSummary: OpenAIResponsesOptions["reasoningSummary"],
	configurationUpdateEffort: string | undefined,
): void {
	if (!model.reasoning) return;
	const effortSource = requestedEffort ?? (reasoningSummary ? "medium" : undefined);
	if (effortSource) {
		const mappedEffort = requestedEffort
			? (model.thinkingLevelMap?.[requestedEffort] ?? requestedEffort)
			: effortSource;
		const effort = configurationUpdateEffort === undefined ? mappedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
		payload.reasoning = { effort, summary: reasoningSummary || "auto" };
		payload.include = ["reasoning.encrypted_content"];
	} else if (model.thinkingLevelMap?.off !== null) {
		payload.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}
}

type NativeStreamSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: ToolCall; contentIndex: number; argsStream?: ToolCallArgumentsStream; kind: "function" | "computer" };

async function processNativeComputerStream(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-responses">,
	nativeName: string,
	options: OpenAIResponsesOptions | LoopOpenAISimpleStreamOptions | undefined,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, NativeStreamSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const unfinishedToolCalls = new Set<ToolCall>();

	const getSlot = <T extends NativeStreamSlot["type"]>(
		outputIndex: number,
		type: T,
	): Extract<NativeStreamSlot, { type: T }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<NativeStreamSlot, { type: T }>) : undefined;
	};

	const createSlot = (outputIndex: number, item: unknown): NativeStreamSlot | undefined => {
		if (!isRecord(item)) return undefined;
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot: NativeStreamSlot = { type: "thinking", block, contentIndex: output.content.length - 1 };
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			if (item.phase === "final_answer") output.stopReason = "stop";
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot: NativeStreamSlot = { type: "text", block, contentIndex: output.content.length - 1 };
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const argsStream = new ToolCallArgumentsStream();
			const callId = readString(item, "call_id");
			const itemId = readString(item, "id");
			const compoundId = formatCompoundCallId(callId, itemId);
			const namespace = readString(item, "namespace");
			const argsText = readString(item, "arguments");
			const block: ToolCall = {
				type: "toolCall",
				id: compoundId,
				name: readString(item, "name"),
				arguments: argsText ? argsStream.append(argsText) : {},
				...(namespace ? { namespace } : {}),
			};
			output.content.push(block);
			unfinishedToolCalls.add(block);
			const slot: NativeStreamSlot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
				argsStream,
				kind: "function",
			};
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "computer_call") {
			const block = parseComputerCallItem(item, nativeName);
			output.content.push(block);
			unfinishedToolCalls.add(block);
			const slot: NativeStreamSlot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
				kind: "computer",
			};
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};

	const getOrCreateSlot = (outputIndex: number, item: unknown): NativeStreamSlot | undefined =>
		outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);

	const backfillReasoningSignatures = (responseOutput: unknown[]): void => {
		for (const item of responseOutput) {
			if (!isRecord(item) || item.type !== "reasoning" || typeof item.encrypted_content !== "string") continue;
			const block = typeof item.id === "string" ? reasoningBlocksById.get(item.id) : undefined;
			if (!block?.thinkingSignature) continue;
			const storedItem = JSON.parse(block.thinkingSignature) as Record<string, unknown>;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({ ...storedItem, encrypted_content: item.encrypted_content });
		}
	};

	const finalizeResponse = (response: unknown): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(readArray(response, "output"));
		const id = readString(response, "id");
		if (id) output.responseId = id;
		output.usage = usageFromResponse(readValue(response, "usage"));
		calculateCost(model, output.usage);
		const echoedTier = readString(response, "service_tier") || undefined;
		const requestTier = (options as OpenAIResponsesOptions | undefined)?.serviceTier;
		applyServiceTierPricing(output.usage, (echoedTier ?? requestTier) as OpenAIResponsesOptions["serviceTier"], model);

		const status = readString(response, "status") || undefined;
		const incompleteDetails = readValue(response, "incomplete_details");
		const incompleteReason = isRecord(incompleteDetails) && typeof incompleteDetails.reason === "string"
			? incompleteDetails.reason
			: undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		if (mappedStop.errorMessage === undefined) delete output.errorMessage;
		else output.errorMessage = mappedStop.errorMessage;
		if (output.content.some((part) => part.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const rawEvent of openaiStream) {
		await options?.onProviderStreamEvent?.(rawEvent, model);
		const event = rawEvent as unknown as Record<string, unknown>;
		const eventType = readString(event, "type");
		if (eventType === "response.created") {
			const id = readString(readValue(event, "response"), "id");
			if (id) output.responseId = id;
		} else if (eventType === "response.output_item.added") {
			createSlot(readNumber(event, "output_index"), readValue(event, "item"));
		} else if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") {
			const slot = getSlot(readNumber(event, "output_index"), "thinking");
			if (!slot) continue;
			const delta = readString(event, "delta");
			slot.block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta, partial: output });
		} else if (eventType === "response.reasoning_summary_part.done") {
			const slot = getSlot(readNumber(event, "output_index"), "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({ type: "thinking_delta", contentIndex: slot.contentIndex, delta: "\n\n", partial: output });
		} else if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
			const slot = getSlot(readNumber(event, "output_index"), "text");
			if (!slot) continue;
			const delta = readString(event, "delta");
			slot.block.text += delta;
			stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta, partial: output });
		} else if (eventType === "response.function_call_arguments.delta") {
			const slot = getSlot(readNumber(event, "output_index"), "toolCall");
			if (!slot || slot.kind !== "function" || !slot.argsStream) continue;
			const delta = readString(event, "delta");
			slot.block.arguments = slot.argsStream.append(delta);
			stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta, partial: output });
		} else if (eventType === "response.function_call_arguments.done") {
			const slot = getSlot(readNumber(event, "output_index"), "toolCall");
			if (!slot || slot.kind !== "function" || !slot.argsStream) continue;
			const replaced = slot.argsStream.replace(readString(event, "arguments"));
			slot.block.arguments = replaced.arguments;
			if (replaced.delta !== undefined) {
				stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta: replaced.delta, partial: output });
			}
		} else if (eventType === "response.output_item.done") {
			const outputIndex = readNumber(event, "output_index");
			const item = readValue(event, "item");
			if (!isRecord(item)) continue;
			if (item.type === "message" && item.phase === "final_answer") output.stopReason = "stop";
			const slot = getOrCreateSlot(outputIndex, item);
			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = readArray(item, "summary")
					.map((entry) => readString(entry, "text"))
					.filter(Boolean)
					.join("\n\n");
				const contentText = readArray(item, "content")
					.map((entry) => readString(entry, "text"))
					.filter(Boolean)
					.join("\n\n");
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				const itemId = readString(item, "id");
				if (itemId) reasoningBlocksById.set(itemId, slot.block);
				stream.push({ type: "thinking_end", contentIndex: slot.contentIndex, content: slot.block.thinking, partial: output });
				outputSlots.delete(outputIndex);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = readArray(item, "content")
					.map((block) => (readString(block, "type") === "output_text" ? readString(block, "text") : readString(block, "refusal")))
					.join("");
				const itemId = readString(item, "id");
				const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
				if (itemId) {
					slot.block.textSignature = JSON.stringify({ v: 1, id: itemId, ...(phase ? { phase } : {}) });
				}
				stream.push({ type: "text_end", contentIndex: slot.contentIndex, content: slot.block.text, partial: output });
				outputSlots.delete(outputIndex);
			} else if (item.type === "function_call" && slot?.type === "toolCall" && slot.kind === "function" && slot.argsStream) {
				const rawArgs = readString(item, "arguments");
				if (rawArgs) slot.argsStream.replace(rawArgs);
				Object.assign(slot.block, slot.argsStream.finish());
				const namespace = readString(item, "namespace");
				if (namespace) slot.block.namespace = namespace;
				unfinishedToolCalls.delete(slot.block);
				stream.push({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: slot.block, partial: output });
				outputSlots.delete(outputIndex);
			} else if (item.type === "computer_call" && slot?.type === "toolCall" && slot.kind === "computer") {
				const parsed = parseComputerCallItem(item, nativeName);
				slot.block.id = parsed.id;
				slot.block.arguments = parsed.arguments;
				unfinishedToolCalls.delete(slot.block);
				stream.push({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: slot.block, partial: output });
				outputSlots.delete(outputIndex);
			}
		} else if (eventType === "response.completed" || eventType === "response.incomplete") {
			finalizeResponse(readValue(event, "response"));
		} else if (eventType === "error") {
			throw new Error(`Error Code ${readString(event, "code")}: ${readString(event, "message")}` || "Unknown error");
		} else if (eventType === "response.failed") {
			sawTerminalResponseEvent = true;
			const resp = readValue(event, "response");
			output.rawStopReason = readString(resp, "status") || undefined;
			const errorObj = readValue(resp, "error");
			const details = readValue(resp, "incomplete_details");
			const msg = isRecord(errorObj)
				? `${readString(errorObj, "code") || "unknown"}: ${readString(errorObj, "message") || "no message"}`
				: isRecord(details) && typeof details.reason === "string"
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}

	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
	if (output.stopReason === "toolUse" && unfinishedToolCalls.size > 0) {
		const [first] = unfinishedToolCalls;
		throw new Error(`OpenAI Responses stream completed with an unfinished tool call: ${first!.name} (${first!.id})`);
	}
}

function parseComputerCallItem(item: Record<string, unknown>, nativeName: string): ToolCall {
	const callId = readString(item, "call_id");
	const itemId = readString(item, "id");
	const rawActions = readArray(item, "actions");
	const rawAction = readValue(item, "action");
	const actions = (rawActions.length > 0 ? rawActions : rawAction !== undefined ? [rawAction] : []) as JsonValue[];
	const pendingSafetyChecks = readArray(item, "pending_safety_checks") as JsonValue[];
	return {
		type: "toolCall",
		id: formatCompoundCallId(callId, itemId),
		name: nativeName,
		arguments: {
			actions,
			...(pendingSafetyChecks.length > 0 ? { pending_safety_checks: pendingSafetyChecks } : {}),
		} as JsonObject,
	};
}

function formatCompoundCallId(callId: string, itemId: string): string {
	if (callId && itemId && itemId !== callId) return `${callId}|${itemId}`;
	return callId || itemId;
}

function splitCompoundCallId(id: string): [string, string | undefined] {
	const separator = id.indexOf("|");
	if (separator < 0) return [id, undefined];
	return [id.slice(0, separator), id.slice(separator + 1) || undefined];
}

function normalizeWireClickButton(button: unknown): "left" | "wheel" | "right" | "back" | "forward" {
	if (button === undefined || button === null || button === "") return "left";
	if (button === "middle" || button === 2) return "wheel";
	if (button === 1) return "left";
	if (button === 3) return "right";
	if (button === 4) return "back";
	if (button === 5) return "forward";
	if (button === "left" || button === "wheel" || button === "right" || button === "back" || button === "forward") {
		return button;
	}
	return "left";
}

function toWireComputerAction(action: unknown): unknown {
	if (!isRecord(action)) return action;
	if (action.type === "click") {
		return { ...action, button: normalizeWireClickButton(action.button) };
	}
	if (action.type === "double_click") {
		const { button: _button, ...rest } = action;
		return rest;
	}
	return action;
}

function promptCacheFields(
	model: Model<"openai-responses">,
	options: OpenAIRequestOptions | undefined,
	isPlatform: boolean,
): Record<string, unknown> {
	const compat = model.compat;
	const retention = cacheRetention(options);
	let promptCacheOptions: Record<string, unknown> | undefined;
	if (isPlatform) {
		if (options?.promptCacheOptions !== undefined) {
			promptCacheOptions = { ...options.promptCacheOptions };
		} else if (compat?.supportsExplicitPromptCacheMode) {
			if (retention === "none") promptCacheOptions = { mode: "explicit" };
			else if (retention === "long" && compat.supportsLongCacheRetention !== false) promptCacheOptions = { ttl: "30m" };
		}
	}
	return {
		prompt_cache_key: retention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention:
			retention === "long" && compat?.supportsLongCacheRetention !== false && !compat?.supportsExplicitPromptCacheMode
				? "24h"
				: undefined,
		prompt_cache_options: promptCacheOptions,
	};
}

function createOpenAIClient(
	model: Model<"openai-responses">,
	options: OpenAIRequestOptions | undefined,
	apiKey: string,
): OpenAI {
	const headers: Record<string, string | null> = { ...model.headers, ...options?.headers };
	if (cacheRetention(options) !== "none" && options?.sessionId) {
		headers.session_id = options.sessionId;
		headers["x-client-request-id"] = options.sessionId;
	}
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl || "https://api.openai.com/v1",
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
	});
}

function openAIApiKey(options: OpenAIRequestOptions | undefined): string {
	const apiKey = options?.apiKey || options?.env?.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
	if (apiKey) return apiKey;
	const hasAuthorization = Object.entries(options?.headers ?? {}).some(([name, value]) =>
		(name.toLowerCase() === "authorization" || name.toLowerCase() === "cf-aig-authorization") && typeof value === "string" && value.trim(),
	);
	if (hasAuthorization) return "unused";
	throw new Error("No API key for provider: openai");
}

function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

function cacheRetention(options: OpenAIRequestOptions | undefined): "none" | "short" | "long" {
	if (options?.cacheRetention) return options.cacheRetention;
	return (options?.env?.PI_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}

function convertNativeComputerMessages(
	model: Model<"openai-responses">,
	messages: readonly Message[],
	nativeName: string,
	options: {
		toolSupport: "additions" | "none";
		foldedSystemMessages: number;
		isPlatform: boolean;
		cacheRetention: "none" | "short" | "long";
		explicitDeveloperCacheBreakpoint: boolean | undefined;
		configurationUpdateEffort: string | undefined;
	},
): Record<string, unknown>[] {
	const input: Record<string, unknown>[] = [];
	const compat = model.compat;
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
	const useExplicitBreakpoint =
		compat?.supportsExplicitPromptCacheMode === true &&
		options.isPlatform &&
		options.cacheRetention !== "none" &&
		options.explicitDeveloperCacheBreakpoint !== false;

	let systemIndex = 0;
	let toolLoadCounter = 0;

	const pushConfigurationUpdate = (effort: string): void => {
		input.push({ type: "configuration_update", reasoning: { effort } });
	};

	for (let msgIndex = 0; msgIndex < messages.length; msgIndex += 1) {
		const message = messages[msgIndex]!;
		const isLeadingSystemMessage = msgIndex === 0 && message.role === "system";

		if (message.role === "system") {
			const anchorsToolChanges = systemIndex++ >= options.foldedSystemMessages;
			if (anchorsToolChanges && options.toolSupport === "additions" && (message.toolsAdded?.length ?? 0) > 0) {
				const added = message.toolsAdded!;
				const callId = `loop_tool_load_${++toolLoadCounter}`;
				input.push({
					type: "tool_search_call",
					call_id: callId,
					execution: "client",
					status: "completed",
					arguments: { query: added.map((tool) => tool.name).join(" "), limit: added.length },
				});
				input.push({
					type: "tool_search_output",
					call_id: callId,
					execution: "client",
					status: "completed",
					tools: convertTools(added, true),
				});
			}
			const text = isLeadingSystemMessage
				? getSystemMessageText(message)
				: renderSystemMessageUpdateWithRemovals(message, anchorsToolChanges);
			if (text.length > 0) {
				if (isLeadingSystemMessage && useExplicitBreakpoint) {
					input.push({
						role: instructionRole,
						content: [{ type: "input_text", text, prompt_cache_breakpoint: { mode: "explicit" } }],
					});
				} else {
					input.push({ role: instructionRole, content: text });
				}
			}
			continue;
		}

		if (message.role === "user") {
			input.push({ role: "user", content: convertUserContent(message.content) });
			continue;
		}

		if (message.role === "assistant") {
			const items: Record<string, unknown>[] = [];
			const isSameModel = message.provider === model.provider && message.model === model.id;
			for (const part of message.content) {
				if (part.type === "thinking") {
					if (part.thinkingSignature) {
						try {
							const parsed: unknown = JSON.parse(part.thinkingSignature);
							if (isRecord(parsed)) items.push(parsed);
						} catch {
							// Ignore malformed legacy signature.
						}
					}
					continue;
				}
				if (part.type === "text") {
					if (part.text) {
						items.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
					}
					continue;
				}
				if (part.type !== "toolCall") continue;
				const [callId, itemId] = splitCompoundCallId(part.id);
				if (part.name === nativeName) {
					const rawActions = Array.isArray(part.arguments.actions)
						? part.arguments.actions
						: part.arguments.action !== undefined
							? [part.arguments.action]
							: [];
					const actions = rawActions.map(toWireComputerAction);
					const pendingSafetyChecks = Array.isArray(part.arguments.pending_safety_checks)
						? part.arguments.pending_safety_checks
						: [];
					items.push({
						type: "computer_call",
						...(isSameModel && itemId?.startsWith("cu_") ? { id: itemId } : {}),
						call_id: callId,
						actions,
						...(pendingSafetyChecks.length > 0 ? { pending_safety_checks: pendingSafetyChecks } : {}),
					});
				} else {
					const namespace = toolCallNamespace(part);
					items.push({
						type: "function_call",
						...(isSameModel && itemId?.startsWith("fc_") ? { id: itemId } : {}),
						call_id: callId,
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
						...(isSameModel && namespace ? { namespace } : {}),
					});
				}
			}
			if (items.length === 0) continue;
			if (options.configurationUpdateEffort !== undefined && isSameModel && message.providerThinkingLevel !== undefined) {
				pushConfigurationUpdate(message.providerThinkingLevel);
			}
			input.push(...items);
			continue;
		}

		if (message.role !== "toolResult") continue;
		const [callId] = splitCompoundCallId(message.toolCallId);
		const text = message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n").trim();
		if (message.toolName === nativeName) {
			const image = [...message.content].reverse().find((part): part is ImageContent => part.type === "image");
			const safetyChecks = acknowledgedSafetyChecks(messages, callId);
			input.push({
				type: "computer_call_output",
				call_id: callId,
				// `computer_screenshot` accepts image_url or file_id and nothing else.
				// A blank screenshot keeps the item valid when an action produced no
				// screenshot; the text follows as a user message so the model still learns
				// what happened.
				output: {
					type: "computer_screenshot",
					image_url: image ? `data:${image.mimeType};base64,${image.data}` : BLANK_SCREENSHOT_DATA_URL,
				},
				...(safetyChecks.length > 0 ? { acknowledged_safety_checks: safetyChecks } : {}),
			});
			if (!image) {
				const detail = text || (message.isError ? "tool execution failed" : "no screenshot was captured");
				input.push({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: `[computer action produced no screenshot] ${detail}` }],
				});
			}
		} else {
			input.push({ type: "function_call_output", call_id: callId, output: message.isError ? `Error: ${text}` : text || "ok" });
		}
	}

	if (options.configurationUpdateEffort !== undefined) {
		pushConfigurationUpdate(options.configurationUpdateEffort);
	}
	return input;
}

function renderSystemMessageUpdateWithRemovals(message: SystemMessage, anchorsToolChanges: boolean): string {
	const parts: string[] = [];
	const update = renderSystemMessageUpdate(message);
	if (update.length > 0) parts.push(update);
	if (anchorsToolChanges) {
		const added = new Set((message.toolsAdded ?? []).map((tool) => tool.name));
		const removed = (message.toolsRemoved ?? []).map((tool) => tool.name).filter((name) => !added.has(name));
		if (removed.length > 0) {
			parts.push(`The following tools are no longer available. Do not call them:\n${removed.map((name) => `- ${name}`).join("\n")}`);
		}
	}
	return parts.join("\n\n");
}

function acknowledgedSafetyChecks(messages: readonly Message[], targetCallId: string): unknown[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		const call = message.content.find(
			(part) => part.type === "toolCall" && splitCompoundCallId(part.id)[0] === targetCallId,
		);
		if (call?.type === "toolCall" && Array.isArray(call.arguments.pending_safety_checks)) {
			return call.arguments.pending_safety_checks;
		}
	}
	return [];
}

function convertTools(tools: readonly Tool[], deferLoading = false): Record<string, unknown>[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(deferLoading ? { defer_loading: true } : {}),
	}));
}

function convertUserContent(content: string | Array<TextContent | ImageContent>): Array<Record<string, unknown>> {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((part) => part.type === "text"
		? { type: "input_text", text: part.text }
		: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" });
}

function toolCallNamespace(call: ToolCall | undefined): string | undefined {
	const namespace = (call as ToolCall & { namespace?: unknown } | undefined)?.namespace;
	return typeof namespace === "string" && namespace ? namespace : undefined;
}

function applyServiceTierPricing(
	usage: AssistantMessage["usage"],
	serviceTier: OpenAIResponsesOptions["serviceTier"] | string | undefined,
	model: Model<"openai-responses">,
): void {
	const multiplier =
		serviceTier === "flex"
			? 0.5
			: serviceTier === "priority" || serviceTier === "fast"
				? (model.id === "gpt-5.5" ? 2.5 : 2)
				: serviceTier === "ultrafast"
					? 3
					: 1;
	if (multiplier === 1) return;
	scaleUsageCost(usage, multiplier);
}

function scaleUsageCost(usage: AssistantMessage["usage"], multiplier: number): void {
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total *= multiplier;
}

function mapStopReason(
	status: string | undefined,
	incompleteReason: string | undefined,
): { stopReason: AssistantMessage["stopReason"]; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	if (status === "completed" || status === "in_progress" || status === "queued") {
		return { stopReason: "stop" };
	}
	if (status === "incomplete") {
		if (incompleteReason === "max_output_tokens") return { stopReason: "length" };
		return {
			stopReason: "error",
			errorMessage: incompleteReason
				? `Response incomplete: ${incompleteReason}`
				: "Response incomplete without a provider reason",
		};
	}
	if (status === "failed" || status === "cancelled") {
		return { stopReason: "error" };
	}
	return { stopReason: "stop" };
}

function initialAssistantMessage(model: Model<string>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function usageFromResponse(usage: unknown): AssistantMessage["usage"] {
	const input = readNumber(usage, "input_tokens");
	const output = readNumber(usage, "output_tokens");
	const inputDetails = readValue(usage, "input_tokens_details");
	const cacheRead = readNumber(inputDetails, "cached_tokens");
	const cacheWrite = readNumber(inputDetails, "cache_write_tokens");
	const outputDetails = readValue(usage, "output_tokens_details");
	const reasoning = readNumber(outputDetails, "reasoning_tokens");
	const totalTokens = readNumber(usage, "total_tokens") || input + output;
	return {
		input: Math.max(0, input - cacheRead - cacheWrite),
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function headersToRecord(headers: Headers): Record<string, string> {
	const output: Record<string, string> = {};
	headers.forEach((value, key) => { output[key] = value; });
	return output;
}

function readArray(value: unknown, key: string): unknown[] {
	const entry = readValue(value, key);
	return Array.isArray(entry) ? entry : [];
}

function readString(value: unknown, key: string): string {
	const entry = readValue(value, key);
	return typeof entry === "string" ? entry : "";
}

function readNumber(value: unknown, key: string): number {
	const entry = readValue(value, key);
	return typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
}

function readValue(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
