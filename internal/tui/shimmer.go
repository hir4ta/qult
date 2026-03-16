package tui

import (
	"image/color"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// shimmerTickMsg triggers shimmer animation frame advance.
type shimmerTickMsg time.Time

// shimmerInterval controls animation smoothness. 80ms = 12.5 FPS (~5.5s cycle).
const shimmerInterval = 80 * time.Millisecond

// shimmerCmd returns a command that ticks the shimmer animation.
func shimmerCmd() tea.Cmd {
	return tea.Tick(shimmerInterval, func(t time.Time) tea.Msg {
		return shimmerTickMsg(t)
	})
}

// shimmerBandLen is the number of gradient steps in the sweep band.
const shimmerBandLen = 20

// shimmerGradient is the pre-built gradient via lipgloss.Blend1D.
// base-dim → peak-bright → base-dim
var shimmerGradient []color.Color

// shimmerStyles is pre-cached lipgloss styles for each gradient position.
var shimmerStyles []lipgloss.Style

// shimmerBoldStyles is the bold variant.
var shimmerBoldStyles []lipgloss.Style

// shimmerBaseStyle is the pre-cached style for characters outside the band.
var shimmerBaseStyle lipgloss.Style

// shimmerBaseBoldStyle is the bold variant.
var shimmerBaseBoldStyle lipgloss.Style

func init() {
	// Orange shimmer: dark warm → soft orange → dark warm.
	baseColor := lipgloss.Color("#5a4a3a") // warm brown (brighter for readability)
	peakColor := lipgloss.Color("#e69875") // orange

	// Blend1D: base → peak → base (symmetric sweep).
	shimmerGradient = lipgloss.Blend1D(shimmerBandLen, baseColor, peakColor, baseColor)

	// Pre-cache styles.
	shimmerStyles = make([]lipgloss.Style, len(shimmerGradient))
	shimmerBoldStyles = make([]lipgloss.Style, len(shimmerGradient))
	for i, c := range shimmerGradient {
		shimmerStyles[i] = lipgloss.NewStyle().Foreground(c)
		shimmerBoldStyles[i] = lipgloss.NewStyle().Bold(true).Foreground(c)
	}

	shimmerBaseStyle = lipgloss.NewStyle().Foreground(baseColor)
	shimmerBaseBoldStyle = lipgloss.NewStyle().Bold(true).Foreground(baseColor)
}

// renderShimmer applies a smooth left-to-right shimmer sweep to text.
func renderShimmer(text string, frame int) string {
	return shimmerRender(text, frame, shimmerStyles, shimmerBaseStyle)
}

// renderShimmerBold is like renderShimmer but with bold text.
func renderShimmerBold(text string, frame int) string {
	return shimmerRender(text, frame, shimmerBoldStyles, shimmerBaseBoldStyle)
}

// shimmerRender is the shared implementation.
// Batches consecutive same-styled characters to minimize ANSI escape output.
func shimmerRender(text string, frame int, gradStyles []lipgloss.Style, baseStyle lipgloss.Style) string {
	runes := []rune(text)
	n := len(runes)
	if n == 0 {
		return text
	}

	gradLen := len(gradStyles)
	// Cycle: sweep across text, then a brief dark gap before next sweep.
	cycleLen := n + gradLen + 12
	pos := frame % cycleLen

	var buf strings.Builder
	buf.Grow(len(text) * 3)

	// Track current style index to batch characters. -1 = base, 0+ = gradient.
	prevIdx := -2 // sentinel
	var batch []rune

	flush := func() {
		if len(batch) == 0 {
			return
		}
		s := string(batch)
		if prevIdx < 0 {
			buf.WriteString(baseStyle.Render(s))
		} else {
			buf.WriteString(gradStyles[prevIdx].Render(s))
		}
		batch = batch[:0]
	}

	for i := range runes {
		offset := i - pos + gradLen
		var idx int
		if offset >= 0 && offset < gradLen {
			idx = offset
		} else {
			idx = -1
		}

		if idx != prevIdx && prevIdx != -2 {
			flush()
		}
		prevIdx = idx
		batch = append(batch, runes[i])
	}
	flush()

	return buf.String()
}
