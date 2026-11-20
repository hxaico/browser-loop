import { Script } from "node:vm";
import type { FrameTreeNode } from "./browser-document-reconciliation";
import { CdpProtocolError, type CdpConnection } from "./cdp";

export const ISOLATED_WORLD_NAME = "browser-loop-isolated";
export const MAX_ISOLATED_WORLDS = 64;

export interface IsolatedEvaluateParams {
	readonly targetId: string;
	readonly sessionId: string;
	readonly frameId: string;
	readonly loaderId?: string;
	readonly expression: string;
	readonly wrap?: boolean;
	readonly returnByValue?: boolean;
	readonly awaitPromise?: boolean;
	readonly objectGroup?: string;
	readonly signal?: AbortSignal;
}

export interface IsolatedEvaluateResponse {
	readonly result: {
		readonly value?: unknown;
		readonly description?: string;
		readonly type?: string;
	};
	readonly exceptionDetails?: {
		readonly text?: string;
		readonly exception?: { readonly description?: string };
	};
}

/** Strict CDP protocol-code check for stale/destroyed execution contexts (zero prose regexes). */
export function isStaleContextError(error: unknown): error is CdpProtocolError {
	return error instanceof CdpProtocolError && (error.code === -32000 || error.code === -32001);
}

/**
 * Wrap arbitrary user/probe code using `node:vm` `Script` parsing so reused isolated
 * worlds never throw `const`/`let` redeclaration errors and never invoke CSP-unsafe `eval()`.
 */
export function wrapIsolatedScript(code: string, awaitPromise = true): string {
	const candidates = [
		`(() => (\n${code}\n))()`,
		`{\n${code}\n}`,
		`(() => {\n${code}\n})()`,
		...(awaitPromise ? [
			`(async () => (\n${code}\n))()`,
			`(async () => {\n${code}\n})()`,
		] : []),
	];
	for (const candidate of candidates) {
		try {
			new Script(candidate);
			return candidate;
		} catch {
			// Try the next wrapper shape.
		}
	}
	return code;
}

/**
 * Bounded LRU cache of per-(target, session, frame, loader) isolated-world execution
 * contexts created via `Page.createIsolatedWorld` (zero `Runtime.enable`).
 */
export class BrowserIsolatedWorldRegistry {
	private readonly worlds = new Map<string, number>();
	private readonly pendingWorlds = new Map<string, Promise<number>>();

	constructor(private readonly cdp: CdpConnection) {
		this.cdp.onClose?.(() => this.clear());
	}

	async evaluate(params: IsolatedEvaluateParams): Promise<IsolatedEvaluateResponse> {
		const awaitPromise = params.awaitPromise ?? true;
		const expression = params.wrap === false ? params.expression : wrapIsolatedScript(params.expression, awaitPromise);
		const key = worldKey(params.targetId, params.sessionId, params.frameId, params.loaderId);
		const { contextId, wasCached } = await this.getOrCreateContext(
			params.targetId,
			params.sessionId,
			params.frameId,
			params.loaderId,
		);
		try {
			return await this.runEvaluate(params, contextId, expression, awaitPromise);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
			this.worlds.delete(key);
			this.pendingWorlds.delete(key);
			if (!wasCached || error.code !== -32000 || params.signal?.aborted) throw error;
			const sameFrame = await this.isSameLiveFrame(params.sessionId, params.frameId, params.loaderId);
			if (!sameFrame || params.signal?.aborted) throw error;
			const { contextId: freshContextId } = await this.getOrCreateContext(
				params.targetId,
				params.sessionId,
				params.frameId,
				params.loaderId,
			);
			return this.runEvaluate(params, freshContextId, expression, awaitPromise);
		}
	}

