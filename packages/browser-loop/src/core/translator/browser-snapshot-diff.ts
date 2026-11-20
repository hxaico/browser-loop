export const DEFAULT_MAX_DIFF_CHANGE_RATIO = 0.40;
const MAX_DIFF_TO_FULL_LENGTH_RATIO = 0.85;
const MAX_REMOVED_REFS = 50;
const MAX_OPTION_CHILDREN = 50;
const REMOVED_SUBTREE_COLLAPSE_THRESHOLD = 6;
const ROOT_KEY = "\u0000root";

const OPTION_CONTAINER_ROLES: ReadonlySet<string> = new Set([
	"select",
	"combobox",
	"listbox",
	"radiogroup",
]);

export interface SnapshotDiffNode {
	readonly line: string;
	readonly depth: number;
	readonly role: string;
	readonly name: string;
	readonly parentLineIndex?: number;
	readonly nodeKey: string;
	readonly ref?: string;
}

export interface SnapshotDiffBaseline {
	readonly projectionKey: string;
	readonly url: string;
	readonly mainGeneration: number;
	readonly wasTruncated: boolean;
	readonly hasIncompleteFrames?: boolean;
	readonly nodes: readonly SnapshotDiffNode[];
}

export interface SnapshotDiffOptions {
	readonly baseline: SnapshotDiffBaseline;
	readonly currentNodes: readonly SnapshotDiffNode[];
	readonly fullText: string;
	readonly projectionKey: string;
	readonly url: string;
	readonly mainGeneration: number;
	readonly wasTruncated: boolean;
	readonly hasIncompleteFrames?: boolean;
	readonly maxDiffChangeRatio?: number;
}

interface IndexedNode {
	readonly index: number;
	readonly node: SnapshotDiffNode;
	readonly parentKey: string;
}

interface RemovedPlacement {
	readonly removedBeforeNodeKey: Map<string, string[]>;
	readonly trailingRemovedByParentKey: Map<string, string[]>;
	readonly survivingParentKeys: Set<string>;
	readonly removedRefs: string[];
}

/**
 * Compute and format a hierarchical ref-preserving AXTree diff when the change
 * between baseline and current snapshot is bounded and strictly smaller than fullText.
 * Returns `undefined` when a full snapshot should be emitted instead.
 */
export function formatSnapshotDiff(options: SnapshotDiffOptions): string | undefined {
	const { baseline, currentNodes } = options;
	if (options.wasTruncated || baseline.wasTruncated || options.hasIncompleteFrames || baseline.hasIncompleteFrames) {
		return undefined;
	}
	if (baseline.projectionKey !== options.projectionKey) return undefined;
	if (baseline.url !== options.url || baseline.mainGeneration !== options.mainGeneration) return undefined;
	if (currentNodes.length === 0 || baseline.nodes.length === 0) return undefined;

	const maxRatio = options.maxDiffChangeRatio ?? DEFAULT_MAX_DIFF_CHANGE_RATIO;
	if (!Number.isFinite(maxRatio) || maxRatio <= 0) return undefined;

	const beforeByKey = indexNodes(baseline.nodes);
	const afterByKey = indexNodes(currentNodes);

	const addedIndices = new Set<number>();
	const modifiedIndices = new Set<number>();
	const removedBeforeIndices = new Set<number>();

	for (let i = 0; i < currentNodes.length; i += 1) {
		const afterEntry = afterByKey.get(currentNodes[i]!.nodeKey)!;
		const beforeEntry = beforeByKey.get(afterEntry.node.nodeKey);
		if (!beforeEntry) {
			addedIndices.add(i);
		} else if (
			beforeEntry.node.line !== afterEntry.node.line ||
			beforeEntry.node.depth !== afterEntry.node.depth ||
			beforeEntry.parentKey !== afterEntry.parentKey
		) {
			modifiedIndices.add(i);
		}
	}
	for (let i = 0; i < baseline.nodes.length; i += 1) {
		if (!afterByKey.has(baseline.nodes[i]!.nodeKey)) removedBeforeIndices.add(i);
	}

	const reorderedIndices = markSiblingReorders(currentNodes, beforeByKey, afterByKey, modifiedIndices);

	const changedCount = addedIndices.size + modifiedIndices.size + removedBeforeIndices.size;
	const changeRatio = changedCount / Math.max(baseline.nodes.length, currentNodes.length, 1);
	if (!(changeRatio > 0 && changeRatio < maxRatio)) return undefined;

	const placement = buildRemovedPlacement(baseline.nodes, removedBeforeIndices, afterByKey);
	const afterChildrenByParentIdx = groupChildrenByParentIdx(currentNodes);
	const includedAfterIndices = computeIncludedAfterIndices(
		currentNodes,
		addedIndices,
		modifiedIndices,
		reorderedIndices,
		placement,
		afterByKey,
		afterChildrenByParentIdx,
	);

	const bodyLines = emitDiffBody(
		currentNodes,
		addedIndices,
		modifiedIndices,
		includedAfterIndices,
		afterChildrenByParentIdx,
		placement,
	);
	const header = `[axtree_diff changed=+${addedIndices.size} ~${modifiedIndices.size} -${removedBeforeIndices.size}]`;
	const lines = [
		header,
		...(placement.removedRefs.length > 0 ? [`removed_refs: [${placement.removedRefs.join(", ")}]`] : []),
		...bodyLines,
	];
	const diffText = lines.join("\n");
	if (diffText.length >= MAX_DIFF_TO_FULL_LENGTH_RATIO * options.fullText.length) return undefined;
	return diffText;
}

