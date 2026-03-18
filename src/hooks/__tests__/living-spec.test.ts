import { describe, expect, it } from "vitest";
import {
	appendFileToComponent,
	matchComponent,
	parseDesignFileRefs,
} from "../living-spec.js";

describe("parseDesignFileRefs", () => {
	it("parses component sections with File references", () => {
		const content = `# Design

### Component: API Server
- **File**: \`src/api/server.ts\`
- **File**: \`src/api/routes.ts\`

### Component: Store
- **File**: \`src/store/index.ts\`
`;
		const map = parseDesignFileRefs(content);
		expect(map.size).toBe(2);
		expect(map.get("API Server")).toEqual(["src/api/server.ts", "src/api/routes.ts"]);
		expect(map.get("Store")).toEqual(["src/store/index.ts"]);
	});

	it("handles headings without Component: prefix", () => {
		const content = `### Embedder
- **File**: \`src/embedder/index.ts\`
`;
		const map = parseDesignFileRefs(content);
		expect(map.get("Embedder")).toEqual(["src/embedder/index.ts"]);
	});

	it("returns empty map for no components", () => {
		expect(parseDesignFileRefs("# Design\nSome text")).toEqual(new Map());
	});
});

describe("matchComponent", () => {
	const componentMap = new Map([
		["API Server", ["src/api/server.ts", "src/api/routes.ts"]],
		["Store", ["src/store/index.ts"]],
	]);

	it("matches file by directory", () => {
		expect(matchComponent("src/api/middleware.ts", componentMap)).toBe("API Server");
	});

	it("matches store directory", () => {
		expect(matchComponent("src/store/vectors.ts", componentMap)).toBe("Store");
	});

	it("returns null for unmatched directory", () => {
		expect(matchComponent("src/hooks/new-hook.ts", componentMap)).toBeNull();
	});
});

describe("appendFileToComponent", () => {
	const baseContent = `# Design

### Component: Store
- **File**: \`src/store/index.ts\`
- **File**: \`src/store/fts.ts\`

### Component: API
- **File**: \`src/api/server.ts\`
`;

	it("appends after last File line in component", () => {
		const result = appendFileToComponent(baseContent, "Store", "src/store/vectors.ts");
		expect(result).not.toBeNull();
		expect(result).toContain("**File**: `src/store/vectors.ts` <!-- auto-added:");
		// Should be after fts.ts, before the blank line
		const lines = result!.split("\n");
		const ftsIdx = lines.findIndex((l) => l.includes("fts.ts"));
		const newIdx = lines.findIndex((l) => l.includes("vectors.ts"));
		expect(newIdx).toBe(ftsIdx + 1);
	});

	it("returns null for unknown component", () => {
		expect(appendFileToComponent(baseContent, "Unknown", "src/foo.ts")).toBeNull();
	});

	it("returns null when component has no File lines", () => {
		const content = `### Component: Empty\nSome description\n### Component: Other\n`;
		expect(appendFileToComponent(content, "Empty", "src/foo.ts")).toBeNull();
	});
});