	async getOrCreateContext(
		targetId: string,
		sessionId: string,
		frameId: string,
		loaderId?: string,
	): Promise<{ contextId: number; wasCached: boolean }> {
		if (!frameId) throw new Error(`isolated world requires a non-empty frameId for target ${targetId}`);
		const key = worldKey(targetId, sessionId, frameId, loaderId);
		const cached = this.worlds.get(key);
		if (cached !== undefined) {
			this.worlds.delete(key);
			this.worlds.set(key, cached);
			return { contextId: cached, wasCached: true };
		}
		const inFlight = this.pendingWorlds.get(key);
		if (inFlight) return { contextId: await inFlight, wasCached: false };

		let pending!: Promise<number>;
		pending = (async () => {
			try {
				const { executionContextId } = await this.cdp.send<{ executionContextId?: number }>(
					"Page.createIsolatedWorld",
					{ frameId, worldName: ISOLATED_WORLD_NAME },
					sessionId,
				);
				if (typeof executionContextId !== "number") {
					throw new Error("Page.createIsolatedWorld did not return an executionContextId");
				}
				if (this.pendingWorlds.get(key) === pending) {
					this.cacheWorld(key, executionContextId);
				}
				return executionContextId;
			} finally {
				if (this.pendingWorlds.get(key) === pending) {
					this.pendingWorlds.delete(key);
				}
			}
		})();
		this.pendingWorlds.set(key, pending);
		return { contextId: await pending, wasCached: false };
	}

	evictTarget(targetId: string): void {
		this.evictWhere(([target]) => target === targetId);
	}

	evictSession(sessionId: string): void {
		this.evictWhere(([, session]) => session === sessionId);
	}

	evictFrame(targetId: string, frameId: string): void {
		this.evictWhere(([target, , frame]) => target === targetId && frame === frameId);
	}

	clear(): void {
		this.worlds.clear();
		this.pendingWorlds.clear();
	}

	private runEvaluate(
		params: IsolatedEvaluateParams,
		contextId: number,
		expression: string,
		awaitPromise: boolean,
	): Promise<IsolatedEvaluateResponse> {
		return this.cdp.send<IsolatedEvaluateResponse>(
			"Runtime.evaluate",
			{
				expression,
				contextId,
				returnByValue: params.returnByValue ?? true,
				awaitPromise,
				...(params.objectGroup ? { objectGroup: params.objectGroup } : {}),
			},
			params.sessionId,
		);
	}

	private async isSameLiveFrame(sessionId: string, frameId: string, loaderId?: string): Promise<boolean> {
		try {
			const { frameTree } = await this.cdp.send<{ frameTree?: FrameTreeNode }>("Page.getFrameTree", {}, sessionId);
			const live = findFrameInTree(frameTree, frameId);
			return live !== undefined && live.id === frameId && (live.loaderId ?? "") === (loaderId ?? "");
		} catch {
			return false;
		}
	}

	private cacheWorld(key: string, contextId: number): void {
		this.worlds.delete(key);
		this.worlds.set(key, contextId);
		while (this.worlds.size > MAX_ISOLATED_WORLDS) {
			const oldest = this.worlds.keys().next().value;
			if (oldest === undefined) break;
			this.worlds.delete(oldest);
		}
	}

	private evictWhere(predicate: (parts: readonly [string, string, string, string]) => boolean): void {
		for (const key of [...this.worlds.keys()]) {
			if (predicate(parseWorldKey(key))) this.worlds.delete(key);
		}
		for (const key of [...this.pendingWorlds.keys()]) {
			if (predicate(parseWorldKey(key))) this.pendingWorlds.delete(key);
		}
	}
}

function worldKey(targetId: string, sessionId: string, frameId: string, loaderId?: string): string {
	return `${targetId}\u0000${sessionId}\u0000${frameId}\u0000${loaderId ?? ""}`;
}

function parseWorldKey(key: string): [string, string, string, string] {
	const [targetId = "", sessionId = "", frameId = "", loaderId = ""] = key.split("\u0000");
	return [targetId, sessionId, frameId, loaderId];
}

function findFrameInTree(
	node: FrameTreeNode | undefined,
	frameId: string,
): { id?: string; loaderId?: string } | undefined {
	if (!node) return undefined;
	if (node.frame?.id === frameId) return node.frame;
	for (const child of node.childFrames ?? []) {
		const found = findFrameInTree(child, frameId);
		if (found) return found;
	}
	return undefined;
}
