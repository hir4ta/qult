// Ground truth: Safe semantic patterns (NO detections expected)
// Expected: 0 detections

try { doSomething(); } catch (e) { handleError(e); }
const result = [1, 2, 3].map(x => x * 2);
console.log(result);
if (x === 5) { doThing(); }
