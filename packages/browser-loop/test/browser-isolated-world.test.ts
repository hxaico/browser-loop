import { describe, expect, it } from "vitest";
import vm from "node:vm";
import {
	BrowserIsolatedWorldRegistry,
	ISOLATED_WORLD_NAME,
	MAX_ISOLATED_WORLDS,
	isStaleContextError,
	wrapIsolatedScript,
} from "../src/core/translator/browser-isolated-world";
import { CdpProtocolError, type CdpConnection } from "../src/core/translator/cdp";

interface RecordedCall {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

function createFakeRegistryCdp() {
	const calls: RecordedCall[] = [];
	const closeListeners = new Set<() => void>();
	let nextContextId = 100;
	let frameTree: { frame?: { id?: string; loaderId?: string }; childFrames?: unknown[] } | undefined = {
		frame: { id: "FRAME-1", loaderId: "LOADER-1" },
	};
	let createWorldDelay: (() => Promise<void>) | undefined;
	let evaluateImpl: (params: Record<string, unknown>, sessionId?: string) => Promise<unknown> | unknown = (params) => ({
		result: { value: params.expression },
	});

	const cdp = {
		onClose(listener: () => void) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
			calls.push({ method, params, sessionId });
			switch (method) {
				case "Page.createIsolatedWorld":
					if (createWorldDelay) await createWorldDelay();
					return { executionContextId: ++nextContextId };
				case "Page.getFrameTree":
					return { frameTree };
				case "Runtime.evaluate":
					return await evaluateImpl(params, sessionId);
				default:
					return {};
			}
		},
	} as unknown as CdpConnection;

	return {
		cdp,
		calls,
		emitClose: () => {
			for (const listener of closeListeners) listener();
		},
		setFrameTree: (next: typeof frameTree) => {
			frameTree = next;
		},
		setCreateWorldDelay: (delay: typeof createWorldDelay) => {
			createWorldDelay = delay;
		},
		setEvaluateImpl: (fn: typeof evaluateImpl) => {
			evaluateImpl = fn;
		},
	};
}

