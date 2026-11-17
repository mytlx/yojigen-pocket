//go:build darwin

package peer

import (
	"context"
	"net"
	"net/netip"
	"os/exec"
	"strings"
	"time"
)

func collectPlatformIPv6() ([]ipv6Candidate, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, false
	}
	meta := map[string]net.Interface{}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp != 0 && iface.Flags&net.FlagLoopback == 0 && iface.Flags&net.FlagPointToPoint == 0 {
			meta[iface.Name] = iface
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	outBytes, err := exec.CommandContext(ctx, "/sbin/ifconfig").Output()
	if err != nil {
		return nil, false
	}
	var out []ipv6Candidate
	var curName string
	for _, line := range strings.Split(string(outBytes), "\n") {
		if len(line) > 0 && line[0] != '\t' && line[0] != ' ' {
			if name, _, ok := strings.Cut(line, ":"); ok {
				curName = strings.TrimSpace(name)
			} else {
				curName = ""
			}
			continue
		}
		iface, ok := meta[curName]
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "inet6 ") {
			continue
		}
		if strings.Contains(trimmed, "deprecated") || strings.Contains(trimmed, "tentative") || strings.Contains(trimmed, "duplicated") || strings.Contains(trimmed, "detached") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 2 {
			continue
		}
		rawAddr, _, _ := strings.Cut(fields[1], "%")
		addr, err := netip.ParseAddr(rawAddr)
		if err != nil || !publicIPv6(addr) {
			continue
		}
		out = append(out, ipv6Candidate{
			addr:       addr,
			ifaceIndex: iface.Index,
			isPhysical: !isVirtualInterfaceName(iface.Name),
			isStable:   !strings.Contains(trimmed, "temporary"),
		})
	}
	return out, true
}

func collectPlatformIPv4() ([]ipv4Candidate, bool) {
	return nil, false
}
