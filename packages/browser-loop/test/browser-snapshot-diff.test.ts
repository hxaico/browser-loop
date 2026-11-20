import type Kernel from "@onkernel/sdk";
import { describe, expect, it } from "vitest";
import {
	BrowserExecutor,
	LoopExecutionResources,
	loop,
	type BrowserAction,
	type CdpConnection,
	type KernelBrowser,
} from "../src/index";
import { formatSnapshotDiff } from "../src/core/translator/browser-snapshot-diff";

interface AxSpec {
	nodeId: string;
	role?: string;
	name?: string;
	value?: unknown;
	properties?: Array<{ name: string; value?: unknown }>;
	backendDOMNodeId?: number;
	parentId?: string;
	childIds?: string[];
}

function ax(spec: AxSpec) {
	return {
		nodeId: spec.nodeId,
		parentId: spec.parentId,
		childIds: spec.childIds,
		backendDOMNodeId: spec.backendDOMNodeId,
		role: spec.role !== undefined ? { value: spec.role } : undefined,
		name: spec.name !== undefined ? { value: spec.name } : undefined,
		value: spec.value !== undefined ? { value: spec.value } : undefined,
		properties: spec.properties?.map((p) => ({ name: p.name, value: { value: p.value } })),
	};
}

function createDiffFakeCdp(initialNodes: unknown[]) {
	const eventListeners: Array<(event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void> = [];
	let nodes = initialNodes;
	let url = "https://shop.test/checkout";
	let title = "Checkout";
	let loaderId = "L1";
	let worldSeq = 0;

	const cdp = {
		onEvent(listener: (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => void) {
			eventListeners.push(listener);
		},
		onClose() {
			return () => {};
		},
		async pageTargets() {
			return [{ targetId: "TARGET-1", type: "page", title, url }];
		},
		async attachToTarget() {
			return "session-1";
		},
		async send(method: string, params: Record<string, unknown> = {}) {
			switch (method) {
				case "Page.getFrameTree":
					return { frameTree: { frame: { id: "TARGET-1", loaderId } } };
				case "Accessibility.getFullAXTree":
					return { nodes };
				case "Page.createIsolatedWorld":
					return { executionContextId: ++worldSeq };
				case "Runtime.evaluate":
					if (params.returnByValue === false) return { result: { objectId: "scan" } };
					return { result: { value: "" } };
				case "Runtime.getProperties":
					return { result: [{ name: "length", value: {} }] };
				case "Page.reload": {
					const next = `L-${++worldSeq}`;
					loaderId = next;
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
		setNodes: (next: unknown[]) => { nodes = next; },
		setLocation: (nextUrl: string, nextTitle = title) => { url = nextUrl; title = nextTitle; },
	};
}

function buildCheckoutBaseline() {
	const footerLinks = Array.from({ length: 12 }, (_, i) =>
		ax({ nodeId: `fl${i}`, role: "link", name: `Footer Link ${i + 1}`, backendDOMNodeId: 200 + i, parentId: "footer" }),
	);
	return [
		ax({ nodeId: "1", role: "RootWebArea", name: "Checkout", childIds: ["promo", "main", "footer"] }),
		ax({ nodeId: "promo", role: "region", name: "Promo Banner", backendDOMNodeId: 9, parentId: "1", childIds: ["promoText"] }),
		ax({ nodeId: "promoText", role: "StaticText", name: "Save 10% today", parentId: "promo" }),
		ax({ nodeId: "main", role: "main", name: "Checkout", backendDOMNodeId: 2, parentId: "1", childIds: ["form", "summary"] }),
		ax({
			nodeId: "form",
			role: "group",
			name: "Shipping Details",
			backendDOMNodeId: 4,
			parentId: "main",
			childIds: ["name", "email", "zip", "ship"],
		}),
		ax({ nodeId: "name", role: "textbox", name: "Full Name", value: "Alice", backendDOMNodeId: 10, parentId: "form" }),
		ax({ nodeId: "email", role: "textbox", name: "Email", value: "", backendDOMNodeId: 11, parentId: "form", properties: [{ name: "required", value: true }, { name: "readonly", value: true }] }),
		ax({ nodeId: "zip", role: "textbox", name: "ZIP Code", value: "10001", backendDOMNodeId: 16, parentId: "form", properties: [{ name: "required", value: true }, { name: "invalid", value: "false" }] }),
		ax({ nodeId: "ship", role: "combobox", name: "Shipping", value: "Standard", backendDOMNodeId: 18, parentId: "form", childIds: ["opt1", "opt2", "opt3"] }),
		ax({ nodeId: "opt1", role: "option", name: "Standard", backendDOMNodeId: 19, parentId: "ship", properties: [{ name: "selected", value: true }] }),
		ax({ nodeId: "opt2", role: "option", name: "Express", backendDOMNodeId: 20, parentId: "ship" }),
		ax({ nodeId: "opt3", role: "option", name: "Overnight", backendDOMNodeId: 21, parentId: "ship" }),
		ax({ nodeId: "summary", role: "region", name: "Order Summary", backendDOMNodeId: 30, parentId: "main", childIds: ["total", "trailing"] }),
		ax({ nodeId: "total", role: "StaticText", name: "Total: $42.00", parentId: "summary" }),
		ax({ nodeId: "trailing", role: "button", name: "Remove Coupon", backendDOMNodeId: 31, parentId: "summary" }),
		ax({ nodeId: "footer", role: "contentinfo", name: "Footer", backendDOMNodeId: 40, parentId: "1", childIds: footerLinks.map((l) => l.nodeId) }),
		...footerLinks,
	];
}

describe("BrowserExecutor hierarchical AXTree diffs", () => {
	it("renders invalid/readonly states, removed_refs, non-landmark ancestors, omitted markers, pre-sibling & trailing removals, and option-group expansion", async () => {
		const fake = createDiffFakeCdp(buildCheckoutBaseline());
		const executor = new BrowserExecutor(fake.cdp);

		const full = (await executor.execute({ type: "browser_snapshot" } as BrowserAction))[0] as { text: string; diff: boolean };
		expect(full.diff).toBe(false);
		expect(full.text).toContain('textbox "Email" [e4] [required, readonly]');
		expect(full.text).not.toContain("[invalid"); // invalid="false" must not emit invalid

		// Mutate: remove promo (before main), update zip -> invalid, insert StaticText error, select Express, remove trailing button in summary, append dialog.
		const footerLinks = Array.from({ length: 12 }, (_, i) =>
			ax({ nodeId: `fl${i}`, role: "link", name: `Footer Link ${i + 1}`, backendDOMNodeId: 200 + i, parentId: "footer" }),
		);
		fake.setNodes([
			ax({ nodeId: "1", role: "RootWebArea", name: "Checkout", childIds: ["main", "footer", "dlg"] }),
			ax({ nodeId: "main", role: "main", name: "Checkout", backendDOMNodeId: 2, parentId: "1", childIds: ["form", "summary"] }),
			ax({
				nodeId: "form",
				role: "group",
				name: "Shipping Details",
				backendDOMNodeId: 4,
				parentId: "main",
				childIds: ["name", "email", "zip", "zipErr", "ship"],
			}),
			ax({ nodeId: "name", role: "textbox", name: "Full Name", value: "Alice", backendDOMNodeId: 10, parentId: "form" }),
			ax({ nodeId: "email", role: "textbox", name: "Email", value: "", backendDOMNodeId: 11, parentId: "form", properties: [{ name: "required", value: true }, { name: "readonly", value: true }] }),
			ax({ nodeId: "zip", role: "textbox", name: "ZIP Code", value: "12", backendDOMNodeId: 16, parentId: "form", properties: [{ name: "required", value: true }, { name: "invalid", value: true }] }),
			ax({ nodeId: "zipErr", role: "StaticText", name: "Enter 5 digits", parentId: "form" }),
			ax({ nodeId: "ship", role: "combobox", name: "Shipping", value: "Express", backendDOMNodeId: 18, parentId: "form", childIds: ["opt1", "opt2", "opt3"] }),
			ax({ nodeId: "opt1", role: "option", name: "Standard", backendDOMNodeId: 19, parentId: "ship" }),
			ax({ nodeId: "opt2", role: "option", name: "Express", backendDOMNodeId: 20, parentId: "ship", properties: [{ name: "selected", value: true }] }),
			ax({ nodeId: "opt3", role: "option", name: "Overnight", backendDOMNodeId: 21, parentId: "ship" }),
			ax({ nodeId: "summary", role: "region", name: "Order Summary", backendDOMNodeId: 30, parentId: "main", childIds: ["total"] }),
			ax({ nodeId: "total", role: "StaticText", name: "Total: $42.00", parentId: "summary" }),
			ax({ nodeId: "footer", role: "contentinfo", name: "Footer", backendDOMNodeId: 40, parentId: "1", childIds: footerLinks.map((l) => l.nodeId) }),
			...footerLinks,
			ax({ nodeId: "dlg", role: "dialog", name: "Verify", backendDOMNodeId: 85, parentId: "1", childIds: ["okBtn"] }),
			ax({ nodeId: "okBtn", role: "button", name: "OK", backendDOMNodeId: 86, parentId: "dlg" }),
		]);

		const diffRes = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as {
			text: string;
			diff: boolean;
			unchanged: boolean;
		};
		expect(diffRes.diff).toBe(true);
		expect(diffRes.unchanged).toBe(false);
		expect(diffRes.text).toMatch(/^\[axtree_diff changed=\+3 ~4 -3\]/);
		expect(diffRes.text).toContain("removed_refs: [e1, e11]");
		// Pre-sibling removal before main:
		expect(diffRes.text).toContain('-   region "Promo Banner" [e1]');
		// Non-landmark parent "group" included along parentLineIndex:
		expect(diffRes.text).toContain('      group "Shipping Details"');
		expect(diffRes.text).toContain('        …');
		expect(diffRes.text).toContain('~       textbox "ZIP Code" [e5] [required, invalid, value="12"]');
		expect(diffRes.text).toContain('+       StaticText "Enter 5 digits"');
		// Option-group expansion includes unchanged Overnight option as context:
		expect(diffRes.text).toContain('          option "Overnight" [e9]');
		// Trailing removal flushed at the end of summary after omitted StaticText:
		expect(diffRes.text).toContain('-       button "Remove Coupon" [e11]');
		// Added dialog at root after omitted Footer:
		expect(diffRes.text).toContain('+   dialog "Verify"');
		expect(diffRes.text).toContain('+     button "OK" [e25]');

		// Next identical snapshot returns unchanged (confirming lastSnapshots advanced to currentNodes).
		const unchanged = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as {
			unchanged: boolean;
			diff: boolean;
		};
		expect(unchanged).toMatchObject({ unchanged: true, diff: false });

		// force_full: true bypasses BOTH UNCHANGED_SNAPSHOT and diffing (BLA-1).
		const forced = (await executor.execute({ type: "browser_snapshot", diff: true, force_full: true } as BrowserAction))[0] as {
			text: string;
			unchanged: boolean;
			diff: boolean;
		};
		expect(forced).toMatchObject({ unchanged: false, diff: false });
		expect(forced.text).toContain('RootWebArea "Checkout"');
		expect(forced.text).not.toContain("[axtree_diff");
	});

	it("collapses removed subtrees with > 6 descendants into (+N child nodes removed)", () => {
		const beforeNodes = [
			{ line: 'RootWebArea "Page"', depth: 0, role: "RootWebArea", name: "Page", nodeKey: "r" },
			{ line: '  region "Big Modal" [e1]', depth: 1, role: "region", name: "Big Modal", parentLineIndex: 0, nodeKey: "modal", ref: "e1" },
			...Array.from({ length: 7 }, (_, i) => ({
				line: `    button "B${i}" [e${i + 2}]`,
				depth: 2,
				role: "button",
				name: `B${i}`,
				parentLineIndex: 1,
				nodeKey: `b${i}`,
				ref: `e${i + 2}`,
			})),
			...Array.from({ length: 20 }, (_, i) => ({
				line: `  StaticText "Keep section line ${i} with plenty of text"`,
				depth: 1,
				role: "StaticText",
				name: `Keep section line ${i} with plenty of text`,
				parentLineIndex: 0,
				nodeKey: `k${i}`,
			})),
		];
		const currentNodes = [
			{ line: 'RootWebArea "Page"', depth: 0, role: "RootWebArea", name: "Page", nodeKey: "r" },
			...Array.from({ length: 20 }, (_, i) => ({
				line: `  StaticText "Keep section line ${i} with plenty of text"`,
				depth: 1,
				role: "StaticText",
				name: `Keep section line ${i} with plenty of text`,
				parentLineIndex: 0,
				nodeKey: `k${i}`,
			})),
		];
		const fullText = currentNodes.map((n) => n.line).join("\n");
		const diff = formatSnapshotDiff({
			baseline: { projectionKey: "k", url: "https://a.test", mainGeneration: 0, wasTruncated: false, nodes: beforeNodes },
			currentNodes,
			fullText,
			projectionKey: "k",
			url: "https://a.test",
			mainGeneration: 0,
			wasTruncated: false,
		});
		expect(diff).toBeDefined();
		expect(diff).toContain('-   region "Big Modal" [e1] (+7 child nodes removed)');
		expect(diff).not.toContain('button "B0"');
	});

	it("falls back to full snapshot on URL change, reload, projectionKey mismatch, truncation, >=40% churn, >=85% length, or LIS sibling reorder", async () => {
		// 1. LIS sibling reorder > 40% (reversing 10 siblings with 0 text/added/removed changes).
		const makeList = (order: number[]) => [
			ax({ nodeId: "root", role: "RootWebArea", name: "List", childIds: order.map((n) => `i${n}`) }),
			...order.map((n) => ax({ nodeId: `i${n}`, role: "button", name: `Row ${n}`, backendDOMNodeId: 100 + n, parentId: "root" })),
		];
		const fake = createDiffFakeCdp(makeList([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
		const executor = new BrowserExecutor(fake.cdp);
		await executor.execute({ type: "browser_snapshot" } as BrowserAction);

		// Reverse entire list -> LIS length 1, 9/10 reordered (90% > 40%) -> must fall back to full snapshot!
		fake.setNodes(makeList([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]));
		const reversed = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as { diff: boolean; text: string };
		expect(reversed.diff).toBe(false);
		expect(reversed.text).not.toContain("[axtree_diff");

		// Small move (1 row moved in 10 rows -> 10% < 40%) -> emits diff marking moved row!
		fake.setNodes(makeList([9, 8, 7, 6, 5, 4, 3, 2, 1, 10]));
		const movedOne = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as { diff: boolean; text: string };
		expect(movedOne.diff).toBe(true);
		expect(movedOne.text).toContain('~   button "Row 10"');

		// 2. URL mismatch -> full snapshot.
		fake.setLocation("https://shop.test/other");
		fake.setNodes(makeList([9, 8, 7, 6, 5, 4, 3, 2, 10, 1]));
		const urlChanged = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as { diff: boolean };
		expect(urlChanged.diff).toBe(false);

		// 3. Reload (mainGeneration mismatch) -> full snapshot.
		await executor.execute({ type: "browser_navigate", url: "reload" } as BrowserAction);
		const afterReload = (await executor.execute({ type: "browser_snapshot", diff: true } as BrowserAction))[0] as { diff: boolean };
		expect(afterReload.diff).toBe(false);

		// 4. projectionKey mismatch (filter: "interactive") -> full snapshot.
		const filterChanged = (await executor.execute({ type: "browser_snapshot", diff: true, filter: "interactive" } as BrowserAction))[0] as { diff: boolean };
		expect(filterChanged.diff).toBe(false);

		// 5. diffText.length >= 0.85 * fullText.length -> falls back to full snapshot.
		const tinyTree = [
			{ line: 'RootWebArea "P"', depth: 0, role: "RootWebArea", name: "P", nodeKey: "r" },
			{ line: '  button "A" [e1]', depth: 1, role: "button", name: "A", parentLineIndex: 0, nodeKey: "a", ref: "e1" },
			{ line: '  button "B" [e2]', depth: 1, role: "button", name: "B", parentLineIndex: 0, nodeKey: "b", ref: "e2" },
			{ line: '  button "C" [e3]', depth: 1, role: "button", name: "C", parentLineIndex: 0, nodeKey: "c", ref: "e3" },
		];
		const tinyAfter = [
			...tinyTree.slice(0, 3),
			{ line: '  button "C2" [e3]', depth: 1, role: "button", name: "C2", parentLineIndex: 0, nodeKey: "c", ref: "e3" },
		];
		expect(formatSnapshotDiff({
			baseline: { projectionKey: "k", url: "https://a.test", mainGeneration: 0, wasTruncated: false, nodes: tinyTree },
			currentNodes: tinyAfter,
			fullText: tinyAfter.map((n) => n.line).join("\n"),
			projectionKey: "k",
			url: "https://a.test",
			mainGeneration: 0,
			wasTruncated: false,
		})).toBeUndefined();

		// 6. wasTruncated disables diffing.
		expect(formatSnapshotDiff({
			baseline: { projectionKey: "k", url: "https://a.test", mainGeneration: 0, wasTruncated: true, nodes: tinyTree },
			currentNodes: tinyAfter,
			fullText: "x".repeat(500),
			projectionKey: "k",
			url: "https://a.test",
			mainGeneration: 0,
			wasTruncated: false,
		})).toBeUndefined();
	});

	it("forwards diff: true into LoopExecutionResources details.readResults without altering content text", async () => {
		const fake = createDiffFakeCdp(buildCheckoutBaseline());
		const executor = new BrowserExecutor(fake.cdp);
		const resources = new LoopExecutionResources({
			browser: { session_id: "b1", cdp_ws_url: "wss://example.test/cdp" } as KernelBrowser,
			client: {} as Kernel,
			createBrowserExecutor: () => executor,
		});
		const snapTool = resources.materialize(loop.tools.browser.snapshot());
		await snapTool.execute({});

		// Update zip value -> diff: true.
		const updated = buildCheckoutBaseline();
		updated[7] = ax({ nodeId: "zip", role: "textbox", name: "ZIP Code", value: "94107", backendDOMNodeId: 16, parentId: "form", properties: [{ name: "required", value: true }] });
		fake.setNodes(updated);

		const res = await snapTool.execute({ diff: true });
		expect((res.content[0] as { text: string }).text).toMatch(/^\[axtree_diff /);
		expect(res.details.readResults?.[0]).toMatchObject({
			type: "browser_text",
			label: "snapshot",
			diff: true,
			unchanged: false,
		});
	});
});
