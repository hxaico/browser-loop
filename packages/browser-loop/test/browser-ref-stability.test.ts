import { describe, expect, it } from "vitest";
import { BrowserExecutor, CdpProtocolError, type BrowserAction, type CdpConnection } from "../src/index";
import { RefGenerationLifecycle, type RefEntry } from "../src/core/translator/browser-ref-lifecycle";

interface AxSpec {
	nodeId: string;
	role?: string;
	name?: string;
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
	ignored?: boolean;
}

function ax(spec: AxSpec) {
	return {
		nodeId: spec.nodeId,
		ignored: spec.ignored,
		parentId: spec.parentId,
		childIds: spec.childIds,
		backendDOMNodeId: spec.backendDOMNodeId,
		role: spec.role !== undefined ? { value: spec.role } : undefined,
		name: spec.name !== undefined ? { value: spec.name } : undefined,
	};
}

function createRefFakeCdp(initialNodes: unknown[]) {
	const eventListeners: Array<(event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void> = [];
	let nodes = initialNodes;
	let mainLoaderId = "L1";
	const iframeFrames = new Map<number, string>();
	const frameTrees = new Map<string, unknown[]>();
	const frameLoaders = new Map<string, string>();
	let describeError: Error | undefined;
	let cursorIds: number[] = [];
	let worldSeq = 0;

	const cdp = {
		onEvent(listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void) {
			eventListeners.push(listener);
		},
		onClose() {
			return () => {};
		},
		async pageTargets() {
			return [{ targetId: "TARGET-1", type: "page", title: "Page", url: "https://example.test/" }];
		},
		async attachToTarget() {
			return "session-1";
		},
		async send(method: string, params: Record<string, unknown> = {}) {
			switch (method) {
				case "Page.getFrameTree": {
					const childFrames = [...new Set(iframeFrames.values())].map((id) => ({
						frame: { id, loaderId: frameLoaders.get(id) ?? "F0" },
					}));
					return {
						frameTree: {
							frame: { id: "TARGET-1", loaderId: mainLoaderId },
							...(childFrames.length ? { childFrames } : {}),
						},
					};
				}
				case "Accessibility.getFullAXTree":
					if (typeof params.frameId === "string") return { nodes: frameTrees.get(params.frameId) ?? [] };
					return { nodes };
				case "DOM.describeNode":
					if (typeof params.backendNodeId === "number") {
						if (describeError) throw describeError;
						return { node: { backendNodeId: params.backendNodeId, frameId: iframeFrames.get(params.backendNodeId) } };
					}
					return { node: { backendNodeId: Number(String(params.objectId).slice(3)) } };
				case "Page.createIsolatedWorld":
					return { executionContextId: ++worldSeq };
				case "Runtime.evaluate":
					return { result: { objectId: "scan" } };
				case "Runtime.getProperties":
					return {
						result: [
							...cursorIds.map((id, i) => ({ name: String(i), value: { objectId: `el-${id}` } })),
							{ name: "length", value: {} },
						],
					};
				case "Page.reload": {
					const next = `L-${++worldSeq}`;
					mainLoaderId = next;
					for (const listener of eventListeners) {
						listener({ method: "Page.frameNavigated", params: { frame: { id: "TARGET-1", loaderId: next } }, sessionId: "session-1" });
						listener({ method: "Page.lifecycleEvent", params: { frameId: "TARGET-1", loaderId: next, name: "load" }, sessionId: "session-1" });
					}
					return {};
				}
				default:
					return {};
			}
		},
	} as unknown as CdpConnection;

	return {
		cdp,
		emit: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => {
			for (const listener of eventListeners) listener(event);
		},
		setNodes: (next: unknown[]) => { nodes = next; },
		setIframe: (backendNodeId: number, frameId: string, tree: unknown[]) => {
			iframeFrames.set(backendNodeId, frameId);
			frameTrees.set(frameId, tree);
		},
		removeIframe: (backendNodeId: number, frameId: string) => {
			iframeFrames.delete(backendNodeId);
			frameTrees.delete(frameId);
		},
		setDescribeError: (err: Error | undefined) => { describeError = err; },
		setCursorIds: (ids: number[]) => { cursorIds = ids; },
	};
}

function refsOf(executor: BrowserExecutor): Map<string, RefEntry> {
	return (executor as unknown as { refs: Map<string, RefEntry> }).refs;
}

describe("RefGenerationLifecycle reverse index", () => {
	it("maintains refByNode atomically across retain, touch, rebindBackendNodeId, delete, and import", () => {
		const refs = new Map<string, RefEntry>();
		const lifecycle = new RefGenerationLifecycle(refs);
		const capture = lifecycle.captureTarget("T1");

		lifecycle.retainRef("e1", {
			backendNodeId: 10,
			targetId: "T1",
			frameId: "T1",
			sessionId: "s1",
			generation: capture.generation,
			role: "button",
			name: "One",
			nth: 0,
			cohort: 1,
		});
		lifecycle.retainRef("e2", {
			backendNodeId: 20,
			targetId: "T1",
			frameId: "T1",
			sessionId: "s1",
			generation: capture.generation,
			role: "button",
			name: "Two",
			nth: 0,
			cohort: 1,
		});

		expect(lifecycle.findRef("T1", "T1", 0, 10)).toBe("e1");
		expect([...refs.keys()]).toEqual(["e1", "e2"]);

		// touchRef updates metadata and bumps e1 to MRU end.
		lifecycle.touchRef("e1", { sessionId: "s2", role: "button", name: "One Updated", nth: 0, cohort: 1 });
		expect([...refs.keys()]).toEqual(["e2", "e1"]);
		expect(refs.get("e1")?.name).toBe("One Updated");

		// rebindBackendNodeId atomically moves the reverse-index mapping.
		lifecycle.rebindBackendNodeId("e1", 99);
		expect(lifecycle.findRef("T1", "T1", 0, 10)).toBeUndefined();
		expect(lifecycle.findRef("T1", "T1", 0, 99)).toBe("e1");

		// deleteRef cleans up refByNode.
		lifecycle.deleteRef("e1");
		expect(lifecycle.findRef("T1", "T1", 0, 99)).toBeUndefined();

		// importState populates refByNode.
		const imported = new RefGenerationLifecycle(new Map<string, RefEntry>());
		imported.importState([["T1", 3]], [["e5", {
			backendNodeId: 55,
			targetId: "T1",
			frameId: "T1",
			generation: 3,
			role: "link",
			name: "Docs",
			nth: 0,
			cohort: 1,
		}]], "T1", [["T1", "L3"]]);
		expect(imported.findRef("T1", "T1", 3, 55)).toBe("e5");
	});
});

describe("BrowserExecutor stable refs, pre-truncation guard, and incompleteFrames-safe pruning", () => {
	it("reuses [eN] across snapshots, DOM additions, same-doc navigation, and find, while monotonic after reload", async () => {
		const fake = createRefFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 10, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Cancel", backendDOMNodeId: 20, parentId: "1" }),
		]);
		const executor = new BrowserExecutor(fake.cdp);

		const snap1 = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(snap1.text).toContain('button "Save" [e1]');
		expect(snap1.text).toContain('button "Cancel" [e2]');

		// Same-document pushState + DOM insertion keeps e1/e2 stable and mints e3 for the new button.
		fake.emit({ method: "Page.navigatedWithinDocument", params: { frameId: "TARGET-1" }, sessionId: "session-1" });
		fake.setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["4", "2", "3"] }),
			ax({ nodeId: "4", role: "button", name: "Banner CTA", backendDOMNodeId: 30, parentId: "1" }),
			ax({ nodeId: "2", role: "button", name: "Save", backendDOMNodeId: 10, parentId: "1" }),
			ax({ nodeId: "3", role: "button", name: "Cancel", backendDOMNodeId: 20, parentId: "1" }),
		]);
		const snap2 = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(snap2.text).toContain('button "Banner CTA" [e3]');
		expect(snap2.text).toContain('button "Save" [e1]');
		expect(snap2.text).toContain('button "Cancel" [e2]');

		// browser_find reuses existing [e1] instead of minting a duplicate ref.
		const findRes = (await executor.execute({ type: "browser_find", query: "Save" }))[0] as { text: string };
		expect(findRes.text).toContain('button "Save" [e1]');

		// Reload invalidates old refs while keeping refCounter monotonic.
		await executor.execute({ type: "browser_navigate", url: "reload" });
		const snap3 = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(snap3.text).toContain('button "Banner CTA" [e4]');
		expect(snap3.text).toContain('button "Save" [e5]');
		expect(snap3.text).toContain('button "Cancel" [e6]');
	});

	it("preserves visible top-of-page refs past 50,000-char truncation instead of evicting them via tail nodes (BLA-5a)", async () => {
		const childIds: string[] = [];
		const nodes: unknown[] = [ax({ nodeId: "root", role: "RootWebArea", name: "Big", childIds })];
		// 1,250 buttons * ~50 chars each = ~62,500 chars (> SNAPSHOT_CHAR_LIMIT 50_000 and > REF_LIMIT_PER_TARGET 1000).
		for (let i = 1; i <= 1250; i += 1) {
			const id = `n${i}`;
			childIds.push(id);
			nodes.push(ax({
				nodeId: id,
				role: "button",
				name: `Long Action Item Button Number ${String(i).padStart(4, "0")}`,
				backendDOMNodeId: 1000 + i,
				parentId: "root",
			}));
		}
		const fake = createRefFakeCdp(nodes);
		const executor = new BrowserExecutor(fake.cdp);

		const snap = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(snap.text).toContain("… truncated at 50000 characters");
		expect(snap.text).toContain('button "Long Action Item Button Number 0001" [e1]');
		// Pre-truncation guard stopped minting before node 1001, so e1 was never evicted past REF_LIMIT_PER_TARGET!
		expect(refsOf(executor).has("e1")).toBe(true);
		expect(refsOf(executor).size).toBeLessThan(1000);
	});

	it("preserves uncollected child-frame refs when incompleteFrames is non-empty and prunes them when complete (BLA-5b)", async () => {
		const fake = createRefFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2", "3"] }),
			ax({ nodeId: "2", role: "button", name: "Main", backendDOMNodeId: 10, parentId: "1" }),
			ax({ nodeId: "3", role: "Iframe", backendDOMNodeId: 50, parentId: "1" }),
		]);
		fake.setIframe(50, "FRAME-CHILD", [
			ax({ nodeId: "f1", role: "button", name: "FramePay", backendDOMNodeId: 70 }),
		]);
		const executor = new BrowserExecutor(fake.cdp);

		const snap1 = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(snap1.text).toContain('button "Main" [e1]');
		expect(snap1.text).toContain('Iframe [e2]');
		expect(snap1.text).toContain('button "FramePay" [e3]');

		// Child frame transiently fails DOM.describeNode (IncompleteFrame.frameId === undefined at stage: "describe").
		fake.setDescribeError(new CdpProtocolError("DOM.describeNode", -32000, "Could not find node with given id"));
		await executor.execute({ type: "browser_snapshot" });
		// e3 MUST still be preserved because incompleteFrames.length > 0!
		expect(refsOf(executor).has("e3")).toBe(true);

		// Now child frame is cleanly gone (incompleteFrames.length === 0) -> e3 is pruned!
		fake.setDescribeError(undefined);
		fake.removeIframe(50, "FRAME-CHILD");
		fake.setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "button", name: "Main", backendDOMNodeId: 10, parentId: "1" }),
		]);
		await executor.execute({ type: "browser_snapshot" });
		expect(refsOf(executor).has("e1")).toBe(true);
		expect(refsOf(executor).has("e3")).toBe(false);
	});

	it("preserves deep browser_find and cursor:pointer refs across depth-limited or filtered snapshots", async () => {
		const fake = createRefFakeCdp([
			ax({ nodeId: "1", role: "RootWebArea", name: "Page", childIds: ["2"] }),
			ax({ nodeId: "2", role: "region", name: "Outer", backendDOMNodeId: 10, parentId: "1", childIds: ["3"] }),
			ax({ nodeId: "3", role: "region", name: "Inner", backendDOMNodeId: 11, parentId: "2", childIds: ["4", "5"] }),
			ax({ nodeId: "4", role: "button", name: "DeepSave", backendDOMNodeId: 12, parentId: "3" }),
			ax({ nodeId: "5", role: "generic", name: "PointerCard", backendDOMNodeId: 13, parentId: "3" }),
		]);
		fake.setCursorIds([13]);
		const executor = new BrowserExecutor(fake.cdp);

		const findRes = (await executor.execute({ type: "browser_find", query: "DeepSave" }))[0] as { text: string };
		expect(findRes.text).toContain('button "DeepSave" [e1]');

		// Shallow snapshot (depth: 1) omits DeepSave from text, yet DeepSave is live in observation -> e1 preserved!
		await executor.execute({ type: "browser_snapshot", depth: 1 });
		expect(refsOf(executor).has("e1")).toBe(true);

		// Full snapshot reuses e1 for DeepSave and mints cursor:pointer ref for PointerCard.
		const full = (await executor.execute({ type: "browser_snapshot" }))[0] as { text: string };
		expect(full.text).toContain('button "DeepSave" [e1]');
		expect(full.text).toContain('generic "PointerCard" [e4] [cursor:pointer]');
		const clickCursor = (await executor.execute({ type: "browser_snapshot", include_cursor: false }))[0] as { text: string };
		expect(clickCursor.text).not.toContain("[cursor:pointer]");
		// Cursor ref e4 is still live in the DOM so it remains preserved.
		expect(refsOf(executor).has("e4")).toBe(true);
	});

	it("enforces REF_LIMIT_PER_TARGET = 1000 LRU cap while keeping recently reused refs", async () => {
		const childIds: string[] = [];
		const nodes: unknown[] = [ax({ nodeId: "root", role: "RootWebArea", name: "Page", childIds })];
		// 1001 short buttons (< 50,000 chars total) so all 1000 fit under SNAPSHOT_CHAR_LIMIT.
		for (let i = 1; i <= 1001; i += 1) {
			const id = `b${i}`;
			childIds.push(id);
			nodes.push(ax({ nodeId: id, role: "button", name: `B${i}`, backendDOMNodeId: i, parentId: "root" }));
		}
		const fake = createRefFakeCdp(nodes);
		const executor = new BrowserExecutor(fake.cdp);

		await executor.execute({ type: "browser_snapshot" });
		expect(refsOf(executor).size).toBe(1000);
		// Oldest e1 was evicted by 1001st button; newest e1001 survived.
		expect(refsOf(executor).has("e1")).toBe(false);
		expect(refsOf(executor).has("e1001")).toBe(true);
	});
});
