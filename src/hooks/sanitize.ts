/** Strip ANSI escape sequences and non-printable control characters from a string.
 *  Used for all stderr output to prevent terminal injection from untrusted data
 *  (plan files, reviewer output, file paths). */
export function sanitizeForStderr(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping ANSI escapes requires matching ESC byte
	const noAnsi = input.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars by definition requires matching them
	return noAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
