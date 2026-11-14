//go:build windows

package platform

import "testing"

func TestFormatAltSpaceAccelerator(t *testing.T) {
	cases := []struct {
		win, ctrl, shift bool
		want             string
	}{
		{false, false, false, "Alt+Space"},
		{false, false, true, "Alt+Shift+Space"},
		{false, true, false, "Ctrl+Alt+Space"},
		{true, false, false, "Win+Alt+Space"},
		{true, true, true, "Win+Ctrl+Alt+Shift+Space"},
	}
	for _, tc := range cases {
		if got := formatAltSpaceAccelerator(tc.win, tc.ctrl, tc.shift); got != tc.want {
			t.Errorf("formatAltSpaceAccelerator(%v, %v, %v) = %q, want %q", tc.win, tc.ctrl, tc.shift, got, tc.want)
		}
	}
}
