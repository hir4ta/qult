package hookhandler

import (
	"strconv"
	"time"

	"github.com/hir4ta/claude-buddy/internal/sessiondb"
)

// EWMA smoothing factor: alpha=0.3 gives ~70% weight to history, 30% to latest.
const ewmaAlpha = 0.3

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

	// Velocity delta tracking: snapshot every 5 events, detect sudden drops.
	flowEventCount := int(getFloat(sdb, "flow_event_count")) + 1
	_ = sdb.SetContext("flow_event_count", strconv.Itoa(flowEventCount))
	if flowEventCount%5 == 0 {
		prevSnapshot := getFloat(sdb, "prev_velocity_snapshot")
		_ = sdb.SetContext("prev_velocity_snapshot", strconv.FormatFloat(newVel, 'f', 4, 64))
		if prevSnapshot > 0 {
			delta := newVel - prevSnapshot
			_ = sdb.SetContext("velocity_delta", strconv.FormatFloat(delta, 'f', 4, 64))
			// Wall detection: sharp velocity drop from productive state.
			if delta < -3.0 && prevSnapshot > 5.0 {
				_ = sdb.SetContext("wall_detected", "true")
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
}

// isInFlow returns true if the session is in a productive flow state:
// high velocity (>5 tools/min) and low error rate (<0.1).
func isInFlow(sdb *sessiondb.SessionDB) bool {
	vel := getFloat(sdb, "ewma_tool_velocity")
	errRate := getFloat(sdb, "ewma_error_rate")
	return vel > 5 && errRate < 0.1
}

// suggestionFatigue returns true if the user is ignoring most suggestions,
// indicated by a very low acceptance rate.
func suggestionFatigue(sdb *sessiondb.SessionDB) bool {
	rate := getFloat(sdb, "ewma_acceptance_rate")
	// Only consider fatigue if we have enough data (rate will be 0 initially).
	if rate == 0 {
		return false
	}
	return rate < 0.1
}

// updateAcceptanceRate updates the EWMA acceptance rate when a suggestion
// outcome is known. accepted=true means the user acted on the suggestion.
func updateAcceptanceRate(sdb *sessiondb.SessionDB, accepted bool) {
	var val float64
	if accepted {
		val = 1.0
	}
	prev := getFloat(sdb, "ewma_acceptance_rate")
	newRate := ewmaUpdate(prev, val, ewmaAlpha)
	_ = sdb.SetContext("ewma_acceptance_rate", strconv.FormatFloat(newRate, 'f', 4, 64))
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

func getFloat(sdb *sessiondb.SessionDB, key string) float64 {
	s, _ := sdb.GetContext(key)
	if s == "" {
		return 0
	}
	v, _ := strconv.ParseFloat(s, 64)
	return v
}
