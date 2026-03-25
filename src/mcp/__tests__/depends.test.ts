import { describe, expect, it } from "vitest";
import { detectCyclicDeps, getReadyTasks } from "../dossier/lifecycle.js";
import type { TasksFile } from "../../spec/types.js";

function makeTasks(waves: Array<{ key: number | "closing"; tasks: Array<{ id: string; checked: boolean; depends?: string[] }> }>): TasksFile {
	return {
		slug: "test",
		waves: waves.map((w) => ({
			key: w.key,
			title: `Wave ${w.key}`,
			tasks: w.tasks.map((t) => ({ id: t.id, title: t.id, checked: t.checked, depends: t.depends })),
		})),
	};
}

describe("getReadyTasks", () => {
	it("returns all unchecked tasks when no depends", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false },
			{ id: "T-1.2", checked: false },
			{ id: "T-1.3", checked: true },
		] }]);
		const ready = getReadyTasks(tf);
		expect(ready.map((t) => t.id)).toEqual(["T-1.1", "T-1.2"]);
	});

	it("excludes tasks with unsatisfied depends", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false },
			{ id: "T-1.2", checked: false, depends: ["T-1.1"] },
			{ id: "T-1.3", checked: false, depends: ["T-1.1", "T-1.2"] },
		] }]);
		const ready = getReadyTasks(tf);
		expect(ready.map((t) => t.id)).toEqual(["T-1.1"]);
	});

	it("includes tasks whose depends are all checked", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: true },
			{ id: "T-1.2", checked: false, depends: ["T-1.1"] },
			{ id: "T-1.3", checked: false, depends: ["T-1.1"] },
		] }]);
		const ready = getReadyTasks(tf);
		expect(ready.map((t) => t.id)).toEqual(["T-1.2", "T-1.3"]);
	});

	it("works across waves", () => {
		const tf = makeTasks([
			{ key: 1, tasks: [{ id: "T-1.1", checked: true }] },
			{ key: 2, tasks: [{ id: "T-2.1", checked: false, depends: ["T-1.1"] }] },
		]);
		const ready = getReadyTasks(tf);
		expect(ready.map((t) => t.id)).toEqual(["T-2.1"]);
	});
});

describe("detectCyclicDeps", () => {
	it("returns empty for no cycles", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false },
			{ id: "T-1.2", checked: false, depends: ["T-1.1"] },
			{ id: "T-1.3", checked: false, depends: ["T-1.2"] },
		] }]);
		expect(detectCyclicDeps(tf)).toEqual([]);
	});

	it("detects simple cycle", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false, depends: ["T-1.2"] },
			{ id: "T-1.2", checked: false, depends: ["T-1.1"] },
		] }]);
		const cyclic = detectCyclicDeps(tf);
		expect(cyclic).toHaveLength(2);
		expect(cyclic).toContain("t-1.1");
		expect(cyclic).toContain("t-1.2");
	});

	it("detects 3-node cycle", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false, depends: ["T-1.3"] },
			{ id: "T-1.2", checked: false, depends: ["T-1.1"] },
			{ id: "T-1.3", checked: false, depends: ["T-1.2"] },
		] }]);
		expect(detectCyclicDeps(tf)).toHaveLength(3);
	});

	it("returns empty when no depends exist", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false },
			{ id: "T-1.2", checked: false },
		] }]);
		expect(detectCyclicDeps(tf)).toEqual([]);
	});

	it("ignores deps to non-existent task IDs", () => {
		const tf = makeTasks([{ key: 1, tasks: [
			{ id: "T-1.1", checked: false, depends: ["T-99.1"] },
		] }]);
		expect(detectCyclicDeps(tf)).toEqual([]);
	});
});
