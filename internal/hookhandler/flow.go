package hookhandler

import (
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/hir4ta/claude-alfred/internal/sessiondb"
	"github.com/hir4ta/claude-alfred/internal/store"
)

// EWMA smoothing factor: alpha=0.3 gives ~70% weight to history, 30% to latest.
const ewmaAlpha = 0.3

// ewmvK is the number of standard deviations for adaptive control limits.
const ewmvK = 2.0

// minEWMVSamples is the minimum events before EWMV-based detection kicks in.
const minEWMVSamples = 8

// ewmaUpdate computes the exponential weighted moving average.
// Uses a sentinel of -1 to distinguish "never initialized" from "converged to 0".
// Callers store "" (empty string) in sessiondb initially; getFloat returns 0,
// so we use an explicit initialized flag via the caller instead.
func ewmaUpdate(prev, value, alpha float64) float64 {
	return alpha*value + (1-alpha)*prev
}

// updateFlowMetrics records a tool event and updates EWMA velocity and error rate.
// Call from PostToolUse (isFailure=false) and PostToolUseFailure (isFailure=true).
func updateFlowMetrics(sdb *sessiondb.SessionDB, isFailure bool) {
	now := time.Now()

	// Compute velocity: tools per minute since last event.
	var velocity float64
	if lastStr, _ := sdb.GetContext("flow_last_event_at"); lastStr != "" {
		if last, err := time.Parse(time.RFC3339Nano, lastStr); err == nil {
			elapsed := now.Sub(last).Seconds()
			if elapsed > 0 && elapsed < 300 { // ignore gaps > 5 min
				velocity = 60.0 / elapsed // tools per minute
			}
		}
	}
	_ = sdb.SetContext("flow_last_event_at", now.Format(time.RFC3339Nano))

	// Update EWMA velocity.
	prevVel := getFloat(sdb, "ewma_tool_velocity")
	newVel := ewmaUpdate(prevVel, velocity, ewmaAlpha)
	_ = sdb.SetContext("ewma_tool_velocity", strconv.FormatFloat(newVel, 'f', 4, 64))

	// Update EWMV (exponential weighted moving variance) for velocity.
	velDev := velocity - prevVel // deviation from previous EWMA mean
	prevVelVar := getFloat(sdb, "ewmv_velocity_var")
	newVelVar := ewmaUpdate(prevVelVar, velDev*velDev, ewmaAlpha)
	_ = sdb.SetContext("ewmv_velocity_var", strconv.FormatFloat(newVelVar, 'f', 6, 64))

	// Velocity delta tracking: snapshot every 5 events, detect sudden drops.
	flowEventCount := int(getFloat(sdb, "flow_event_count")) + 1
	_ = sdb.SetContext("flow_event_count", strconv.Itoa(flowEventCount))
	if flowEventCount%5 == 0 {
		prevSnapshot := getFloat(sdb, "prev_velocity_snapshot")
		_ = sdb.SetContext("prev_velocity_snapshot", strconv.FormatFloat(newVel, 'f', 4, 64))
		if prevSnapshot > 0 {
			delta := newVel - prevSnapshot
			_ = sdb.SetContext("velocity_delta", strconv.FormatFloat(delta, 'f', 4, 64))

			// Adaptive wall detection using EWMV control limits.
			sigma := math.Sqrt(newVelVar)
			if flowEventCount >= minEWMVSamples && sigma > 0.5 {
				// Velocity dropped below mean - k*sigma AND dropped by 50%+.
				lowerBound := newVel - ewmvK*sigma
				if velocity < lowerBound && velocity < prevSnapshot*0.5 {
					_ = sdb.SetContext("wall_detected", "true")
				}
			} else {
				// Fallback: fixed threshold for early session.
				if delta < -3.0 && prevSnapshot > 5.0 {
					_ = sdb.SetContext("wall_detected", "true")
				}
			}
		}
	}

	// Update EWMA error rate.
	var errVal float64
	if isFailure {
		errVal = 1.0
	}
	prevErr := getFloat(sdb, "ewma_error_rate")
	newErr := ewmaUpdate(prevErr, errVal, ewmaAlpha)
	_ = sdb.SetContext("ewma_error_rate", strconv.FormatFloat(newErr, 'f', 4, 64))

	// Update EWMV for error rate.
	errDev := errVal - prevErr
	prevErrVar := getFloat(sdb, "ewmv_error_var")
	newErrVar := ewmaUpdate(prevErrVar, errDev*errDev, ewmaAlpha)
	_ = sdb.SetContext("ewmv_error_var", strconv.FormatFloat(newErrVar, 'f', 6, 64))
}

// FlowState represents the session's current productivity state.
// Used for graduated suggestion suppression instead of binary on/off.
type FlowState int