function parentKeyOf(nodes: readonly SnapshotDiffNode[], index: number): string {
	const parentIdx = nodes[index]!.parentLineIndex;
	return parentIdx !== undefined ? nodes[parentIdx]!.nodeKey : ROOT_KEY;
}

function indexNodes(nodes: readonly SnapshotDiffNode[]): Map<string, IndexedNode> {
	const map = new Map<string, IndexedNode>();
	for (let i = 0; i < nodes.length; i += 1) {
		const node = nodes[i]!;
		map.set(node.nodeKey, { index: i, node, parentKey: parentKeyOf(nodes, i) });
	}
	return map;
}

function markSiblingReorders(
	currentNodes: readonly SnapshotDiffNode[],
	beforeByKey: ReadonlyMap<string, IndexedNode>,
	afterByKey: ReadonlyMap<string, IndexedNode>,
	modifiedIndices: Set<number>,
): Set<number> {
	const reorderedIndices = new Set<number>();
	const groups = new Map<string, Array<{ afterIdx: number; beforeIdx: number }>>();
	for (let i = 0; i < currentNodes.length; i += 1) {
		const afterEntry = afterByKey.get(currentNodes[i]!.nodeKey)!;
		const beforeEntry = beforeByKey.get(afterEntry.node.nodeKey);
		if (!beforeEntry || beforeEntry.parentKey !== afterEntry.parentKey) continue;
		let group = groups.get(afterEntry.parentKey);
		if (!group) {
			group = [];
			groups.set(afterEntry.parentKey, group);
		}
		group.push({ afterIdx: i, beforeIdx: beforeEntry.index });
	}
	for (const group of groups.values()) {
		if (group.length <= 1) continue;
		const keepPositions = lisPositions(group.map((entry) => entry.beforeIdx));
		for (let pos = 0; pos < group.length; pos += 1) {
			if (!keepPositions.has(pos)) {
				const idx = group[pos]!.afterIdx;
				modifiedIndices.add(idx);
				reorderedIndices.add(idx);
			}
		}
	}
	return reorderedIndices;
}

/** O(k log k) Longest Increasing Subsequence positions. */
function lisPositions(values: readonly number[]): Set<number> {
	const n = values.length;
	const tailPos: number[] = [];
	const prev = new Array<number>(n).fill(-1);
	for (let i = 0; i < n; i += 1) {
		const val = values[i]!;
		let lo = 0;
		let hi = tailPos.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (values[tailPos[mid]!]! < val) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tailPos[lo - 1]!;
		tailPos[lo] = i;
	}
	const result = new Set<number>();
	let cur = tailPos.length > 0 ? tailPos[tailPos.length - 1]! : -1;
	while (cur >= 0) {
		result.add(cur);
		cur = prev[cur]!;
	}
	return result;
}

