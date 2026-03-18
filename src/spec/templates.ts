import type { SpecFile, SpecSize, SpecType } from "./types.js";
import { filesForSize } from "./types.js";

export interface TemplateData {
	taskSlug: string;
	description: string;
	date: string;
	specType: string;
}

export function renderForSize(
	size: SpecSize,
	specType: SpecType,
	data: TemplateData,
): Map<SpecFile, string> {
	const lang = (process.env.ALFRED_LANG || "en").toLowerCase();
	const files = filesForSize(size, specType);
	const rendered = new Map<SpecFile, string>();
	for (const f of files) {
		rendered.set(f, renderTemplate(f, data, lang));
	}
	return rendered;
}

function renderTemplate(file: SpecFile, data: TemplateData, lang: string): string {
	if (lang === "ja") return renderTemplateJa(file, data);
	return renderTemplateEn(file, data);
}

// ---------- English templates (default) ----------

function renderTemplateEn(file: SpecFile, data: TemplateData): string {
	switch (file) {
		case "requirements.md":
			return `# Requirements: ${data.taskSlug}

> ${data.description || "No description provided."}

## Goal

<!-- Define the primary goal of this task -->

## Functional Requirements

### FR-1: [Requirement Title]

<!-- confidence: 5 | source: inference | grounding: inferred -->

## Non-Functional Requirements

<!-- NFR-1: Performance, security, etc. -->
`;

		case "bugfix.md":
			return `# Bugfix: ${data.taskSlug}

> ${data.description || "No description provided."}

## Bug Summary

## Severity & Impact

<!-- P0-P3 -->

## Reproduction Steps

1.

## Root Cause Analysis

### 5 Whys

1. Why?

## Fix Strategy

## Regression Prevention
`;

		case "delta.md":
			return `# Delta: ${data.taskSlug}

> ${data.description || "No description provided."}

## Change Summary

## Files Affected

### CHG-1: [Change description]

- File:
- Before:
- After:

## Rationale

## Impact Scope

## Test Plan

## Rollback Strategy
`;

		case "design.md":
			return `# Design: ${data.taskSlug}

## System Context

## Components

## Data Flow

## Traceability Matrix

| Req ID | Component | Task ID | Test ID |
|--------|-----------|---------|---------|
| FR-1   |           | T-1.1   | TS-1.1  |
`;

		case "tasks.md":
			return `# Tasks: ${data.taskSlug}

## Wave 1: Core Implementation

### T-1.1: [Task Title]

- Requirements: FR-1
- Files:
- Risk: low
- Verify:

## Wave: Closing

- [ ] Self-review from multiple perspectives
- [ ] Update CLAUDE.md if needed
- [ ] Verify tests pass
- [ ] Save key learnings to knowledge
`;

		case "test-specs.md":
			return `# Test Specs: ${data.taskSlug}

## TS-1.1: [Test Title]

- Source: FR-1
- Category: unit
- Speed: fast

\`\`\`gherkin
Given [precondition]
When [action]
Then [expected result]
\`\`\`
`;

		case "research.md":
			return `# Research: ${data.taskSlug}

## Discovery

## Gap Analysis

## Options

## Done Criteria
`;

		case "session.md":
			return `# Session: ${data.taskSlug}

- Date: ${data.date}
- Status: active
- Spec Type: ${data.specType}

## Currently Working On

## Next Steps

- [ ] Review generated spec files
- [ ] Fill in requirements details
`;

		default:
			return `# ${file}\n`;
	}
}

// ---------- Japanese templates ----------

function renderTemplateJa(file: SpecFile, data: TemplateData): string {
	switch (file) {
		case "requirements.md":
			return `# 要件定義: ${data.taskSlug}

> ${data.description || "説明なし"}

## ゴール

<!-- このタスクの主目標を定義 -->

## 機能要件

### FR-1: [要件タイトル]

<!-- confidence: 5 | source: inference | grounding: inferred -->

## 非機能要件

<!-- NFR-1: パフォーマンス、セキュリティ等 -->
`;

		case "bugfix.md":
			return `# バグ修正: ${data.taskSlug}

> ${data.description || "説明なし"}

## バグ概要

## 重要度と影響範囲

<!-- P0-P3 -->

## 再現手順

1.

## 原因分析

### 5 Whys

1. なぜ？

## 修正方針

## リグレッション防止策
`;

		case "delta.md":
			return `# 差分変更: ${data.taskSlug}

> ${data.description || "説明なし"}

## 変更概要

## 影響ファイル

### CHG-1: [変更内容]

- File:
- Before:
- After:

## 変更理由

## 影響範囲

## テスト計画

## ロールバック手順
`;

		case "design.md":
			return `# 設計: ${data.taskSlug}

## システムコンテキスト

## コンポーネント

## データフロー

## トレーサビリティマトリクス

| Req ID | Component | Task ID | Test ID |
|--------|-----------|---------|---------|
| FR-1   |           | T-1.1   | TS-1.1  |
`;

		case "tasks.md":
			return `# タスク: ${data.taskSlug}

## Wave 1: コア実装

### T-1.1: [タスクタイトル]

- Requirements: FR-1
- Files:
- Risk: low
- Verify:

## Wave: Closing

- [ ] 多角的セルフレビュー
- [ ] 必要に応じて CLAUDE.md を更新
- [ ] テスト通過を確認
- [ ] 重要な学びをナレッジに保存
`;

		case "test-specs.md":
			return `# テスト仕様: ${data.taskSlug}

## TS-1.1: [テストタイトル]

- Source: FR-1
- Category: unit
- Speed: fast

\`\`\`gherkin
Given [前提条件]
When [操作]
Then [期待結果]
\`\`\`
`;

		case "research.md":
			return `# リサーチ: ${data.taskSlug}

## 調査結果

## ギャップ分析

## 選択肢

## 完了基準
`;

		case "session.md":
			return `# セッション: ${data.taskSlug}

- Date: ${data.date}
- Status: active
- Spec Type: ${data.specType}

## 現在の作業

## 次のステップ

- [ ] 生成された spec ファイルをレビュー
- [ ] 要件の詳細を記入
`;

		default:
			return `# ${file}\n`;
	}
}
