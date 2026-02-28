package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"math"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/hir4ta/claude-buddy/internal/store"
)

// estimateHandler returns a handler for the buddy_estimate tool.
func estimateHandler(st *store.Store) server.ToolHandlerFunc {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		taskType, _ := request.GetArguments()["task_type"].(string)
		if taskType == "" {
			return mcp.NewToolResultError("task_type is required"), nil
		}
		project, _ := request.GetArguments()["project"].(string)

		estimate, err := EstimateTask(st, project, taskType)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("estimate failed: %v", err)), nil
		}

		data, _ := json.Marshal(estimate)
		return mcp.NewToolResultText(string(data)), nil
	}
}

// TaskEstimate holds the estimated complexity for a task type.
type TaskEstimate struct {
	TaskType       string   `json:"task_type"`
	SessionCount   int      `json:"session_count"`
	MedianTools    int      `json:"median_tool_count"`
	AvgTools       int      `json:"avg_tool_count"`
	P25Tools       int      `json:"p25_tool_count"`
	P75Tools       int      `json:"p75_tool_count"`
	StdDev         float64  `json:"std_dev"`
	SuccessRate    float64  `json:"success_rate"`
	CommonWorkflow []string `json:"common_workflow,omitempty"`
}

// EstimateTask computes task complexity estimates from historical workflow data.
func EstimateTask(st *store.Store, projectPath, taskType string) (*TaskEstimate, error) {
	if st == nil {
		return &TaskEstimate{
			TaskType:     taskType,
			SessionCount: 0,
		}, nil
	}

	workflows, err := st.GetSuccessfulWorkflows(projectPath, taskType, 50)
	if err != nil {
		return nil, fmt.Errorf("get workflows: %w", err)
	}

	allWorkflows, _ := st.GetSuccessfulWorkflows(projectPath, taskType, 100)

	// Count total including failures for success rate.
	totalCount := len(allWorkflows)
	successCount := 0
	for _, w := range allWorkflows {
		if w.Success {
			successCount++
		}
	}

	if len(workflows) == 0 {
		return &TaskEstimate{
			TaskType:     taskType,
			SessionCount: totalCount,
		}, nil
	}

	// Compute median and average tool counts.
	var toolCounts []int
	for _, w := range workflows {
		toolCounts = append(toolCounts, w.ToolCount)
	}

	// Sort for median.
	for i := range toolCounts {
		for j := i + 1; j < len(toolCounts); j++ {
			if toolCounts[j] < toolCounts[i] {
				toolCounts[i], toolCounts[j] = toolCounts[j], toolCounts[i]
			}
		}
	}

	n := len(toolCounts)
	median := toolCounts[n/2]
	p25 := toolCounts[n/4]
	p75 := toolCounts[(n*3)/4]

	sum := 0
	for _, tc := range toolCounts {
		sum += tc
	}
	avg := sum / n

	// Standard deviation.
	meanF := float64(sum) / float64(n)
	var variance float64
	for _, tc := range toolCounts {
		d := float64(tc) - meanF
		variance += d * d
	}
	stddev := math.Sqrt(variance / float64(n))

	var successRate float64
	if totalCount > 0 {
		successRate = float64(successCount) / float64(totalCount)
	}

	// Get most common workflow.
	commonWorkflow, _, _ := st.MostCommonWorkflow(projectPath, taskType, 3)

	return &TaskEstimate{
		TaskType:       taskType,
		SessionCount:   n,
		MedianTools:    median,
		AvgTools:       avg,
		P25Tools:       p25,
		P75Tools:       p75,
		StdDev:         math.Round(stddev*10) / 10,
		SuccessRate:    successRate,
		CommonWorkflow: commonWorkflow,
	}, nil
}
