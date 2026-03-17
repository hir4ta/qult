import type { SpecFile, SpecSize, SpecType } from './types.js';
import { filesForSize } from './types.js';

export interface TemplateData {
  taskSlug: string;
  description: string;
  date: string;
  specType: string;
}

export function renderForSize(
  size: SpecSize,
  specType: SpecType,
  data: TemplateData,
): Map<SpecFile, string> {
  const files = filesForSize(size, specType);
  const rendered = new Map<SpecFile, string>();
  for (const f of files) {
    rendered.set(f, renderTemplate(f, data));
  }
  return rendered;
}

function renderTemplate(file: SpecFile, data: TemplateData): string {
  switch (file) {
    case 'requirements.md':
      return `# Requirements: ${data.taskSlug}

> ${data.description || 'No description provided.'}

## Goal

<!-- Define the primary goal of this task -->

## Functional Requirements

### FR-1: [Requirement Title]

<!-- confidence: 5 | source: inference | grounding: inferred -->

## Non-Functional Requirements

<!-- NFR-1: Performance, security, etc. -->
`;

    case 'bugfix.md':
      return `# Bugfix: ${data.taskSlug}

> ${data.description || 'No description provided.'}

## Bug Summary

## Severity & Impact

<!-- P0-P3 -->

## Reproduction Steps

1.

## Root Cause Analysis

### 5 Whys

1. Why?

## Fix Strategy

## Regression Prevention
`;

    case 'delta.md':
      return `# Delta: ${data.taskSlug}

> ${data.description || 'No description provided.'}

## Change Summary

## Files Affected

### CHG-1: [Change description]

- File:
- Before:
- After:

## Rationale

## Impact Scope

## Test Plan

## Rollback Strategy
`;

    case 'design.md':
      return `# Design: ${data.taskSlug}

## System Context

## Components

## Data Flow

## Traceability Matrix

| Req ID | Component | Task ID | Test ID |
|--------|-----------|---------|---------|
| FR-1   |           | T-1.1   | TS-1.1  |
`;

    case 'tasks.md':
      return `# Tasks: ${data.taskSlug}

## Wave 1: Core Implementation

### T-1.1: [Task Title]

- Requirements: FR-1
- Files:
- Risk: low
- Verify:

## Wave: Closing

- [ ] Self-review from multiple perspectives
- [ ] Update CLAUDE.md if needed
- [ ] Verify tests pass
- [ ] Save key learnings to knowledge
`;

    case 'test-specs.md':
      return `# Test Specs: ${data.taskSlug}

## TS-1.1: [Test Title]

- Source: FR-1
- Category: unit
- Speed: fast

\`\`\`gherkin
Given [precondition]
When [action]
Then [expected result]
\`\`\`
`;

    case 'decisions.md':
      return `# Decisions: ${data.taskSlug}

## DEC-1: [Decision Title]

- Status: proposed
- Context:
- Chosen:
- Rationale:
- Alternatives:
`;

    case 'research.md':
      return `# Research: ${data.taskSlug}

## Discovery

## Gap Analysis

## Options

## Done Criteria
`;

    case 'session.md':
      return `# Session: ${data.taskSlug}

- Date: ${data.date}
- Status: active
- Spec Type: ${data.specType}

## Currently Working On

## Next Steps

- [ ] Review generated spec files
- [ ] Fill in requirements details
`;

    default:
      return `# ${file}\n`;
  }
}
