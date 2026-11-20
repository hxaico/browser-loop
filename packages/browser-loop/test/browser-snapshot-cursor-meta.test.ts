import type Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import {
	BrowserEvaluateError,
	BrowserExecutor,
	CdpProtocolError,
	LoopExecutionResources,
	loop,
	type BrowserAction,
	type BrowserEvaluateOptions,
	type BrowserScreenshotOptions,
	type CdpConnection,
	type KernelBrowser,
} from "../src/index";

interface SentCommand {
	method: string;
	params: Record<string, unknown>;
	sessionId?: string;
}

function createHarnessCdp() {
	const sent: SentCommand[] = [];
	const eventListeners: Array<(event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void> = [];
	const closeListeners = new Set<() => void>();
	let nextWorldId = 500;
	let cursorIds: number[] = [];
	let sessionForTarget = "session-1";
	let loaderId = "L1";
	let title = "Example Store";
	let url = "https://example.test/cart";
	let sendOverride: ((method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown> | unknown) | undefined;
	let attachDelay: (() => Promise<void>) | undefined;
	let closed = false;

	const nodes = [
		{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: title }, childIds: ["2", "3"] },
		{ nodeId: "2", role: { value: "button" }, name: { value: "Checkout" }, backendDOMNodeId: 10, parentId: "1" },
		{ nodeId: "3", role: { value: "generic" }, name: { value: "Promo Card" }, backendDOMNodeId: 20, parentId: "1" },
	];

	const cdp = {
		onEvent(listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void) {
			eventListeners.push(listener);
		},
		onClose(listener: () => void) {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		async pageTargets() {
			return [{ targetId: "abcdef1234567890", type: "page", title, url }];
		},
		async attachToTarget() {
			if (attachDelay) await attachDelay();
			return sessionForTarget;
		},
		async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
			sent.push({ method, params, sessionId });
			if (sendOverride) {
				const overridden = await sendOverride(method, params, sessionId);
				if (overridden !== undefined) return overridden;
			}
			switch (method) {
				case "Page.getFrameTree":
					return { frameTree: { frame: { id: "FRAME-MAIN", loaderId } } };
				case "Accessibility.getFullAXTree":
					return { nodes };
				case "Page.createIsolatedWorld":
					return { executionContextId: ++nextWorldId };
				case "Runtime.evaluate":
					if (params.returnByValue === false) return { result: { objectId: "scan-arr" } };
					return { result: { value: { ok: true } } };
				case "Runtime.getProperties":
					return {
						result: [
							...cursorIds.map((id, i) => ({ name: String(i), value: { objectId: `el-${id}` } })),
							{ name: "length", value: {} },
						],
					};
				case "DOM.describeNode":
					return { node: { backendNodeId: Number(String(params.objectId).slice(3)) } };
				case "Page.captureScreenshot":
					return { data: Buffer.from(`${params.format}:${params.quality ?? "none"}`).toString("base64") };
				default:
					return {};
			}
		},
		close() {
			closed = true;
		},
	} as unknown as CdpConnection;

	return {
		cdp,
		sent,
		isClosed: () => closed,
		emitEvent(event: { method: string; params: Record<string, unknown>; sessionId?: string }) {
			for (const listener of eventListeners) listener(event);
		},
		emitClose() {
			for (const listener of closeListeners) listener();
		},
		setCursorIds(next: number[]) {
			cursorIds = next;
		},
		setSession(next: string) {
			sessionForTarget = next;
		},
		setLoaderId(next: string) {
			loaderId = next;
		},
		setLocation(nextUrl: string, nextTitle: string) {
			url = nextUrl;
			title = nextTitle;
		},
		setSendOverride(fn: typeof sendOverride) {
			sendOverride = fn;
		},
		setAttachDelay(fn: typeof attachDelay) {
			attachDelay = fn;
		},
	};
}

describe("BrowserExecutor attach, isolated cursor scan, snapshot metadata, evaluateValue, and screenshot options", () => {
	it("reuses pageTree.frame with 0 extra Page.getFrameTree calls and unique cursor-scan objectGroups", async () => {
		const fake = createHarnessCdp();
		fake.setCursorIds([20]);
		const executor = new BrowserExecutor(fake.cdp);

		const first = await executor.execute({ type: "browser_snapshot" });
		const second = await executor.execute({ type: "browser_snapshot" });

		expect(fake.sent.some((cmd) => cmd.method === "Runtime.enable")).toBe(false);
		// 1 Page.getFrameTree per snapshot (reused for cursorPointerIds).
		expect(fake.sent.filter((cmd) => cmd.method === "Page.getFrameTree")).toHaveLength(2);
		// Isolated world created once and reused across both snapshots.
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld")).toHaveLength(1);

		const evals = fake.sent.filter((cmd) => cmd.method === "Runtime.evaluate");
		expect(evals).toHaveLength(2);
		expect(evals[0]!.params.contextId).toBe(501);
		expect(evals[1]!.params.contextId).toBe(501);
		expect(evals[0]!.params.objectGroup).toBe("loop-cursor-scan-1");
		expect(evals[1]!.params.objectGroup).toBe("loop-cursor-scan-2");

		expect(first[0]).toEqual({
			type: "browser_text",
			label: "snapshot",
			text: expect.stringContaining('generic "Promo Card" [e2] [cursor:pointer]'),
			url: "https://example.test/cart",
			title: "Example Store",
			targetId: "abcdef1234567890",
			unchanged: false,
			diff: false,
		});
		expect(second[0]).toEqual({
			type: "browser_text",
			label: "snapshot",
			text: "Page unchanged since the last snapshot; previous element refs are still valid.",
			url: "https://example.test/cart",
			title: "Example Store",
			targetId: "abcdef1234567890",
			unchanged: true,
			diff: false,
		});
	});

	it("preserves isolated world across same-document navigation and evicts on cross-document navigation or detach", async () => {
		const fake = createHarnessCdp();
		const executor = new BrowserExecutor(fake.cdp);

		await executor.execute({ type: "browser_snapshot" });
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld")).toHaveLength(1);

		// Same-document navigation keeps the cached isolated world.
		fake.emitEvent({
			method: "Page.navigatedWithinDocument",
			params: { frameId: "FRAME-MAIN" },
			sessionId: "session-1",
		});
		await executor.execute({ type: "browser_snapshot" });
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld")).toHaveLength(1);

		// Cross-document navigation evicts it.
		fake.emitEvent({
			method: "Page.frameNavigated",
			params: { frame: { id: "FRAME-MAIN", loaderId: "L2" } },
			sessionId: "session-1",
		});
		fake.setLoaderId("L2");
		await executor.execute({ type: "browser_snapshot" });
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld")).toHaveLength(2);
	});

	it("converts stale-context CdpProtocolError during cursorPointerIds into ObservationChangedError and retries", async () => {
		const fake = createHarnessCdp();
		fake.setCursorIds([20]);
		let evalCount = 0;
		fake.setSendOverride(async (method) => {
			if (method === "Runtime.evaluate") {
				evalCount += 1;
				if (evalCount === 1) {
					throw new CdpProtocolError("Runtime.evaluate", -32000, "Execution context was destroyed.");
				}
			}
			return undefined;
		});
		const executor = new BrowserExecutor(fake.cdp);

		const res = await executor.execute({ type: "browser_snapshot" });
		expect(evalCount).toBe(2);
		expect(res[0]).toMatchObject({
			type: "browser_text",
			label: "snapshot",
			text: expect.stringContaining("[cursor:pointer]"),
			unchanged: false,
		});
	});

	it("keeps include_cursor: false and browser_act observations from poisoning cursor:1 cache entries", async () => {
		const fake = createHarnessCdp();
		fake.setCursorIds([20]);
		const executor = new BrowserExecutor(fake.cdp);

		// Initial cursor-enabled snapshot caches cursor:1.
		const snap1 = await executor.execute({ type: "browser_snapshot" });
		expect(snap1[0]).toMatchObject({ unchanged: false, text: expect.stringContaining("[cursor:pointer]") });

		// browser_act runs observe(tabId, false), which writes cursor:0 to lastSnapshots.
		await executor.execute({ type: "browser_act", steps: [{ type: "wait", ms: 0 }] });

		// Follow-up cursor-enabled snapshot must NOT hit browser_act's cursor:0 entry as unchanged.
		const snap2 = await executor.execute({ type: "browser_snapshot" });
		expect(snap2[0]).toMatchObject({
			unchanged: false,
			text: expect.stringContaining("[cursor:pointer]"),
		});

		// Explicit include_cursor: false skips cursor scan and hits cursor:0 cleanly.
		const evalsBefore = fake.sent.filter((cmd) => cmd.method === "Runtime.evaluate").length;
		const noCursor = await executor.execute({ type: "browser_snapshot", include_cursor: false });
		const evalsAfter = fake.sent.filter((cmd) => cmd.method === "Runtime.evaluate").length;
		expect(evalsAfter).toBe(evalsBefore);
		expect(noCursor[0]).toMatchObject({ unchanged: false });
		expect((noCursor[0] as { text: string }).text).not.toContain("[cursor:pointer]");
	});

	it("coalesces concurrent attach init, evicts oldSession on re-attach, resets on onClose, and matches lowercase short tab_id", async () => {
		const fake = createHarnessCdp();
		const executor = new BrowserExecutor(fake.cdp);

		// Concurrent actions on same target coalesce Page.enable / Target.setAutoAttach.
		await Promise.all([
			executor.execute({ type: "browser_evaluate", code: "1", tab_id: "abcdef1234" }),
			executor.execute({ type: "browser_evaluate", code: "2", tab_id: "ABCDEF1234" }),
		]);
		expect(fake.sent.filter((cmd) => cmd.method === "Page.enable")).toHaveLength(1);

		// Mint a ref and prime isolated world on session-1.
		await executor.execute({ type: "browser_snapshot" });
		const refs = (executor as unknown as { refs: Map<string, { sessionId: string }> }).refs;
		expect(refs.get("e1")?.sessionId).toBe("session-1");

		// Simulate connection close -> clears session maps, isolated worlds, and ref sessionIds.
		fake.emitClose();
		expect(refs.get("e1")?.sessionId).toBe("");

		// Re-attaching with a new session ID evicts oldSession state and re-initializes cleanly.
		fake.setSession("session-2");
		await executor.execute({ type: "browser_snapshot" });
		expect(fake.sent.filter((cmd) => cmd.method === "Page.enable" && cmd.sessionId === "session-2")).toHaveLength(1);
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld" && cmd.sessionId === "session-2")).toHaveLength(1);

		// If targetId maps to a new session while an old session was still tracked without onClose, oldSession is evicted.
		fake.setSession("session-3");
		await executor.execute({ type: "browser_evaluate", code: "3", isolated: true });
		expect(fake.sent.filter((cmd) => cmd.method === "Page.enable" && cmd.sessionId === "session-3")).toHaveLength(1);
		expect(fake.sent.filter((cmd) => cmd.method === "Page.createIsolatedWorld" && cmd.sessionId === "session-3")).toHaveLength(1);
	});

	it("evaluates values with isolated/main options, rethrows CdpProtocolError, throws BrowserEvaluateError, and races timeout/signal without closing cdp", async () => {
		const fake = createHarnessCdp();
		const executor = new BrowserExecutor(fake.cdp);

		const evalOpts: BrowserEvaluateOptions = { isolated: true, awaitPromise: false };
		fake.setSendOverride(async (method, params) => {
			if (method === "Runtime.evaluate") {
				return { result: { value: { wrapped: params.expression, contextId: params.contextId, awaitPromise: params.awaitPromise } } };
			}
			return undefined;
		});
		const val = await executor.evaluateValue<{ wrapped: string; contextId: number; awaitPromise: boolean }>(
			"const x = 1; x + 1",
			evalOpts,
		);
		expect(val.contextId).toBe(501);
		expect(val.awaitPromise).toBe(false);
		expect(val.wrapped).toContain("const x = 1");

		// JS exceptionDetails -> BrowserEvaluateError.
		fake.setSendOverride(async (method) => {
			if (method === "Runtime.evaluate") {
				return { result: {}, exceptionDetails: { exception: { description: "ReferenceError: boom is not defined" } } };
			}
			return undefined;
		});
		await expect(executor.evaluateValue("boom")).rejects.toBeInstanceOf(BrowserEvaluateError);

		// CdpProtocolError -> rethrown directly without wrapping.
		fake.setSendOverride(async (method) => {
			if (method === "Runtime.evaluate") {
				throw new CdpProtocolError("Runtime.evaluate", -32001, "Session detached");
			}
			return undefined;
		});
		await expect(executor.evaluateValue("1", { isolated: true })).rejects.toBeInstanceOf(CdpProtocolError);

		// Timeout and AbortSignal race without closing this.cdp.
		fake.setSendOverride(async (method) => {
			if (method === "Runtime.evaluate") return new Promise(() => {});
			return undefined;
		});
		await expect(executor.evaluateValue("1", { timeoutMs: 10 })).rejects.toThrow(/timed out/);
		expect(fake.isClosed()).toBe(false);

		const controller = new AbortController();
		const abortedEval = executor.evaluateValue("1", { signal: controller.signal });
		controller.abort(new Error("user cancelled"));
		await expect(abortedEval).rejects.toThrow(/user cancelled/);
		expect(fake.isClosed()).toBe(false);

		// browser_evaluate action forwards isolated, await_promise, and timeout_ms (using fresh world 502 after -32001 eviction).
		fake.setSendOverride(async (method, params) => {
			if (method === "Runtime.evaluate") return { result: { value: `ctx:${params.contextId}` } };
			return undefined;
		});
		const actionRes = await executor.execute({
			type: "browser_evaluate",
			code: "1 + 1",
			isolated: true,
			await_promise: false,
			timeout_ms: 500,
		} as BrowserAction);
		expect(actionRes[0]).toEqual({ type: "browser_text", label: "evaluate", text: "ctx:502" });

		// Repeated isolated evaluate reuses 502 from cache.
		expect(await executor.evaluateValue<string>("const a = 1; a", { isolated: true })).toBe("ctx:502");
	});

	it("supports PNG default and clamped JPEG quality in screenshot() and browser_screenshot", async () => {
		const fake = createHarnessCdp();
		const executor = new BrowserExecutor(fake.cdp);

		const png = await executor.screenshot();
		expect(png.mimeType).toBe("image/png");
		expect(png.data.toString()).toBe("png:none");

		const jpegDefault = await executor.screenshot(undefined, undefined, { format: "jpeg" } satisfies BrowserScreenshotOptions);
		expect(jpegDefault.mimeType).toBe("image/jpeg");
		expect(jpegDefault.data.toString()).toBe("jpeg:85");

		const jpegClampedHigh = await executor.screenshot(undefined, undefined, { format: "jpeg", quality: 150 });
		expect(jpegClampedHigh.data.toString()).toBe("jpeg:100");

		const jpegClampedLow = await executor.screenshot([0, 0, 10, 10], undefined, { format: "jpeg", quality: 0 });
		expect(jpegClampedLow.data.toString()).toBe("jpeg:1");

		const actionShot = await executor.execute({
			type: "browser_screenshot",
			format: "jpeg",
			quality: 72,
		} as BrowserAction);
		expect(actionShot[0]).toMatchObject({ type: "screenshot", mimeType: "image/jpeg" });
		expect((actionShot[0] as { data: Buffer }).data.toString()).toBe("jpeg:72");
	});

	it("forwards snapshot metadata into LoopExecutionDetails.readResults while preserving content text", async () => {
		const fake = createHarnessCdp();
		const executor = new BrowserExecutor(fake.cdp);
		const resources = new LoopExecutionResources({
			browser: { session_id: "b1", cdp_ws_url: "wss://example.test/cdp" } as KernelBrowser,
			client: {} as Kernel,
			createBrowserExecutor: () => executor,
		});

		const snapTool = resources.materialize(loop.tools.browser.snapshot());
		const first = await snapTool.execute({});
		expect(first.content).toEqual([{ type: "text", text: expect.stringContaining('button "Checkout" [e1]') }]);
		expect(first.details.readResults).toEqual([
			{
				type: "browser_text",
				label: "snapshot",
				bytes: (first.content[0] as { text: string }).text.length,
				url: "https://example.test/cart",
				title: "Example Store",
				targetId: "abcdef1234567890",
				unchanged: false,
				diff: false,
			},
		]);

		const second = await snapTool.execute({});
		expect(second.details.readResults?.[0]).toMatchObject({
			type: "browser_text",
			label: "snapshot",
			url: "https://example.test/cart",
			title: "Example Store",
			targetId: "abcdef1234567890",
			unchanged: true,
		});

		const textTool = resources.materialize(loop.tools.browser.text());
		const textRes = await textTool.execute({});
		expect(textRes.details.readResults?.[0]).toEqual({
			type: "browser_text",
			label: "text",
			bytes: (textRes.content[0] as { text: string }).text.length,
		});
	});
});
