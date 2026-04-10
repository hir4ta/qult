// Ground truth: Test quality smells
// Expected blocking: empty-test (line 5), always-true (line 7), trivial-assertion (line 9), constant-self (line 11)
// Expected advisory: weak-matcher (line 13)

it("does nothing", () => {});

it("always true", () => { expect(true).toBe(true); });

it("trivial", () => { expect(x).toBe(x); });

it("constant", () => { expect("hello").toBe("hello"); });

it("weak", () => { expect(result).toBeTruthy(); });

it("real test", () => { expect(add(1, 2)).toBe(3); });
