// Ground truth: Empty catch blocks
// Expected: 2 detections (lines 4, 10)

try { doSomething(); } catch (e) { }

// Safe — has content
try { doSomething(); } catch (e) { console.error(e); }

try {
  riskyOp();
} catch {
}

// Intentional — should NOT be detected
try { cleanup(); } catch { /* fail-open */ }
