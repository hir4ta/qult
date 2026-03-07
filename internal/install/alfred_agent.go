package install

import _ "embed"

//go:embed content/agents/alfred.md
var alfredAgentContent string

//go:embed content/agents/code-reviewer.md
var codeReviewerAgentContent string