describe("BrowserIsolatedWorldRegistry", () => {
	it("creates and caches isolated worlds without Runtime.enable or grantUniveralAccess, including when loaderId is omitted", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		const first = await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			expression: "document.title",
		});
		const second = await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			expression: "location.href",
		});

		expect(first.result.value).toBe("(() => (\ndocument.title\n))()");
		expect(second.result.value).toBe("(() => (\nlocation.href\n))()");
		expect(fake.calls.some((call) => call.method === "Runtime.enable")).toBe(false);
		const createCalls = fake.calls.filter((call) => call.method === "Page.createIsolatedWorld");
		expect(createCalls).toHaveLength(1);
		expect(createCalls[0]!.params).toEqual({ frameId: "FRAME-1", worldName: ISOLATED_WORLD_NAME });
		expect(createCalls[0]!.params).not.toHaveProperty("grantUniveralAccess");
	});

	it("rejects an empty frameId instead of caching invalid entries", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);
		await expect(
			registry.getOrCreateContext("TARGET-1", "SESSION-1", "", "LOADER-1"),
		).rejects.toThrow(/non-empty frameId/);
		expect(fake.calls).toHaveLength(0);
	});

	it("coalesces concurrent cold requests and does not cache if invalidated mid-flight", async () => {
		const fake = createFakeRegistryCdp();
		let releaseCreate!: () => void;
		fake.setCreateWorldDelay(() => new Promise<void>((resolve) => { releaseCreate = resolve; }));
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		const p1 = registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "LOADER-1");
		const p2 = registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "LOADER-1");
		await Promise.resolve();
		expect(fake.calls.filter((c) => c.method === "Page.createIsolatedWorld")).toHaveLength(1);

		// Evict while Page.createIsolatedWorld is still in flight.
		registry.evictFrame("TARGET-1", "FRAME-1");
		releaseCreate();

		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1).toEqual({ contextId: 101, wasCached: false });
		expect(r2).toEqual({ contextId: 101, wasCached: false });

		// Post-await pendingWorlds identity guard kept stale contextId out of the cache.
		fake.setCreateWorldDelay(undefined);
		const r3 = await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "LOADER-1");
		expect(r3).toEqual({ contextId: 102, wasCached: false });
		const r4 = await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "LOADER-1");
		expect(r4).toEqual({ contextId: 102, wasCached: true });
	});

	it("enforces bounded LRU eviction at MAX_ISOLATED_WORLDS (64)", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		for (let i = 0; i < MAX_ISOLATED_WORLDS; i += 1) {
			await registry.getOrCreateContext("TARGET-1", "SESSION-1", `FRAME-${i}`, "L0");
		}
		// Touch FRAME-0 so FRAME-1 becomes the least recently used entry.
		const hit = await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-0", "L0");
		expect(hit).toEqual({ contextId: 101, wasCached: true });

		// Adding a 65th world evicts FRAME-1, keeping FRAME-0 cached.
		await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-EXTRA", "L0");
		const stillCached = await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-0", "L0");
		expect(stillCached).toEqual({ contextId: 101, wasCached: true });

		const evicted = await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "L0");
		expect(evicted.wasCached).toBe(false);
		expect(evicted.contextId).toBeGreaterThan(100 + MAX_ISOLATED_WORLDS);
	});

	it("evicts on evictFrame, evictTarget, evictSession, and cdp.onClose", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		await registry.getOrCreateContext("T1", "S1", "F1", "L1");
		await registry.getOrCreateContext("T1", "S1", "F2", "L1");
		await registry.getOrCreateContext("T2", "S2", "F3", "L1");

		registry.evictFrame("T1", "F1");
		expect((await registry.getOrCreateContext("T1", "S1", "F1", "L1")).wasCached).toBe(false);
		expect((await registry.getOrCreateContext("T1", "S1", "F2", "L1")).wasCached).toBe(true);

		registry.evictTarget("T1");
		expect((await registry.getOrCreateContext("T1", "S1", "F2", "L1")).wasCached).toBe(false);
		expect((await registry.getOrCreateContext("T2", "S2", "F3", "L1")).wasCached).toBe(true);

		registry.evictSession("S2");
		expect((await registry.getOrCreateContext("T2", "S2", "F3", "L1")).wasCached).toBe(false);

		await registry.getOrCreateContext("T2", "S2", "F3", "L1");
		fake.emitClose();
		expect((await registry.getOrCreateContext("T2", "S2", "F3", "L1")).wasCached).toBe(false);
	});

	it("retries once on cached -32000 when Page.getFrameTree confirms same frame and loaderId", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		// Prime cache.
		await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			loaderId: "LOADER-1",
			expression: "1",
		});

		let attempts = 0;
		fake.setEvaluateImpl((params) => {
			attempts += 1;
			if (attempts === 1) {
				throw new CdpProtocolError("Runtime.evaluate", -32000, "Cannot find context with specified id");
			}
			return { result: { value: params.contextId } };
		});

		const res = await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			loaderId: "LOADER-1",
			expression: "2",
		});

		expect(attempts).toBe(2);
		expect(res.result.value).toBe(102);
		expect(fake.calls.filter((c) => c.method === "Page.getFrameTree")).toHaveLength(1);
		expect(fake.calls.filter((c) => c.method === "Page.createIsolatedWorld")).toHaveLength(2);
	});

	it("does not retry -32000 when loaderId changed, when uncached, on -32001, or when aborted", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		// 1. Uncached -32000 -> no retry.
		fake.setEvaluateImpl(() => {
			throw new CdpProtocolError("Runtime.evaluate", -32000, "Stale context");
		});
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "1",
			}),
		).rejects.toBeInstanceOf(CdpProtocolError);
		expect(fake.calls.filter((c) => c.method === "Page.getFrameTree")).toHaveLength(0);

		// 2. Cached -32000 with loaderId mismatch -> deletes cache & rethrows without creating new world.
		fake.setEvaluateImpl(() => ({ result: { value: "ok" } }));
		await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			loaderId: "LOADER-1",
			expression: "prime",
		});
		fake.setFrameTree({ frame: { id: "FRAME-1", loaderId: "LOADER-2" } });
		fake.setEvaluateImpl(() => {
			throw new CdpProtocolError("Runtime.evaluate", -32000, "Context destroyed");
		});
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "run",
			}),
		).rejects.toMatchObject({ code: -32000 });
		expect((await registry.getOrCreateContext("TARGET-1", "SESSION-1", "FRAME-1", "LOADER-1")).wasCached).toBe(false);

		// 3. Cached -32001 -> deletes cache & rethrows directly without getFrameTree.
		fake.calls.length = 0;
		fake.setFrameTree({ frame: { id: "FRAME-1", loaderId: "LOADER-1" } });
		fake.setEvaluateImpl(() => ({ result: { value: "ok" } }));
		await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			loaderId: "LOADER-1",
			expression: "prime",
		});
		fake.setEvaluateImpl(() => {
			throw new CdpProtocolError("Runtime.evaluate", -32001, "Session closed");
		});
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "run",
			}),
		).rejects.toMatchObject({ code: -32001 });
		expect(fake.calls.filter((c) => c.method === "Page.getFrameTree")).toHaveLength(0);

		// 4. Cached -32000 with signal aborted mid-evaluation -> deletes cache & rethrows without retry.
		const controller = new AbortController();
		fake.setEvaluateImpl(() => ({ result: { value: "ok" } }));
		await registry.evaluate({
			targetId: "TARGET-1",
			sessionId: "SESSION-1",
			frameId: "FRAME-1",
			loaderId: "LOADER-1",
			expression: "prime",
		});
		fake.setEvaluateImpl(() => {
			controller.abort();
			throw new CdpProtocolError("Runtime.evaluate", -32000, "Context gone");
		});
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "run",
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ code: -32000 });
		expect(fake.calls.filter((c) => c.method === "Page.getFrameTree")).toHaveLength(0);
	});

	it("classifies stale context errors strictly by CDP protocol error code", () => {
		expect(isStaleContextError(new CdpProtocolError("Runtime.evaluate", -32000, "any"))).toBe(true);
		expect(isStaleContextError(new CdpProtocolError("Runtime.evaluate", -32001, "any"))).toBe(true);
		expect(isStaleContextError(new CdpProtocolError("Runtime.evaluate", -32603, "Cannot find context with specified id"))).toBe(false);
		expect(isStaleContextError(new Error("Cannot find context with specified id"))).toBe(false);
	});

	it("never invokes Runtime.evaluate when aborted before or during world creation", async () => {
		const fake = createFakeRegistryCdp();
		const registry = new BrowserIsolatedWorldRegistry(fake.cdp);

		const alreadyAborted = new AbortController();
		alreadyAborted.abort(new Error("already aborted"));
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "1 + 1",
				signal: alreadyAborted.signal,
			}),
		).rejects.toThrow("already aborted");
		expect(fake.calls).toHaveLength(0);

		const midFlight = new AbortController();
		fake.setCreateWorldDelay(async () => {
			midFlight.abort(new Error("aborted during create"));
		});
		await expect(
			registry.evaluate({
				targetId: "TARGET-1",
				sessionId: "SESSION-1",
				frameId: "FRAME-1",
				loaderId: "LOADER-1",
				expression: "1 + 1",
				signal: midFlight.signal,
			}),
		).rejects.toThrow("aborted during create");
		expect(fake.calls.some((c) => c.method === "Runtime.evaluate")).toBe(false);
	});
});

