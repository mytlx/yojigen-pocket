package peer

import (
	"cmp"
	"net"
	"net/netip"
	"slices"
	"strings"
)

var (
	prefixTeredo = netip.MustParsePrefix("2001::/32")
	prefix6to4   = netip.MustParsePrefix("2002::/16")
	prefix3ffe   = netip.MustParsePrefix("3ffe::/16")
	prefixCGNAT  = netip.MustParsePrefix("100.64.0.0/10")
	prefixFakeIP = netip.MustParsePrefix("198.18.0.0/15")
)

type ipv6Candidate struct {
	addr              netip.Addr
	ifaceIndex        int
	hasGateway        bool
	isPhysical        bool
	isStable          bool
	preferredLifetime uint32
}

type ipv4Candidate struct {
	addr       netip.Addr
	hasGateway bool
	isPhysical bool
}

func publicIPv6(ip netip.Addr) bool {
	if !ip.Is6() || ip.Is4In6() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	return !prefixTeredo.Contains(ip) && !prefix6to4.Contains(ip) && !prefix3ffe.Contains(ip)
}

func privateLANIPv4(ip netip.Addr) bool {
	if !ip.Is4() || !ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	return !prefixCGNAT.Contains(ip) && !prefixFakeIP.Contains(ip)
}

// Addresses returns active, non-deprecated global IPv6 addresses ordered by
// interface reachability and address stability, deduplicating redundant aliases
// within the same /64 prefix on an interface.
func Addresses() []string {
	candidates, ok := collectPlatformIPv6()
	if !ok {
		candidates = collectGenericIPv6()
	}
	return selectPreferredIPv6(candidates)
}

func localIPv4s() []netip.Addr {
	candidates, ok := collectPlatformIPv4()
	if !ok {
		candidates = collectGenericIPv4()
	}
	return selectPreferredIPv4(candidates)
}

func selectPreferredIPv6(candidates []ipv6Candidate) []string {
	type groupKey struct {
		iface  int
		prefix netip.Prefix
	}
	grouped := map[groupKey]ipv6Candidate{}
	for _, c := range candidates {
		if !publicIPv6(c.addr) {
			continue
		}
		key := groupKey{iface: c.ifaceIndex, prefix: netip.PrefixFrom(c.addr, 64).Masked()}
		prev, exists := grouped[key]
		if !exists || betterIPv6Candidate(c, prev) {
			grouped[key] = c
		}
	}
	best := make([]ipv6Candidate, 0, len(grouped))
	for _, c := range grouped {
		best = append(best, c)
	}
	slices.SortFunc(best, compareIPv6Candidate)
	out := make([]string, 0, len(best))
	seen := make(map[string]struct{}, len(best))
	for _, c := range best {
		s := c.addr.String()
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func betterIPv6Candidate(a, b ipv6Candidate) bool {
	return compareIPv6Candidate(a, b) < 0
}

func compareIPv6Candidate(a, b ipv6Candidate) int {
	if a.hasGateway != b.hasGateway {
		return boolDesc(a.hasGateway, b.hasGateway)
	}
	if a.isPhysical != b.isPhysical {
		return boolDesc(a.isPhysical, b.isPhysical)
	}
	if a.isStable != b.isStable {
		return boolDesc(a.isStable, b.isStable)
	}
	if a.preferredLifetime != b.preferredLifetime {
		return cmp.Compare(b.preferredLifetime, a.preferredLifetime)
	}
	return strings.Compare(a.addr.String(), b.addr.String())
}

func selectPreferredIPv4(candidates []ipv4Candidate) []netip.Addr {
	filtered := make([]ipv4Candidate, 0, len(candidates))
	for _, c := range candidates {
		if privateLANIPv4(c.addr) {
			filtered = append(filtered, c)
		}
	}
	slices.SortFunc(filtered, func(a, b ipv4Candidate) int {
		if a.hasGateway != b.hasGateway {
			return boolDesc(a.hasGateway, b.hasGateway)
		}
		if a.isPhysical != b.isPhysical {
			return boolDesc(a.isPhysical, b.isPhysical)
		}
		return strings.Compare(a.addr.String(), b.addr.String())
	})
	out := make([]netip.Addr, 0, len(filtered))
	seen := make(map[netip.Addr]struct{}, len(filtered))
	for _, c := range filtered {
		if _, dup := seen[c.addr]; dup {
			continue
		}
		seen[c.addr] = struct{}{}
		out = append(out, c.addr)
	}
	return out
}

func boolDesc(a, b bool) int {
	if a == b {
		return 0
	}
	if a {
		return -1
	}
	return 1
}

func isVirtualInterfaceName(name string) bool {
	low := strings.ToLower(name)
	for _, token := range []string{"mihomo", "clash", "tun", "tap", "wg", "wireguard", "tailscale", "zerotier", "vethernet", "vmware", "virtualbox", "vbox", "docker", "podman", "wsl", "hyper-v", "utun", "awdl", "llw", "bridge"} {
		if strings.Contains(low, token) {
			return true
		}
	}
	return false
}

func collectGenericIPv6() []ipv6Candidate {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []ipv6Candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagPointToPoint != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		physical := !isVirtualInterfaceName(iface.Name)
		for _, a := range addrs {
			p, err := netip.ParsePrefix(a.String())
			if err != nil || !publicIPv6(p.Addr()) {
				continue
			}
			out = append(out, ipv6Candidate{addr: p.Addr(), ifaceIndex: iface.Index, isPhysical: physical, isStable: true})
		}
	}
	return out
}

func collectGenericIPv4() []ipv4Candidate {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []ipv4Candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagPointToPoint != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		physical := !isVirtualInterfaceName(iface.Name)
		for _, a := range addrs {
			p, err := netip.ParsePrefix(a.String())
			if err != nil || !privateLANIPv4(p.Addr()) {
				continue
			}
			out = append(out, ipv4Candidate{addr: p.Addr(), isPhysical: physical})
		}
	}
	return out
}
