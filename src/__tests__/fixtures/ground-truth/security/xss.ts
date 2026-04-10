// Ground truth: XSS patterns
// Expected: 2 detections (lines 4, 7)

element.innerHTML = userInput;

const html = userContent;
document.write(html);

// Safe — should NOT be detected
element.textContent = userInput;
