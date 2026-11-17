//go:build e2e

package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"yojigen-pocket/internal/peer"
)

var peerFixture struct {
	sync.Mutex
	remote *peer.Service
}

// PeerFixture creates a real second IPv6 loopback node, in the test user's
// private directory. There are no mocks and no external network connections.
func (e *E2E) PeerFixture() error {
	h := e.a.pluginHost
	if err := h.stopPeer("peer"); err != nil {
		return err
	}
	peerFixture.Lock()
	defer peerFixture.Unlock()
	if peerFixture.remote != nil {
		peerFixture.remote.Cancel()
		_ = peerFixture.remote.TryClose()
	}
	base := filepath.Join(e.a.paths.Home, "peer-e2e")
	local, err := peer.NewLoopback(peer.Config{DataDir: filepath.Join(base, "local"), ReceiveDir: filepath.Join(base, "received")})
	if err != nil {
		return err
	}
	if err = local.Start(); err != nil {
		return err
	}
	remote, err := peer.NewLoopback(peer.Config{DataDir: filepath.Join(base, "remote"), ReceiveDir: filepath.Join(base, "remote-received")})
	if err != nil {
		_ = local.TryClose()
		return err
	}
	if err = remote.Start(); err != nil {
		_ = local.TryClose()
		return err
	}
	h.peerMu.Lock()
	if h.peers == nil {
		h.peers = map[string]*peer.Service{}
	}
	h.peers["peer"] = local
	h.peerMu.Unlock()
	peerFixture.remote = remote
	return remote.ConnectLoopback(local)
}
func (e *E2E) PeerCode() string {
	peerFixture.Lock()
	defer peerFixture.Unlock()
	if peerFixture.remote == nil {
		return ""
	}
	return peerFixture.remote.Snapshot().Code
}
func (e *E2E) PeerTransfer() (bool, error) {
	p, err := e.a.pluginHost.peerService("peer", false)
	if err != nil {
		return false, err
	}
	path := filepath.Join(e.a.paths.Home, "peer-e2e", "测试文件.txt")
	if err = os.WriteFile(path, bytes.Repeat([]byte("Pocket IPv6 transfer\n真实双节点文件校验\n"), 1<<19), 0600); err != nil {
		return false, err
	}
	if err = p.Send([]string{path}); err != nil {
		return false, err
	}
	blocked := errors.Is(e.a.pluginHost.closePeersForQuit(), peer.ErrBusy)
	return blocked, nil
}
func (e *E2E) PeerReceive() error {
	peerFixture.Lock()
	defer peerFixture.Unlock()
	if peerFixture.remote == nil {
		return errors.New("no fixture")
	}
	path := filepath.Join(e.a.paths.Home, "peer-e2e", "接收文件.txt")
	if err := os.WriteFile(path, []byte("From remote node"), 0600); err != nil {
		return err
	}
	return peerFixture.remote.Send([]string{path})
}
