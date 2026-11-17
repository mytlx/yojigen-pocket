package main

import (
	"errors"
	"testing"
	"yojigen-pocket/internal/peer"
	"yojigen-pocket/internal/providers"
)

func TestPeerPermissionAndFileBoundary(t *testing.T) {
	a, _ := newTestPluginApp(t)
	h := newPluginHost(a)
	if _, err := h.peerCall(providers.Manifest{}, "editors", "start", nil, nil); !errors.Is(err, errPermission) {
		t.Fatal("peer capability not checked", err)
	}
	_, err := h.peerService("editors", true)
	if err != nil {
		t.Fatal(err)
	}
	defer h.stopPeer("editors")
	manifest := providers.Manifest{Permissions: providers.Permissions{Peer: true}}
	for _, op := range []string{"pick", "folder"} {
		if _, err := h.peerCall(manifest, "editors", op, nil, nil); !errors.Is(err, errPermission) {
			t.Fatalf("%s did not check file permission: %v", op, err)
		}
	}
	if _, err := h.peerCall(manifest, "editors", "send", callArgs{"/etc/passwd"}, nil); err == nil {
		t.Fatal("arbitrary path send exposed")
	}
	if _, err := h.peerCall(manifest, "editors", "reveal", callArgs{"/etc/passwd"}, nil); err == nil {
		t.Fatal("arbitrary reveal exposed")
	}
	if err := h.closePeersForQuit(); err != nil {
		t.Fatal(err)
	}
	if _, err := h.peerService("editors", true); err == nil {
		t.Fatal("service recreated while quitting")
	}
}

func TestPeerHostPunchCalls(t *testing.T) {
	a, _ := newTestPluginApp(t)
	h := newPluginHost(a)
	if _, err := h.peerCall(providers.Manifest{}, "peer", "punchPrepare", nil, nil); !errors.Is(err, errPermission) {
		t.Fatal("punchPrepare did not check peer permission", err)
	}
	manifest := providers.Manifest{Permissions: providers.Permissions{Peer: true}}
	if _, err := h.peerCall(manifest, "peer", "start", nil, nil); err != nil {
		t.Fatal(err)
	}
	defer h.stopPeer("peer")

	res, err := h.peerCall(manifest, "peer", "punchPrepare", callArgs{"2468", "", false}, nil)
	if err != nil {
		t.Fatal(err)
	}
	snap, ok := res.(peer.Snapshot)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if snap.Punch != nil && snap.Punch.Token != "" {
		insp, err := h.peerCall(manifest, "peer", "punchInspect", callArgs{snap.Punch.Token}, nil)
		if err != nil {
			t.Fatal(err)
		}
		m, ok := insp.(map[string]bool)
		if !ok || !m["encrypted"] {
			t.Fatalf("expected encrypted inspection, got %+v", insp)
		}
	}
}
