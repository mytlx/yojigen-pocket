//go:build !windows && !linux && !darwin

package peer

func collectPlatformIPv6() ([]ipv6Candidate, bool) {
	return nil, false
}

func collectPlatformIPv4() ([]ipv4Candidate, bool) {
	return nil, false
}
