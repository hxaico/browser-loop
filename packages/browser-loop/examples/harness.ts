import Kernel from "@onkernel/sdk";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	attach,
	requireLoopEnvApiKeyForModel,
	type LoopContextualTool,
	type LoopHarnessLike,
} from "../src/pi/index";
import { logAgentEvent, logAssistant } from "./shared/logging";
import { parseExampleOptions } from "./shared/options";
import { toolsForModel } from "./shared/tools";

function createAgentHarness(agent: Agent): LoopHarnessLike<LoopContextualTool<undefined>> {
	const handlers = new Map<string, Set<(...args: any[]) => any>>();
	let currentTools = [...agent.state.tools] as LoopContextualTool<undefined>[];

	const emitSync = (event: string, payload: unknown): Record<string, unknown> | undefined => {
		for (const handler of handlers.get(event) ?? []) {
			const result = handler(payload);
			if (result !== undefined) return result as Record<string, unknown>;
		}
		return undefined;
	};

	agent.beforeToolCall = async ({ toolCall }) => emitSync("tool_call", { toolName: toolCall.name }) as any;
	agent.afterToolCall = async ({ toolCall, result, isError }) =>
		emitSync("tool_result", { toolName: toolCall.name, content: result.content, details: result.details, isError }) as any;
	agent.subscribe((event) => {
		if (event.type === "agent_start") emitSync("before_agent_start", {});
	});

	return {
		getModel: () => agent.state.model,
		setModel: (model) => {
			agent.state.model = model;
		},
		getTools: () => currentTools,
		setTools: (tools) => {
			currentTools = [...tools];
			agent.state.tools = tools as unknown as AgentTool<any>[];
		},
		on: (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		subscribe: (listener) => agent.subscribe((event, signal) => listener(event, signal)),
		followUp: (message) => {
			agent.followUp({ role: "user", content: message, timestamp: Date.now() });
		},
	};
}

async function main(): Promise<void> {
	const { modelRef, scenario } = parseExampleOptions();
	const kernelApiKey = process.env.KERNEL_API_KEY;
	if (!kernelApiKey) throw new Error("KERNEL_API_KEY is required");
	requireLoopEnvApiKeyForModel(modelRef);
	const client = new Kernel({ apiKey: kernelApiKey });
	const browser = await client.browsers.create({ stealth: true });
	const kb = attach({ browser, client });

	try {
		const compiled = kb.compile({ model: modelRef, tools: toolsForModel(modelRef) });
		const agent = new Agent({
			streamFn: (selected, context, options) => compiled.models.streamSimple(selected, context, options),
			initialState: {
				model: compiled.model,
				tools: [...compiled.agentTools],
				systemPrompt: "Use the provided computer and browser tools to interact with the page.",
			},
		});
		const harness = createAgentHarness(agent);
		compiled.activate(harness);
		agent.subscribe(logAgentEvent);

		console.log(`model=${modelRef} scenario=${scenario.name}`);
		await agent.prompt(scenario.prompt);
		const lastAssistant = [...agent.state.messages]
			.reverse()
			.find((message) => message.role === "assistant");
		logAssistant(lastAssistant?.role === "assistant" ? lastAssistant : undefined);
	} finally {
		await kb.dispose();
		await client.browsers.deleteByID(browser.session_id);
	}
}

void main();
