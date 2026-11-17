package peer

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/pion/stun/v3"
	"github.com/quic-go/quic-go"
)

var defaultSTUNServers = []string{
	"stun.miwifi.com:3478",
	"stun.chat.bilibili.com:3478",
	"stun.cloudflare.com:3478",
	"stun.qq.com:3478",
}

type stunProbeResult struct {
	addr     netip.AddrPort
	natType  uint8
	errNote  string
	sawFake  bool
}

type stunDispatcher struct {
	mu      sync.Mutex
	pending map[[stun.TransactionIDSize]byte]chan netip.AddrPort
}

func newSTUNDispatcher() *stunDispatcher {
	return &stunDispatcher{pending: map[[stun.TransactionIDSize]byte]chan netip.AddrPort{}}
}

func (d *stunDispatcher) register(id [stun.TransactionIDSize]byte) chan netip.AddrPort {
	ch := make(chan netip.AddrPort, 1)
	d.mu.Lock()
	d.pending[id] = ch
	d.mu.Unlock()
	return ch
}

func (d *stunDispatcher) unregister(id [stun.TransactionIDSize]byte) {
	d.mu.Lock()
	delete(d.pending, id)
	d.mu.Unlock()
}

func (d *stunDispatcher) handlePacket(pkt []byte) {
	if !stun.IsMessage(pkt) {
		return
	}
	msg := new(stun.Message)
	msg.Raw = append([]byte(nil), pkt...)
	if err := msg.Decode(); err != nil {
		return
	}
	var mapped netip.AddrPort
	var xorAddr stun.XORMappedAddress
	if err := xorAddr.GetFrom(msg); err == nil {
		if ip, ok := netip.AddrFromSlice(xorAddr.IP); ok {
			mapped = netip.AddrPortFrom(ip.Unmap(), uint16(xorAddr.Port))
		}
	} else {
		var stdAddr stun.MappedAddress
		if err := stdAddr.GetFrom(msg); err == nil {
			if ip, ok := netip.AddrFromSlice(stdAddr.IP); ok {
				mapped = netip.AddrPortFrom(ip.Unmap(), uint16(stdAddr.Port))
			}
		}
	}
	if !mapped.IsValid() || mapped.Port() == 0 {
		return
	}
	d.mu.Lock()
	ch := d.pending[msg.TransactionID]
	d.mu.Unlock()
	if ch != nil {
		select {
		case ch <- mapped:
		default:
		}
	}
}

func (d *stunDispatcher) queryServer(ctx context.Context, tr *quic.Transport, server string) (netip.AddrPort, bool, error) {
	raddr, err := net.ResolveUDPAddr("udp4", server)
	if err != nil {
		return netip.AddrPort{}, false, err
	}
	sawFake := false
	if ip, ok := netip.AddrFromSlice(raddr.IP); ok && prefixFakeIP.Contains(ip.Unmap()) {
		sawFake = true
	}
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest)
	if err != nil {
		return netip.AddrPort{}, sawFake, err
	}
	ch := d.register(msg.TransactionID)
	defer d.unregister(msg.TransactionID)

	if _, err = tr.WriteTo(msg.Raw, raddr); err != nil {
		return netip.AddrPort{}, sawFake, err
	}
	retry := time.NewTimer(450 * time.Millisecond)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return netip.AddrPort{}, sawFake, ctx.Err()
		case <-retry.C:
			_, _ = tr.WriteTo(msg.Raw, raddr)
		case mapped := <-ch:
			if mapped.Addr().Is4() && !prefixFakeIP.Contains(mapped.Addr()) && !mapped.Addr().IsPrivate() {
				return mapped, sawFake, nil
			}
			return netip.AddrPort{}, sawFake, errors.New("STUN 返回了无效地址")
		}
	}
}

func (d *stunDispatcher) probe(ctx context.Context, tr *quic.Transport, servers []string) stunProbeResult {
	if len(servers) == 0 {
		servers = defaultSTUNServers
	}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	type single struct {
		mapped  netip.AddrPort
		sawFake bool
		err     error
	}
	ch := make(chan single, len(servers))
	for _, srv := range servers {
		srv := srv
		go func() {
			mapped, sawFake, err := d.queryServer(probeCtx, tr, srv)
			ch <- single{mapped: mapped, sawFake: sawFake, err: err}
		}()
	}

	var results []netip.AddrPort
	sawFake := false
	for i := 0; i < len(servers); i++ {
		r := <-ch
		sawFake = sawFake || r.sawFake
		if r.err == nil && r.mapped.IsValid() {
			results = append(results, r.mapped)
			if len(results) >= 2 {
				break
			}
		}
	}
	if len(results) == 0 {
		note := "IPv4 STUN 探测超时，将使用 IPv6 与局域网直通"
		if sawFake {
			note = "IPv4 STUN 可能受代理 Fake-IP 影响，优先使用 IPv6 与局域网"
		}
		return stunProbeResult{natType: natUnknown, errNote: note, sawFake: sawFake}
	}
	nat := natUnknown
	if len(results) >= 2 {
		if results[0].Port() == results[1].Port() && results[0].Addr() == results[1].Addr() {
			nat = natCone
		} else if results[0].Addr() == results[1].Addr() {
			nat = natSymmetric
		}
	}
	return stunProbeResult{addr: results[0], natType: nat, sawFake: sawFake}
}
