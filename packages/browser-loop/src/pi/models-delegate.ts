import type { Models, MutableModels } from "@earendil-works/pi-ai";

/**
 * Forward all 24 `Models` prototype methods explicitly via bound wrappers so
 * `ModelsImpl` instances from `@earendil-works/pi-ai@1.5.2` never lose
 * non-enumerable methods when wrapped with `{ ...models }`.
 */
export function delegateModels(models: Models, overrides: Partial<Models> = {}): Models {
	return {
		getProviders: overrides.getProviders ?? (() => models.getProviders()),
		getProvider: overrides.getProvider ?? ((id) => models.getProvider(id)),
		getModels: overrides.getModels ?? ((provider) => models.getModels(provider)),
		getModel: overrides.getModel ?? ((provider, id) => models.getModel(provider, id)),
		getModelsOfType: overrides.getModelsOfType ?? ((type, provider) => models.getModelsOfType(type, provider)),
		getModelOfType: overrides.getModelOfType ?? ((type, provider, id) => models.getModelOfType(type, provider, id)),
		getAllModels: overrides.getAllModels ?? ((provider) => models.getAllModels(provider)),
		refresh: overrides.refresh ?? ((options) => models.refresh(options)),
		checkAuth: overrides.checkAuth ?? ((providerId, options) => models.checkAuth(providerId, options)),
		getAvailable: overrides.getAvailable ?? ((providerId, options) => models.getAvailable(providerId, options)),
		getAvailableOfType: overrides.getAvailableOfType ?? ((type, providerId, options) => models.getAvailableOfType(type, providerId, options)),
		getAllAvailable: overrides.getAllAvailable ?? ((providerId, options) => models.getAllAvailable(providerId, options)),
		getAuth: overrides.getAuth ?? models.getAuth.bind(models),
		login: overrides.login ?? ((providerId, type, interaction, options) => models.login(providerId, type, interaction, options)),
		logout: overrides.logout ?? ((providerId, options) => models.logout(providerId, options)),
		stream: overrides.stream ?? ((model, context, options) => models.stream(model, context, options)),
		complete: overrides.complete ?? ((model, context, options) => models.complete(model, context, options)),
		streamSimple: overrides.streamSimple ?? ((model, context, options) => models.streamSimple(model, context, options)),
		completeSimple: overrides.completeSimple ?? ((model, context, options) => models.completeSimple(model, context, options)),
		streamDeferred: overrides.streamDeferred ?? ((model, handle, options) => models.streamDeferred(model, handle, options)),
		fetchDeferred: overrides.fetchDeferred ?? ((model, handle, options) => models.fetchDeferred(model, handle, options)),
		cancelDeferred: overrides.cancelDeferred ?? ((model, handle, options) => models.cancelDeferred(model, handle, options)),
		generateImages: overrides.generateImages ?? ((model, context, options) => models.generateImages(model, context, options)),
		classify: overrides.classify ?? ((model, context, options) => models.classify(model, context, options)),
	};
}

/** Prototype-safe delegation for {@link MutableModels}. */
export function delegateMutableModels(models: MutableModels, overrides: Partial<MutableModels> = {}): MutableModels {
	return {
		...delegateModels(models, overrides),
		setProvider: overrides.setProvider ?? ((provider) => models.setProvider(provider)),
		deleteProvider: overrides.deleteProvider ?? ((id) => models.deleteProvider(id)),
		clearProviders: overrides.clearProviders ?? (() => models.clearProviders()),
	};
}
