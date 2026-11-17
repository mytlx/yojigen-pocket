package main

import (
	"errors"
	"testing"
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
