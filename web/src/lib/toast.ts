/**
 * Minimal toast system — no external dependencies, no React context.
 * Uses DOM directly to avoid React 19 compatibility issues with libraries.
 */

let container: HTMLDivElement | null = null;

function getContainer(): HTMLDivElement {
	if (container) return container;
	container = document.createElement("div");
	container.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;";
	document.body.appendChild(container);
	return container;
}

export function toast(title: string, description?: string, variant: "default" | "success" = "default") {
	const el = document.createElement("div");
	const borderColor = variant === "success" ? "#628141" : "#44403c";
	el.style.cssText = `
		pointer-events:auto;
		background:white;
		border:1px solid ${borderColor}40;
		border-left:3px solid ${borderColor};
		border-radius:8px;
		padding:12px 16px;
		max-width:360px;
		font-family:var(--font-sans, system-ui);
		box-shadow:0 4px 12px rgba(0,0,0,0.08);
		opacity:0;
		transform:translateX(20px);
		transition:opacity 0.2s, transform 0.2s;
	`;

	const titleEl = document.createElement("div");
	titleEl.textContent = title;
	titleEl.style.cssText = `font-size:13px;font-weight:600;color:#1c1917;`;
	el.appendChild(titleEl);

	if (description) {
		const descEl = document.createElement("div");
		descEl.textContent = description;
		descEl.style.cssText = `font-size:12px;color:#78716c;margin-top:2px;`;
		el.appendChild(descEl);
	}

	getContainer().appendChild(el);

	// Animate in
	requestAnimationFrame(() => {
		el.style.opacity = "1";
		el.style.transform = "translateX(0)";
	});

	// Auto dismiss
	setTimeout(() => {
		el.style.opacity = "0";
		el.style.transform = "translateX(20px)";
		setTimeout(() => el.remove(), 200);
	}, 4000);
}