describe("wrapIsolatedScript", () => {
	it("wraps expressions, const/let blocks, return statements, and async await without eval() or redeclaration errors", async () => {
		const context = vm.createContext({});

		const expr = wrapIsolatedScript("{ a: 1, b: 2 }");
		expect(vm.runInContext(expr, context)).toEqual({ a: 1, b: 2 });

		// Trailing semicolons on single expressions still return their value instead of undefined.
		const exprWithSemi = wrapIsolatedScript("{ a: 1 };");
		expect(vm.runInContext(exprWithSemi, context)).toEqual({ a: 1 });

		// Repeated const/let declarations in the same reused context must not throw SyntaxError.
		const block = wrapIsolatedScript("const x = 40; let y = 2; x + y // trailing comment");
		expect(vm.runInContext(block, context)).toBe(42);
		expect(vm.runInContext(block, context)).toBe(42);

		const withReturn = wrapIsolatedScript("const x = 10; return x * 2;");
		expect(vm.runInContext(withReturn, context)).toBe(20);

		const asyncExpr = wrapIsolatedScript("await Promise.resolve(99)", true);
		await expect(vm.runInContext(asyncExpr, context)).resolves.toBe(99);

		const asyncExprWithSemi = wrapIsolatedScript("await Promise.resolve(99);", true);
		await expect(vm.runInContext(asyncExprWithSemi, context)).resolves.toBe(99);

		const asyncStmt = wrapIsolatedScript("const v = await Promise.resolve(7); return v + 1;", true);
		await expect(vm.runInContext(asyncStmt, context)).resolves.toBe(8);

		// When awaitPromise is false, do not synthesize an async IIFE.
		expect(wrapIsolatedScript("await Promise.resolve(1)", false)).toBe("await Promise.resolve(1)");

		for (const candidate of [expr, exprWithSemi, block, withReturn, asyncExpr, asyncExprWithSemi, asyncStmt]) {
			expect(candidate).not.toContain("eval(");
		}
	});
});
