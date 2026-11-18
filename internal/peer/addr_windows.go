//go:build windows

package peer

import (
	"net/netip"
	"unsafe"

	"golang.org/x/sys/windows"
)

func collectPlatformIPv6() ([]ipv6Candidate, bool) {
	v6, _, ok := collectWindowsAdapters()
	return v6, ok
}

func collectPlatformIPv4() ([]ipv4Candidate, bool) {
	_, v4, ok := collectWindowsAdapters()
	return v4, ok
}

func collectWindowsAdapters() ([]ipv6Candidate, []ipv4Candidate, bool) {
	flags := uint32(windows.GAA_FLAG_INCLUDE_PREFIX | windows.GAA_FLAG_INCLUDE_GATEWAYS)
	size := uint32(16 << 10)
	var buf []byte
	for i := 0; i < 4; i++ {
		buf = make([]byte, size)
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
		if err == nil {
			break
		}
		if err != windows.ERROR_BUFFER_OVERFLOW {
			return nil, nil, false
		}
	}
	if len(buf) == 0 {
		return nil, nil, false
	}
	var v6 []ipv6Candidate
	var v4 []ipv4Candidate
	for a := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); a != nil; a = a.Next {
		if a.OperStatus != windows.IfOperStatusUp {
			continue
		}
		if a.IfType == windows.IF_TYPE_SOFTWARE_LOOPBACK || a.IfType == windows.IF_TYPE_TUNNEL {
			continue
		}
		name := windows.UTF16PtrToString(a.FriendlyName)
		desc := windows.UTF16PtrToString(a.Description)
		isPhysical := (a.IfType == windows.IF_TYPE_ETHERNET_CSMACD || a.IfType == windows.IF_TYPE_IEEE80211) &&
			!isVirtualInterfaceName(name) && !isVirtualInterfaceName(desc)
		hasGateway := a.FirstGatewayAddress != nil
		for u := a.FirstUnicastAddress; u != nil; u = u.Next {
			if u.DadState != windows.IpDadStatePreferred || u.ValidLifetime == 0 || u.PreferredLifetime == 0 {
				continue
			}
			addr, ok := netip.AddrFromSlice(u.Address.IP())
			if !ok {
				continue
			}
			if addr.Is4() {
				if privateLANIPv4(addr) {
					v4 = append(v4, ipv4Candidate{addr: addr, hasGateway: hasGateway, isPhysical: isPhysical})
				}
				continue
			}
			if publicIPv6(addr) {
				v6 = append(v6, ipv6Candidate{
					addr:              addr,
					ifaceIndex:        int(a.Ipv6IfIndex),
					hasGateway:        hasGateway,
					isPhysical:        isPhysical,
					isStable:          u.SuffixOrigin != windows.IpSuffixOriginRandom,
					preferredLifetime: u.PreferredLifetime,
				})
			}
		}
	}
	return v6, v4, true
}