function groupChildrenByParentIdx(nodes: readonly SnapshotDiffNode[]): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (let i = 0; i < nodes.length; i += 1) {
		const parentIdx = nodes[i]!.parentLineIndex ?? -1;
		let list = children.get(parentIdx);
		if (!list) {
			list = [];
			children.set(parentIdx, list);
		}
		list.push(i);
	}
	return children;
}

function buildRemovedPlacement(
	beforeNodes: readonly SnapshotDiffNode[],
	removedBeforeIndices: ReadonlySet<number>,
	afterByKey: ReadonlyMap<string, IndexedNode>,
): RemovedPlacement {
	const beforeChildren = groupChildrenByParentIdx(beforeNodes);
	const liveRefs = new Set<string>();
	for (const entry of afterByKey.values()) {
		if (entry.node.ref) liveRefs.add(entry.node.ref);
	}
	const removedRefs: string[] = [];
	for (const idx of removedBeforeIndices) {
		const ref = beforeNodes[idx]!.ref;
		if (ref && !liveRefs.has(ref) && removedRefs.length < MAX_REMOVED_REFS) removedRefs.push(ref);
	}

	const removedBeforeNodeKey = new Map<string, string[]>();
	const trailingRemovedByParentKey = new Map<string, string[]>();
	const survivingParentKeys = new Set<string>();

	for (let i = 0; i < beforeNodes.length; i += 1) {
		if (!removedBeforeIndices.has(i)) continue;
		const parentIdx = beforeNodes[i]!.parentLineIndex;
		if (parentIdx !== undefined && removedBeforeIndices.has(parentIdx)) continue;

		const descendants = collectDescendants(beforeChildren, i, (childIdx) => removedBeforeIndices.has(childIdx));
		const block = descendants.length > REMOVED_SUBTREE_COLLAPSE_THRESHOLD
			? [`- ${beforeNodes[i]!.line} (+${descendants.length} child nodes removed)`]
			: [i, ...descendants].map((idx) => `- ${beforeNodes[idx]!.line}`);

		const parentKey = parentIdx !== undefined ? beforeNodes[parentIdx]!.nodeKey : ROOT_KEY;
		if (parentKey !== ROOT_KEY && afterByKey.has(parentKey)) survivingParentKeys.add(parentKey);

		const siblings = beforeChildren.get(parentIdx ?? -1) ?? [];
		const pos = siblings.indexOf(i);
		let nextSurvivingKey: string | undefined;
		for (let s = pos + 1; s < siblings.length; s += 1) {
			const siblingIdx = siblings[s]!;
			if (removedBeforeIndices.has(siblingIdx)) continue;
			const candidateKey = beforeNodes[siblingIdx]!.nodeKey;
			const afterEntry = afterByKey.get(candidateKey);
			if (afterEntry && afterEntry.parentKey === parentKey) {
				nextSurvivingKey = candidateKey;
				break;
			}
		}

		if (nextSurvivingKey !== undefined) {
			appendLines(removedBeforeNodeKey, nextSurvivingKey, block);
		} else {
			appendLines(trailingRemovedByParentKey, parentKey, block);
		}
	}

	return { removedBeforeNodeKey, trailingRemovedByParentKey, survivingParentKeys, removedRefs };
}

function collectDescendants(
	childrenByParentIdx: ReadonlyMap<number, number[]>,
	rootIdx: number,
	include?: (idx: number) => boolean,
): number[] {
	const result: number[] = [];
	const visit = (idx: number) => {
		for (const child of childrenByParentIdx.get(idx) ?? []) {
			if (include && !include(child)) continue;
			result.push(child);
			visit(child);
		}
	};
	visit(rootIdx);
	return result;
}

function appendLines(map: Map<string, string[]>, key: string, lines: readonly string[]): void {
	let existing = map.get(key);
	if (!existing) {
		existing = [];
		map.set(key, existing);
	}
	existing.push(...lines);
}

