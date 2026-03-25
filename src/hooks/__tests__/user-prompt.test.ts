import { describe, expect, it } from "vitest";
import { classifyIntent, type PromptIntent } from "../user-prompt.js";

describe("classifyIntent", () => {
	// ═══════════════════════════════════════════════════════════════
	// IMPLEMENTATION — English
	// ═══════════════════════════════════════════════════════════════

	describe("English implementation", () => {
		it.each([
			"implement the login feature",
			"fix the bug in auth",
			"fix this",
			"refactor the database layer",
			"add a new endpoint for users",
			"create the migration script",
			"update the error handling",
			"remove the deprecated API",
			"delete the unused imports",
			"optimize the database queries",
			"migrate to the new schema",
			"build the notification system",
			"replace the old logger with pino",
			"extract the validation logic into a helper",
			"split this file into smaller modules",
			"merge these two configs",
			"rename this variable to something clearer",
			"move this function to utils",
			"convert this to async/await",
			"integrate the payment API",
			"enable dark mode",
			"disable the rate limiter in dev",
			"configure eslint for the project",
			"wrap this in a try-catch",
			"extend the base class",
			"introduce a caching layer",
			"scaffold a new module",
			"plan the authentication flow",
			"design the database schema",
			"architect the microservice",
			"make the button bigger",
			"write a test for the auth module",
			"change the default timeout to 30s",
			"modify the config to support env vars",
			"improve the error messages",
			"fix the bug in the auth module",
		])("'%s' → implementation", (prompt) => {
			expect(classifyIntent(prompt)).toBe("implementation");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// IMPLEMENTATION — Japanese
	// ═══════════════════════════════════════════════════════════════

	describe("Japanese implementation", () => {
		it.each([
			"ログイン機能を実装して",
			"バグを修正して",
			"新しいAPIエンドポイントを追加",
			"データベース層をリファクタして",
			"古いAPIを削除して",
			"クエリを最適化して",
			"エラーハンドリングを改善して",
			"この関数をutilsに移動して",
			"設定ファイルを変更して",
			"テストを書いて",
			"認証モジュールを構築して",
			"DBスキーマを更新して",
			"不要なコードを消して",
			"ロガーを差し替えて",
			"バリデーションロジックを抽出して",
			"このファイルを分割して",
			"2つの設定をマージして",
			"キャッシュ層を導入して",
			"ダークモードに対応して",
			"レートリミッターを無効化して",
			"新しいアーキテクチャを設計しよう",
			"認証フローの計画を立てよう",
			"マイクロサービスのアーキテクチャを設計して",
			"Phase 2の実装に進んで",
		])("'%s' → implementation", (prompt) => {
			expect(classifyIntent(prompt)).toBe("implementation");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// QUESTION — English
	// ═══════════════════════════════════════════════════════════════

	describe("English question — question words", () => {
		it.each([
			"what is this function doing?",
			"what does this middleware do?",
			"how does the auth module work?",
			"how is this different from the old approach?",
			"why is this test failing?",
			"why are we using this library?",
			"when should I use this pattern?",
			"where is the config file?",
			"which version of Node are we using?",
			"who wrote this code?",
		])("'%s' → question", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	describe("English question — question mark", () => {
		it.each([
			"is this implementation correct?",
			"does this handle edge cases?",
			"are there any security issues?",
			"could this cause a memory leak?",
			"should I add a try-catch here?",
		])("'%s' → question", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	describe("English question — exclusion starters", () => {
		it.each([
			"review the changes I made",
			"explain how this algorithm works",
			"describe the architecture",
			"summarize what changed in this PR",
			"analyze the performance bottleneck",
			"show me the error logs",
			"find the config file",
			"list all the routes",
			"debug the failing test",
		])("'%s' → question", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// QUESTION — Japanese
	// ═══════════════════════════════════════════════════════════════

	describe("Japanese question", () => {
		it.each([
			"このパターンとは",
			"このエラーって何",
			"この関数は何をしている？",
			"なぜこのライブラリを使っているの？",
			"どうやってテストを書けばいい？",
		])("'%s' → question", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	describe("Japanese question — exclusion starters", () => {
		it.each([
			"説明してほしい",
			"教えてほしい",
			"レビューしてほしい",
			"確認してほしい",
			"調べてほしい",
		])("'%s' → question", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// FALSE POSITIVE prevention
	// (contain impl keywords but are questions)
	// ═══════════════════════════════════════════════════════════════

	describe("false positive prevention", () => {
		it.each([
			"what does implement do here?",
			"how should I fix this?",
			"can you explain the build process?",
			"should we refactor this?",
			"is this optimization worth it?",
			"この実装で正しい？",
		])("'%s' → question (not implementation)", (prompt) => {
			expect(classifyIntent(prompt)).toBe("question");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// NEGATION
	// ═══════════════════════════════════════════════════════════════

	describe("negation — English", () => {
		it.each([
			"don't implement this yet",
			"do not add this feature",
			"don't fix this now",
			"won't implement until next sprint",
			"shouldn't change the API",
		])("'%s' → neutral", (prompt) => {
			expect(classifyIntent(prompt)).toBe("neutral");
		});
	});

	describe("negation — Japanese", () => {
		it.each([
			"まだ実装しない",
			"実装はまだ早い",
			"追加するな",
			"修正は不要",
			"削除はやめて",
		])("'%s' → neutral", (prompt) => {
			expect(classifyIntent(prompt)).toBe("neutral");
		});
	});

	// ═══════════════════════════════════════════════════════════════
	// NEUTRAL
	// ═══════════════════════════════════════════════════════════════

	describe("neutral", () => {
		it.each([
			"hello",
			"ok",
			"thanks",
			"yes",
			"no",
			"LGTM",
		])("'%s' → neutral", (prompt) => {
			expect(classifyIntent(prompt)).toBe("neutral");
		});
	});
});