const (
	// FlowNormal: deliver all suggestions at their base priority.
	FlowNormal FlowState = iota
	// FlowProductive: high velocity + low errors + success streak.
	// Defer Medium and below; keep High and Critical.
	FlowProductive
	// FlowThrashing: high velocity but high error rate.
	// User is active but struggling — promote warnings, suppress info.
	FlowThrashing
	// FlowStalled: low velocity. Deliver everything, especially next-step.
	FlowStalled
	// FlowFatigued: user ignoring suggestions. Reduce to Critical/High only.
	FlowFatigued
)

// classifyFlowState determines the session's current flow state
// from multiple signals: velocity, error rate, acceptance rate, and success streak.
func classifyFlowState(sdb *sessiondb.SessionDB) FlowState {
	vel := getFloat(sdb, "ewma_tool_velocity")
	errRate := getFloat(sdb, "ewma_error_rate")
	acceptance := getFloat(sdb, "ewma_acceptance_rate")
	streak := getInt(sdb, "success_streak")

	// Fatigue overrides other states — user is ignoring suggestions.
	if acceptance > 0 && acceptance < 0.1 {
		return FlowFatigued
	}

	// High velocity + low errors + success streak = genuine productivity.
	if vel > 5 && errRate < 0.1 && streak >= 3 {
		return FlowProductive
	}

	// High velocity + high errors = thrashing, not real flow.
	if vel > 5 && errRate > 0.25 {
		return FlowThrashing
	}

	// Low velocity = stalled.
	if vel > 0 && vel < 2 {
		return FlowStalled
	}

	return FlowNormal
}

// FlowDetail controls content detail level based on the session's flow state.
// Used to adapt verbosity, alternative count, and content inclusion dynamically.
type FlowDetail struct {
	Budget          int  // character budget for output
	IncludeWhy      bool // whether to include WHY rationale in suggestions
	IncludeCoChange bool // whether to include co-change alternatives
	MaxAlternatives int  // maximum number of alternatives to present
}

// flowDetail returns content detail settings adapted to the current flow state.
func flowDetail(sdb *sessiondb.SessionDB) FlowDetail {
	state := classifyFlowState(sdb)
	switch state {
	case FlowProductive:
		return FlowDetail{Budget: 800, IncludeWhy: false, IncludeCoChange: false, MaxAlternatives: 1}
	case FlowStalled, FlowThrashing:
		return FlowDetail{Budget: 3000, IncludeWhy: true, IncludeCoChange: true, MaxAlternatives: 5}
	case FlowFatigued:
		return FlowDetail{Budget: 1500, IncludeWhy: true, IncludeCoChange: false, MaxAlternatives: 2}
	default: // FlowNormal
		return FlowDetail{Budget: 2000, IncludeWhy: true, IncludeCoChange: true, MaxAlternatives: 3}
	}
}

// flowBudget returns the character budget for output based on current flow state.
// Productive flow gets minimal output; stalled/thrashing gets more detail.
func flowBudget(sdb *sessiondb.SessionDB) int {
	return flowDetail(sdb).Budget
}

// isInFlow returns true if the session is in a productive flow state.
// Kept for backward compatibility with MCP tools (alfred_current_state).
func isInFlow(sdb *sessiondb.SessionDB) bool {
	return classifyFlowState(sdb) == FlowProductive
}

// suggestionFatigue returns true if the user is ignoring most suggestions,
// indicated by a very low acceptance rate.
func suggestionFatigue(sdb *sessiondb.SessionDB) bool {
	return classifyFlowState(sdb) == FlowFatigued
}

// getInt reads an integer value from sessiondb context.
func getInt(sdb *sessiondb.SessionDB, key string) int {
	s, _ := sdb.GetContext(key)
	if s == "" {
		return 0
	}
	v, _ := strconv.Atoi(s)
	return v
}

// IsWallDetected returns true if a velocity wall was detected.
func IsWallDetected(sdb *sessiondb.SessionDB) bool {
	v, _ := sdb.GetContext("wall_detected")
	return v == "true"
}

// ClearWallDetected resets the wall detection flag.
func ClearWallDetected(sdb *sessiondb.SessionDB) {
	_ = sdb.SetContext("wall_detected", "")
}

// VelocityDelta returns the most recent velocity change between snapshots.
func VelocityDelta(sdb *sessiondb.SessionDB) float64 {
	return getFloat(sdb, "velocity_delta")
}

// VelocitySigma returns the standard deviation of velocity from EWMV.
func VelocitySigma(sdb *sessiondb.SessionDB) float64 {
	return math.Sqrt(getFloat(sdb, "ewmv_velocity_var"))
}

// ErrorRateSigma returns the standard deviation of error rate from EWMV.
func ErrorRateSigma(sdb *sessiondb.SessionDB) float64 {
	return math.Sqrt(getFloat(sdb, "ewmv_error_var"))
}

