/**
 * Lightweight Anthropic Messages API client for hook-internal LLM calls.
 * Uses raw fetch() — no SDK dependency.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

interface ClassifyResult {
	intent: string;
	skill: string | null;
}

const INTENT_TO_SKILL: Record<string, string> = {
	research: "/alfred:brief",
	plan: "/alfred:attend",
	implement: "/alfred:attend",
	bugfix: "/alfred:mend",
	review: "/alfred:inspect",
	tdd: "/alfred:tdd",
};

const SYSTEM_PROMPT = `You are an intent classifier. Output ONLY a JSON object, nothing else.

Intents: research, plan, implement, bugfix, review, tdd, save-knowledge, none.
Rules:
- Compound prompts: pick PRIMARY intent
- Chat, questions, greetings, unclear, short fragments → none
- The prompt may be in any language (Japanese, English, etc.)

Respond with EXACTLY: {"intent": "<intent>"}`;

/**
 * Classify user prompt intent via Anthropic Messages API.
 * Returns null on any failure (fail-open).
 */
export async function classifyIntent(
	prompt: string,
	signal: AbortSignal,
): Promise<ClassifyResult | null> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) return null;

	try {
		const resp = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: DEFAULT_MODEL,
				max_tokens: 64,
				system: SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt.slice(0, 500) }],
			}),
			signal,
		});

		if (!resp.ok) return null;

		const data = (await resp.json()) as {
			content?: Array<{ type: string; text?: string }>;
		};
		const text = data.content?.[0]?.text?.trim();
		if (!text) return null;

		const parsed = JSON.parse(text) as { intent?: string };
		const intent = parsed.intent ?? "none";
		const skill = INTENT_TO_SKILL[intent] ?? null;

		return { intent, skill };
	} catch {
		return null; // fail-open: timeout, network error, parse error
	}
}
