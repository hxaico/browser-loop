import {
	envApiKeyAuth,
	isModelType,
	type Api,
	type CreateModelsOptions,
	type Model,
	type MutableModels,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loopApiKeyEnvVarsForProvider } from "./api-keys";
import { patchOpenAILoopModels } from "./models";
import { withAnthropicToolsets } from "./providers/anthropic/toolsets";
import { GOOGLE_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions } from "./providers/google/provider";
import {
	isOpenAIPlatformBaseUrl,
	OPENAI_COMPUTER_USE_API,
	streamOpenAIComputerUse,
	streamOpenAIResponses,
	streamSimpleOpenAIResponses,
	type LoopOpenAISimpleStreamOptions,
	type OpenAIPromptCacheOptions,
	type OpenAIPromptCacheTtl,
	type OpenAIResponsesOptions,
} from "./providers/openai/provider";

/**
 * Build the pi `Models` collection Loop streams through: pi's builtin
 * providers, adjusted for Loop:
 *
 * - `anthropic` adapts pi's function-tool transcript to the computer and
 *   browser client-toolset protocol, including member names and toolset results.
 * - `openai` patches Loop's GPT-6.x / 6.2 catalog overrides, wraps pi's builtin
 *   `openai-responses` transport for platform-gated explicit prompt-cache
 *   breakpoints and `"ultrafast"` pricing, and routes models compiled onto
 *   `openai-computer-use` to Loop's native computer adapter.
 * - `google` intercepts `google-interactions` — carried only by a model
 *   compiled with Google's native computer-use toolset — for current native
 *   computer use, and resolves API keys from `GOOGLE_API_KEY` or `GEMINI_API_KEY`.
 *   A Google model compiled without that toolset streams through pi's builtin
 *   Google transport instead.
 * - `xai` is pi's builtin provider untouched: Grok streams through pi's
 *   Responses transport, and the catalog supplies its serial-tool-call field.
 * - `moonshotai` is pi's builtin provider untouched: Kimi streams through the
 *   plain OpenAI-compatible chat completions transport with `MOONSHOT_API_KEY`.
 * Each call returns an independent collection; register additional providers
 * or credentials on it freely. Use {@link loopModels} for the shared default.
 */
export function createLoopModels(options?: CreateModelsOptions): MutableModels {
	const models = builtinModels(options);
	const anthropic = models.getProvider("anthropic");
	if (anthropic) models.setProvider(withAnthropicToolsets(anthropic));
	const openai = models.getProvider("openai");
	if (openai) models.setProvider(withOpenAIComputerUseAdapter(openai));
	const google = models.getProvider("google");
	if (google) models.setProvider(withGoogleInteractions(google));
	return models;
}

let defaultLoopModels: MutableModels | undefined;

/**
 * Shared default {@link createLoopModels} collection, created on first use.
 *
 * `attach()` streams through this instance unless given another one. Auth
 * resolves from the documented env-var convention (see
 * `loopApiKeyEnvVarsForProvider`); pass an explicit `options.apiKey` per
 * request to override.
 */
export function loopModels(): MutableModels {
	return (defaultLoopModels ??= createLoopModels());
}

function withOpenAIComputerUseAdapter(base: Provider): Provider {
	return {
		...base,
		getModels: () => patchOpenAILoopModels(base.getModels()),
		getAllModels: () => {
			const all = base.getAllModels?.() ?? base.getModels();
			const chat = all.filter((model): model is Model<Api> => isModelType(model, "chat"));
			const nonChat = all.filter((model) => !isModelType(model, "chat"));
			return [...patchOpenAILoopModels(chat), ...nonChat];
		},
		stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
			model.api === OPENAI_COMPUTER_USE_API
				? streamOpenAIComputerUse(model as never, context, options)
				: model.api === "openai-responses"
					? streamOpenAIResponses(model as never, context, options)
					: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
			model.api === OPENAI_COMPUTER_USE_API
				? streamOpenAIComputerUse(model as never, context, options)
				: model.api === "openai-responses"
					? streamSimpleOpenAIResponses(model as never, context, options)
					: base.streamSimple(model, context, options),
	};
}

function withGoogleInteractions(base: Provider): Provider {
	return {
		...base,
		auth: { ...base.auth, apiKey: envApiKeyAuth("Google API key", loopApiKeyEnvVarsForProvider("google")) },
		stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) =>
			model.api === GOOGLE_INTERACTIONS_API
				? streamGoogleInteractions(model as never, context, options)
				: base.stream(model, context, options),
		streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
			model.api === GOOGLE_INTERACTIONS_API
				? streamSimpleGoogleInteractions(model as never, context, options)
				: base.streamSimple(model, context, options),
	};
}

export { GOOGLE_INTERACTIONS_API, streamGoogleInteractions, streamSimpleGoogleInteractions };
export {
	isOpenAIPlatformBaseUrl,
	OPENAI_COMPUTER_USE_API,
	streamOpenAIResponses,
	streamSimpleOpenAIResponses,
	type LoopOpenAISimpleStreamOptions,
	type OpenAIPromptCacheOptions,
	type OpenAIPromptCacheTtl,
	type OpenAIResponsesOptions,
};