// FlowEventCount returns the total number of flow events tracked.
func FlowEventCount(sdb *sessiondb.SessionDB) int {
	return int(getFloat(sdb, "flow_event_count"))
}

// recordHealthSnapshot saves a health measurement every 10 tool calls.
// Health score is a composite of velocity and error rate, normalized to [0, 1].
func recordHealthSnapshot(sdb *sessiondb.SessionDB) {
	tc, _, _, _ := sdb.BurstState()
	if tc == 0 || tc%10 != 0 {
		return
	}

	vel := getFloat(sdb, "ewma_tool_velocity")
	errRate := getFloat(sdb, "ewma_error_rate")

	// Health = velocity component (0-0.6) + error component (0-0.4).
	velScore := math.Min(vel/15.0, 1.0) * 0.6
	errScore := (1.0 - math.Min(errRate/0.5, 1.0)) * 0.4
	health := velScore + errScore

	_ = sdb.RecordHealthSnapshot(tc, health, vel, errRate)
}

// HealthTrend describes the predicted health trajectory.
type HealthTrend struct {
	CurrentHealth    float64
	Slope            float64 // health change per 10 tools
	ToolsToThreshold int     // predicted tools until health drops below 0.5 (-1 if stable/improving)
	Trend            string  // "improving", "stable", "declining"
	CompoundRisk     float64 // multi-factor risk score (0-1)
	RecoveryPlaybook string  // suggested recovery action
}

// PredictHealthTrend computes a linear regression over recent health snapshots
// and predicts when (if ever) health will cross below 0.5.
func PredictHealthTrend(sdb *sessiondb.SessionDB) *HealthTrend {
	snapshots, err := sdb.RecentHealthSnapshots(10)
	if err != nil || len(snapshots) < 3 {
		return nil
	}

	// OLS linear regression: health = a + b * toolCount.
	n := float64(len(snapshots))
	var sumX, sumY, sumXX, sumXY float64
	for _, s := range snapshots {
		x := float64(s.ToolCount)
		y := s.Health
		sumX += x
		sumY += y
		sumXX += x * x
		sumXY += x * y
	}
	denom := n*sumXX - sumX*sumX
	if denom == 0 {
		return nil
	}
	b := (n*sumXY - sumX*sumY) / denom // slope
	a := (sumY - b*sumX) / n           // intercept

	last := snapshots[len(snapshots)-1]
	currentHealth := last.Health

	// Slope per 10 tools.
	slopePer10 := b * 10

	trend := &HealthTrend{
		CurrentHealth:    currentHealth,
		Slope:            slopePer10,
		ToolsToThreshold: -1,
	}

	switch {
	case slopePer10 > 0.01:
		trend.Trend = "improving"
	case slopePer10 < -0.01:
		trend.Trend = "declining"
		// Predict when health will drop below 0.5.
		if currentHealth > 0.5 && b < 0 {
			// health = a + b*x = 0.5  →  x = (0.5 - a) / b
			xThreshold := (0.5 - a) / b
			toolsRemaining := int(xThreshold) - last.ToolCount
			if toolsRemaining > 0 && toolsRemaining < 500 {
				trend.ToolsToThreshold = toolsRemaining
			}
		}
	default:
		trend.Trend = "stable"
	}

	// Compound risk: velocity decline + error rate + phase stagnation.
	vel := last.Velocity
	errRate := last.ErrorRate
	velRisk := math.Max(0, 1.0-vel/10.0)    // low velocity = high risk
	errRisk := math.Min(errRate/0.5, 1.0)     // high error = high risk
	trendRisk := math.Max(0, -slopePer10*10)  // declining trend = high risk
	trend.CompoundRisk = math.Min(1.0, (velRisk+errRisk+trendRisk)/3.0)

	// Recovery playbook based on dominant risk factor.
	if trend.CompoundRisk > 0.5 {
		switch {
		case errRisk > velRisk && errRisk > trendRisk:
			trend.RecoveryPlaybook = "High error rate. Narrow scope → fix one failure → test → re-plan."
		case velRisk > trendRisk:
			trend.RecoveryPlaybook = "Low velocity. Step back → re-read files → identify the actual blocker."
		default:
			trend.RecoveryPlaybook = "Declining trend. Commit progress → run tests → consider a fresh approach."
		}

		// Add historical recovery time estimate from past sessions.
		taskType, _ := sdb.GetContext("task_type")
		if taskType != "" {
			if st, err := store.OpenDefaultCached(); err == nil {
				if avgTools := st.AverageRecoveryTools(taskType); avgTools > 0 {
					trend.RecoveryPlaybook += fmt.Sprintf(" Recovery typically takes ~%d tools.", avgTools)
				}
			}
		}
	}

	return trend
}

func getFloat(sdb *sessiondb.SessionDB, key string) float64 {
	s, _ := sdb.GetContext(key)
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}
