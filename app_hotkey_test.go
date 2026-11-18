package main

import "testing"

func TestResolveHotkeyInputModes(t *testing.T) {
	calledSelection := false
	calledClipboard := false
	reset := func() {
		calledSelection = false
		calledClipboard = false
	}
	sel := func(v string) func() string {
		return func() string {
			calledSelection = true
			return v
		}
	}
	clip := func(v string) func() string {
		return func() string {
			calledClipboard = true
			return v
		}
	}

	reset()
	if got := resolveHotkeyInput("", sel("abc"), clip("xyz")); got != "abc" || !calledSelection || calledClipboard {
		t.Errorf("default mode got=%q sel=%v clip=%v", got, calledSelection, calledClipboard)
	}

	reset()
	if got := resolveHotkeyInput("clipboard", sel("abc"), clip("xyz")); got != "xyz" || calledSelection || !calledClipboard {
		t.Errorf("clipboard mode got=%q sel=%v clip=%v", got, calledSelection, calledClipboard)
	}

	reset()
	if got := resolveHotkeyInput("clipboard", sel("abc"), clip("   \n  ")); got != "" {
		t.Errorf("whitespace clipboard should return empty, got %q", got)
	}

	reset()
	if got := resolveHotkeyInput("both", sel("abc"), clip("xyz")); got != "abc" || !calledSelection || calledClipboard {
		t.Errorf("both mode with selection should skip clipboard, got=%q sel=%v clip=%v", got, calledSelection, calledClipboard)
	}

	reset()
	if got := resolveHotkeyInput("both", sel(""), clip("xyz")); got != "xyz" || !calledSelection || !calledClipboard {
		t.Errorf("both mode without selection should fall back to clipboard, got=%q sel=%v clip=%v", got, calledSelection, calledClipboard)
	}

	reset()
	if got := resolveHotkeyInput("none", sel("abc"), clip("xyz")); got != "" || calledSelection || calledClipboard {
		t.Errorf("none mode should read neither, got=%q sel=%v clip=%v", got, calledSelection, calledClipboard)
	}
}