function computeIncludedAfterIndices(
	currentNodes: readonly SnapshotDiffNode[],
	addedIndices: ReadonlySet<number>,
	modifiedIndices: ReadonlySet<number>,
	reorderedIndices: ReadonlySet<number>,
	placement: RemovedPlacement,
	afterByKey: ReadonlyMap<string, IndexedNode>,
	afterChildrenByParentIdx: ReadonlyMap<number, number[]>,
): Set<number> {
	const included = new Set<number>([...addedIndices, ...modifiedIndices]);
	for (const parentKey of placement.survivingParentKeys) {
		const entry = afterByKey.get(parentKey);
		if (entry) included.add(entry.index);
	}

	// Expand all option children (<= 50) for changed select/combobox/listbox/radiogroup controls.
	for (let i = 0; i < currentNodes.length; i += 1) {
		const node = currentNodes[i]!;
		if (!OPTION_CONTAINER_ROLES.has(node.role)) continue;
		const descendants = collectDescendants(afterChildrenByParentIdx, i);
		const changed =
			included.has(i) ||
			placement.trailingRemovedByParentKey.has(node.nodeKey) ||
			descendants.some((idx) => included.has(idx));
		if (!changed) continue;
		included.add(i);
		for (const descIdx of descendants.slice(0, MAX_OPTION_CHILDREN)) {
			included.add(descIdx);
		}
	}

	// Include one neighboring sibling as a position anchor for each reordered node (after option expansion).
	for (const idx of reorderedIndices) {
		const siblings = afterChildrenByParentIdx.get(currentNodes[idx]!.parentLineIndex ?? -1) ?? [];
		const pos = siblings.indexOf(idx);
		if (pos > 0) included.add(siblings[pos - 1]!);
		else if (pos >= 0 && pos + 1 < siblings.length) included.add(siblings[pos + 1]!);
	}

	// Include one surviving sibling anchor per contiguous added run inside a surviving parent.
	for (const idx of addedIndices) {
		const parentLineIndex = currentNodes[idx]!.parentLineIndex;
		if (parentLineIndex !== undefined && addedIndices.has(parentLineIndex)) continue;
		const siblings = afterChildrenByParentIdx.get(parentLineIndex ?? -1) ?? [];
		const pos = siblings.indexOf(idx);
		if (pos < 0 || (pos > 0 && addedIndices.has(siblings[pos - 1]!))) continue;
		if (pos > 0) {
			included.add(siblings[pos - 1]!);
		} else {
			let afterRun = pos + 1;
			while (afterRun < siblings.length && addedIndices.has(siblings[afterRun]!)) afterRun += 1;
			if (afterRun < siblings.length) included.add(siblings[afterRun]!);
		}
	}

	// Include ALL rendered ancestors along parentLineIndex (zero hardcoded role filter).
	for (const idx of [...included]) {
		let parentIdx = currentNodes[idx]!.parentLineIndex;
		while (parentIdx !== undefined && !included.has(parentIdx)) {
			included.add(parentIdx);
			parentIdx = currentNodes[parentIdx]!.parentLineIndex;
		}
	}
	return included;
}

function emitDiffBody(
	currentNodes: readonly SnapshotDiffNode[],
	addedIndices: ReadonlySet<number>,
	modifiedIndices: ReadonlySet<number>,
	includedAfterIndices: ReadonlySet<number>,
	afterChildrenByParentIdx: ReadonlyMap<number, number[]>,
	placement: RemovedPlacement,
): string[] {
	const body: string[] = [];

	const emitChildren = (parentKey: string, parentIdx: number, childDepth: number): void => {
		const children = afterChildrenByParentIdx.get(parentIdx) ?? [];
		let omitted = false;
		const flushOmitted = () => {
			if (!omitted) return;
			omitted = false;
			body.push(`  ${"  ".repeat(Math.min(childDepth, 20))}…`);
		};
		for (const childIdx of children) {
			const child = currentNodes[childIdx]!;
			const removedBefore = placement.removedBeforeNodeKey.get(child.nodeKey);
			if (removedBefore) {
				flushOmitted();
				body.push(...removedBefore);
			}
			if (!includedAfterIndices.has(childIdx)) {
				omitted = true;
				continue;
			}
			flushOmitted();
			const prefix = addedIndices.has(childIdx) ? "+ " : modifiedIndices.has(childIdx) ? "~ " : "  ";
			body.push(`${prefix}${child.line}`);
			emitChildren(child.nodeKey, childIdx, child.depth + 1);
		}
		flushOmitted();
		const trailing = placement.trailingRemovedByParentKey.get(parentKey);
		if (trailing) body.push(...trailing);
	};

	emitChildren(ROOT_KEY, -1, 0);
	return body;
}
