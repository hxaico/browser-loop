import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	isRetryableAssistantError,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Model,
	type Models,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { delegateModels } from "./models-delegate";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Controls Loop retries around a single provider request.
 * Enabling provider request retries as well can multiply network attempts.
 */
export interface LoopRetryOptions {
	/** Enable Loop-level retries. Disabled by default. */
	enabled?: boolean;
	/** Number of additional provider requests. Defaults to 3. */
	maxRetries?: number;
	/** Initial delay in milliseconds; subsequent delays double. Defaults to 2000. */
	baseDelayMs?: number;
}

interface ResolvedRetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

type RetryStreamFn<TContext extends Context | TranscriptContext> = (
	model: Model<Api>,
	context: TContext,
	options?: SimpleStreamOptions,
) => ReturnType<typeof createAssistantMessageEventStream> | Promise<ReturnType<typeof createAssistantMessageEventStream>>;

export function resolveProviderRetryPolicy(options?: LoopRetryOptions): ResolvedRetryPolicy {
	const enabled = options?.enabled ?? false;
	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

	if (typeof enabled !== "boolean") throw new TypeError("retry.enabled must be a boolean");
	if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
		throw new RangeError("retry.maxRetries must be a non-negative safe integer");
	}
	if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
		throw new RangeError("retry.baseDelayMs must be a finite non-negative number");
	}
	if (enabled && maxRetries > 0 && baseDelayMs > 0) {
		const largestDelay = baseDelayMs * 2 ** (maxRetries - 1);
		if (!Number.isFinite(largestDelay) || largestDelay > MAX_TIMER_DELAY_MS) {
			throw new RangeError(`retry delay must not exceed ${MAX_TIMER_DELAY_MS}ms`);
		}
	}

	return { enabled, maxRetries, baseDelayMs };
}

function retryStream<TContext extends Context | TranscriptContext>(
	streamFn: RetryStreamFn<TContext>,
	policy: ResolvedRetryPolicy,
): (
	model: Model<Api>,
	context: TContext,
	options?: SimpleStreamOptions,
) => ReturnType<typeof createAssistantMessageEventStream> {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void runWithRetry(output, streamFn, model, context, options, policy);
		return output;
	};
}

export function withProviderRetry(streamFn: StreamFn, policy: ResolvedRetryPolicy): StreamFn {
	if (!policy.enabled || policy.maxRetries === 0) return streamFn;
	return retryStream<TranscriptContext>(streamFn, policy);
}

export function withProviderRetryModels(models: Models, policy: ResolvedRetryPolicy): Models {
	if (!policy.enabled || policy.maxRetries === 0) return models;

	const streamSimple = retryStream<Context>(
		(model, context, options) => models.streamSimple(model, context, options),
		policy,
	);
	return delegateModels(models, {
		streamSimple,
		completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
	});
}

async function runWithRetry<TContext extends Context | TranscriptContext>(
	output: ReturnType<typeof createAssistantMessageEventStream>,
	streamFn: RetryStreamFn<TContext>,
	model: Model<Api>,
	context: TContext,
	options: SimpleStreamOptions | undefined,
	policy: ResolvedRetryPolicy,
): Promise<void> {
	let settled = false;
	const settle = (message: AssistantMessage, events?: AssistantMessageEvent[]) => {
		if (settled) return;
		settled = true;
		let terminalEmitted = false;
		let result = message;
		try {
			if (events) {
				for (const event of events) {
					output.push(event);
					if (terminalMessage(event)) terminalEmitted = true;
				}
			}
			if (!terminalEmitted) {
				output.push({ type: "start", partial: structuredClone(message) });
				output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			}
		} catch (error) {
			if (!terminalEmitted) {
				result = createFailureMessage(model, `Failed to replay provider response: ${errorMessage(error)}`);
				try {
					output.push({ type: "error", reason: "error", error: result });
				} catch {
					// end(result) still settles result() and any waiting iterator.
				}
			}
		} finally {
			output.end(result);
		}
	};

	for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
		if (options?.signal?.aborted) {
			settle(createFailureMessage(model, "Request aborted", "aborted"));
			return;
		}

		// Buffering is opt-in because pi has no way to retract deltas from a failed attempt.
		let events: AssistantMessageEvent[] = [];
		let message: AssistantMessage | undefined;
		try {
			const input = await streamFn(model, context, options);
			try {
				for await (const event of input) {
					try {
						events.push(structuredClone(event));
					} catch (error) {
						throw new SnapshotError(errorMessage(error));
					}
					message = terminalMessage(event);
					if (message) break;
				}
			} catch (error) {
				if (error instanceof SnapshotError) {
					settle(createFailureMessage(model, error.message));
					return;
				}
				throw error;
			}
			if (!message) {
				settle(createFailureMessage(model, "Provider stream ended without a terminal event"));
				return;
			}
		} catch (error) {
			message = createFailureMessage(model, errorMessage(error));
			events = [];
		}

		if (!shouldRetry(message, model, attempt, policy, options?.signal)) {
			settle(message, events);
			return;
		}

		events = [];
		try {
			if (!(await wait(policy.baseDelayMs * 2 ** attempt, options?.signal))) {
				settle(createFailureMessage(model, "Request aborted", "aborted"));
				return;
			}
		} catch (error) {
			settle(createFailureMessage(model, errorMessage(error)));
			return;
		}
	}
}

function shouldRetry(
	message: AssistantMessage,
	model: Model<Api>,
	attempt: number,
	policy: ResolvedRetryPolicy,
	signal: AbortSignal | undefined,
): boolean {
	return (
		message.stopReason === "error" &&
		!isContextOverflow(message, model.contextWindow) &&
		isRetryableAssistantError(message) &&
		attempt < policy.maxRetries &&
		!signal?.aborted
	);
}

function terminalMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return undefined;
}

function createFailureMessage(
	model: Model<Api>,
	message: string,
	stopReason: "error" | "aborted" = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class SnapshotError extends Error {}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
