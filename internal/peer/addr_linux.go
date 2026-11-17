//go:build linux

package peer

import (
	"encoding/hex"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

const (
	ifaFTemporary  = 0x01
	ifaFDadFailed  = 0x08
	ifaFDeprecated = 0x20
	ifaFTentative  = 0x40
)

func collectPlatformIPv6() ([]ipv6Candidate, bool) {
	raw, err := os.ReadFile("/proc/net/if_inet6")
	if err != nil {
		return nil, false
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, false
	}
	up := map[int]bool{}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp != 0 && iface.Flags&net.FlagLoopback == 0 && iface.Flags&net.FlagPointToPoint == 0 {
			up[iface.Index] = !isVirtualInterfaceName(iface.Name)
		}
	}
	var out []ipv6Candidate
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || len(fields[0]) != 32 {
			continue
		}
		b, err := hex.DecodeString(fields[0])
		if err != nil || len(b) != 16 {
			continue
		}
		idx, err := strconv.ParseInt(fields[1], 16, 32)
		if err != nil {
			continue
		}
		physical, ok := up[int(idx)]
		if !ok {
			continue
		}
		flags, err := strconv.ParseUint(fields[4], 16, 32)
		if err != nil || flags&(ifaFDeprecated|ifaFTentative|ifaFDadFailed) != 0 {
			continue
		}
		addr := netip.AddrFrom16([16]byte(b))
		if !publicIPv6(addr) {
			continue
		}
		out = append(out, ipv6Candidate{
			addr:       addr,
			ifaceIndex: int(idx),
			isPhysical: physical,
			isStable:   flags&ifaFTemporary == 0,
		})
	}
	return out, true
}

func collectPlatformIPv4() ([]ipv4Candidate, bool) {
	return nil, false
}
