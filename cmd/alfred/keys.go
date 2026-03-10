package main

import (
	"charm.land/bubbles/v2/help"
	"charm.land/bubbles/v2/key"
)

// Shared key bindings reused across TUI screens.
var (
	keyQuit = key.NewBinding(
		key.WithKeys("q"),
		key.WithHelp("q", "quit"),
	)
	keyForceQuit = key.NewBinding(
		key.WithKeys("ctrl+c"),
		key.WithHelp("ctrl+c", "force quit"),
	)
	keyEnter = key.NewBinding(
		key.WithKeys("enter"),
		key.WithHelp("enter", "confirm"),
	)
	keyEsc = key.NewBinding(
		key.WithKeys("esc"),
		key.WithHelp("esc", "back"),
	)
	keyUp = key.NewBinding(
		key.WithKeys("up", "k"),
		key.WithHelp("↑/k", "up"),
	)
	keyDown = key.NewBinding(
		key.WithKeys("down", "j"),
		key.WithHelp("↓/j", "down"),
	)
	keyLeft = key.NewBinding(
		key.WithKeys("left", "h"),
		key.WithHelp("←/h", "prev page"),
	)
	keyRight = key.NewBinding(
		key.WithKeys("right", "l"),
		key.WithHelp("→/l", "next page"),
	)
	keyHelp = key.NewBinding(
		key.WithKeys("?"),
		key.WithHelp("?", "help"),
	)
)

// newHelp creates a help model with alfred styling.
func newHelp() help.Model {
	h := help.New()
	h.ShortSeparator = " · "
	return h
}

// simpleKeyMap implements help.KeyMap for a flat list of bindings.
type simpleKeyMap []key.Binding

var _ help.KeyMap = simpleKeyMap(nil)

func (k simpleKeyMap) ShortHelp() []key.Binding  { return k }
func (k simpleKeyMap) FullHelp() [][]key.Binding { return [][]key.Binding{k} }
