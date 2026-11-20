import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpConnection, CdpProtocolError } from "../src/core/translator/cdp";

class FakeSocket {
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	private listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(public url: string) {
		FakeSocket.instances.push(this);
		queueMicrotask(() => {
			this.readyState = 1;
			this.emit("open", {});
		});
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	send(message: string): void {
		// Mirrors the WebSocket spec: a non-OPEN socket discards silently.
		if (this.readyState !== 1) return;
		this.sent.push(message);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", {});
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeSocket.instances = [];
});

describe("CdpConnection send", () => {
	it("rejects instead of hanging when the socket closed between connect and send", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");

		const first = cdp.send("Target.getTargets");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.emit("message", { data: JSON.stringify({ id: 1, result: { targetInfos: [] } }) });
		await first;

		// Close silently (no close event yet): send() would be discarded.
		socket.readyState = 3;
		await expect(cdp.send("Target.getTargets")).rejects.toThrow(/closed before/);
	});

	it("rejects in-flight commands when the connection closes", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const pending = cdp.send("Target.getTargets");
		await Promise.resolve();
		FakeSocket.instances[0]!.close();
		await expect(pending).rejects.toThrow(/closed/);
	});

	it("preserves command and protocol error metadata", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const pending = cdp.send("Accessibility.getFullAXTree", { frameId: "F1" }, "session-1");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		FakeSocket.instances[0]!.emit("message", {
			data: JSON.stringify({ id: 1, error: { code: -32000, message: "Frame with the given id was not found.", data: "gone" } }),
		});

		const error = await pending.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(CdpProtocolError);
		expect(error).toMatchObject({
			method: "Accessibility.getFullAXTree",
			code: -32000,
			protocolMessage: "Frame with the given id was not found.",
			data: "gone",
		});
	});

	it("coalesces concurrent attachToTarget calls and cleans up pendingAttaches on error or detach", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");

		const a = cdp.attachToTarget("TARGET-1");
		const b = cdp.attachToTarget("TARGET-1");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		expect(JSON.parse(socket.sent[0]!)).toMatchObject({
			method: "Target.attachToTarget",
			params: { targetId: "TARGET-1", flatten: true },
		});

		socket.emit("message", { data: JSON.stringify({ id: 1, result: { sessionId: "SESSION-1" } }) });
		expect(await Promise.all([a, b])).toEqual(["SESSION-1", "SESSION-1"]);
		expect(await cdp.attachToTarget("TARGET-1")).toBe("SESSION-1");
		expect(socket.sent).toHaveLength(1);

		// Detaching evicts the cached session so a subsequent attach sends a new command.
		socket.emit("message", { data: JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "SESSION-1" } }) });

		const c = cdp.attachToTarget("TARGET-1");
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
		socket.emit("message", { data: JSON.stringify({ id: 2, error: { code: -32000, message: "Target closed" } }) });
		await expect(c).rejects.toThrow(/Target closed/);

		// After failure, pendingAttaches was cleaned in finally so a retry sends id=3.
		const d = cdp.attachToTarget("TARGET-1");
		await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
		socket.emit("message", { data: JSON.stringify({ id: 3, result: { sessionId: "SESSION-2" } }) });
		expect(await d).toBe("SESSION-2");
	});

	it("does not cache an in-flight attach if detached before the response arrives", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const pending = cdp.attachToTarget("TARGET-1");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;

		socket.emit("message", { data: JSON.stringify({ method: "Target.detachedFromTarget", params: { targetId: "TARGET-1" } }) });
		socket.emit("message", { data: JSON.stringify({ id: 1, result: { sessionId: "SESSION-STALE" } }) });
		expect(await pending).toBe("SESSION-STALE");

		const fresh = cdp.attachToTarget("TARGET-1");
		await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
		socket.emit("message", { data: JSON.stringify({ id: 2, result: { sessionId: "SESSION-FRESH" } }) });
		expect(await fresh).toBe("SESSION-FRESH");
	});

	it("invokes onClose listeners once on explicit close() and on unexpected socket close, and supports unsubscribe", async () => {
		vi.stubGlobal("WebSocket", Object.assign(FakeSocket, { OPEN: 1 }));
		const cdp = new CdpConnection("wss://fake.test/cdp");
		const listenerA = vi.fn();
		const listenerB = vi.fn();
		const unsubscribeB = cdp.onClose(listenerB);
		cdp.onClose(listenerA);
		unsubscribeB();

		// Never connected: explicit close() still fires once.
		cdp.close();
		expect(listenerA).toHaveBeenCalledTimes(1);
		expect(listenerB).not.toHaveBeenCalled();

		// Connected, then explicit cdp.close(): fires once (not duplicated by FakeSocket close event).
		const pending = cdp.send("Target.getTargets");
		await vi.waitFor(() => expect(FakeSocket.instances[0]!.sent).toHaveLength(1));
		cdp.close();
		await expect(pending).rejects.toThrow(/closed/);
		expect(listenerA).toHaveBeenCalledTimes(2);

		// Connected, then unexpected socket close(): fires once.
		const pending2 = cdp.send("Target.getTargets");
		await vi.waitFor(() => expect(FakeSocket.instances[1]!.sent).toHaveLength(1));
		FakeSocket.instances[1]!.close();
		await expect(pending2).rejects.toThrow(/closed/);
		expect(listenerA).toHaveBeenCalledTimes(3);
	});
});
