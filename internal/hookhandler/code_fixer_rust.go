package hookhandler

import (
	"strings"
)

// rustFixer generates patches for Rust code quality findings.
type rustFixer struct{}

func (r *rustFixer) Fix(finding Finding, content []byte) *CodeFix {
	switch {
	case finding.Rule == "rs_unwrap" || finding.Rule == "rs-unwrap" ||
		strings.Contains(finding.Message, ".unwrap()"):
		return r.fixUnwrap(finding, content)
	case finding.Rule == "rs_todo_macro" || finding.Rule == "rs-todo-macro" ||
		strings.Contains(finding.Message, "todo!()"):
		return r.fixTodoMacro(finding, content)
	case finding.Rule == "rs_unsafe_no_comment" || finding.Rule == "rs-unsafe-no-safety" ||
		strings.Contains(finding.Message, "SAFETY"):
		return r.fixUnsafeNoSafety(finding, content)
	case finding.Rule == "rs-clone-overuse" ||
		strings.Contains(finding.Message, ".clone()"):
		return r.fixCloneOveruse(finding, content)
	}
	return nil
}

// fixUnwrap replaces .unwrap() with the ? operator.
// The ? operator only works in functions returning Result/Option, so we scan
// backwards for the enclosing fn signature to validate applicability.
func (r *rustFixer) fixUnwrap(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !strings.Contains(line, ".unwrap()") {
		return nil
	}
	before := strings.TrimSpace(line)
	after := strings.Replace(before, ".unwrap()", "?", 1)

	// Scan backwards from the finding line for the enclosing fn signature.
	confidence := 0.55 // default: can't determine return type
	lines := strings.Split(string(content), "\n")
	for i := finding.Line - 2; i >= 0 && i >= finding.Line-40; i-- {
		l := lines[i]
		trimmed := strings.TrimSpace(l)
		if strings.Contains(l, "-> Result") || strings.Contains(l, "-> Option") {
			confidence = 0.8
			break
		}
		// Found fn signature without Result/Option — ? operator won't compile.
		if strings.HasPrefix(trimmed, "fn ") || strings.HasPrefix(trimmed, "pub fn ") ||
			strings.HasPrefix(trimmed, "pub(crate) fn ") {
			if strings.Contains(l, "->") {
				// Has return type but not Result/Option
				return nil
			}
			// No return type at all (returns ()) — ? won't work
			return nil
		}
	}

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  confidence,
		Explanation: "Replace `.unwrap()` with `?` — unwrap panics on Err/None, `?` propagates the error (requires fn to return Result/Option)",
	}
}

// fixTodoMacro replaces todo!() with unimplemented!().
// Before: todo!("handle this")
// After:  unimplemented!("handle this")
func (r *rustFixer) fixTodoMacro(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !strings.Contains(line, "todo!") {
		return nil
	}
	before := strings.TrimSpace(line)
	after := strings.Replace(before, "todo!", "unimplemented!", 1)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.7,
		Explanation: "Replace `todo!()` with `unimplemented!()` — both panic, but `unimplemented!` communicates permanent limitation vs temporary placeholder",
	}
}

// fixUnsafeNoSafety adds a // SAFETY: comment above an unsafe block.
// Before: unsafe { ptr.write(val); }
// After:  // SAFETY: document why this is sound
//
//	unsafe { ptr.write(val); }
func (r *rustFixer) fixUnsafeNoSafety(finding Finding, content []byte) *CodeFix {
	line := getLine(content, finding.Line)
	if line == "" || !strings.Contains(line, "unsafe") {
		return nil
	}
	before := strings.TrimSpace(line)

	// Detect indentation from the original line.
	indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
	after := indent + "// SAFETY: TODO document the invariants that make this sound\n" + line
	after = strings.TrimSpace(after)

	return &CodeFix{
		Finding:     finding,
		Before:      before,
		After:       after,
		Confidence:  0.85,
		Explanation: "Add `// SAFETY:` comment — document the invariants that make this unsafe block sound",
	}
}

// fixCloneOveruse suggests using references/borrows instead of cloning.
func (r *rustFixer) fixCloneOveruse(finding Finding, _ []byte) *CodeFix {
	return &CodeFix{
		Finding:     finding,
		Before:      "(multiple .clone() calls)",
		After:       "(use references or borrows where possible)",
		Confidence:  0.5,
		Explanation: "Excessive `.clone()` — consider borrowing with `&` or using `Cow<T>` for copy-on-write semantics",
	}
}
