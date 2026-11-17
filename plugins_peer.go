package main

import (
	"errors"
	"path/filepath"

	"github.com/egoist/mygo"
	"yojigen-pocket/internal/peer"
	"yojigen-pocket/internal/providers"
)

// Peer services are owned by the host, so closing a webview cannot silently
// kill a transfer. All teardown paths use TryClose, which atomically rejects
// shutdown while file operations are active.
func (h *pluginHost) peerService(id string, create bool) (*peer.Service, error) {
	h.peerMu.Lock()
	defer h.peerMu.Unlock()
	if h.peerStopping {
		return nil, errors.New("应用正在退出")
	}
	if p := h.peers[id]; p != nil {
		return p, nil
	}
	if !create {
		return nil, errors.New("请先打开点对点传输")
	}
	downloads, err := mygo.App.Path(mygo.PathDownloads)
	if err != nil {
		return nil, err
	}
	p, err := peer.New(peer.Config{DataDir: filepath.Join(h.a.paths.Data, "plugins", id+"-files"), ReceiveDir: filepath.Join(downloads, "Pocket Transfers")})
	if err != nil {
		return nil, err
	}
	if h.peers == nil {
		h.peers = map[string]*peer.Service{}
	}
	h.peers[id] = p
	return p, nil
}
func (h *pluginHost) stopPeer(id string) error {
	h.peerMu.Lock()
	defer h.peerMu.Unlock()
	p := h.peers[id]
	if p == nil {
		return nil
	}
	if err := p.TryClose(); err != nil {
		return err
	}
	delete(h.peers, id)
	return nil
}
func (h *pluginHost) closePeersForQuit() error {
	h.peerMu.Lock()
	defer h.peerMu.Unlock()
	for _, p := range h.peers {
		if p.Busy() {
			return peer.ErrBusy
		}
	}
	// TryClose gates incoming offers and send calls under the same service lock.
	for id, p := range h.peers {
		if err := p.TryClose(); err != nil {
			return err
		}
		delete(h.peers, id)
	}
	h.peerStopping = true
	return nil
}
func (h *pluginHost) peerNotice(id string, err error) {
	if err != nil {
		PluginEvent.Broadcast(PluginEventData{Plugin: id, Name: "peer:error", Data: err.Error()})
	}
}
func (h *pluginHost) peerCall(m providers.Manifest, id, name string, args callArgs, win *mygo.Window) (any, error) {
	if !m.Permissions.Peer {
		return nil, errPermission
	}
	p, err := h.peerService(id, name == "start")
	if err != nil {
		return nil, err
	}
	switch name {
	case "start":
		err := p.Start()
		v := p.Snapshot()
		if err != nil {
			v.Error = err.Error()
		}
		return v, nil
	case "punchPrepare":
		v, err := p.PreparePunch(args.str(0), args.str(1), args.boolean(2))
		if err != nil {
			v.Error = err.Error()
			return v, nil
		}
		return v, nil
	case "punchInspect":
		return peer.PreviewPunchToken(args.str(0), args.str(1))
	case "punchConnect":
		return nil, p.PunchConnect(args.str(0), args.str(1))
	case "state":
		return p.Snapshot(), nil
	case "connect":
		return nil, p.Connect(args.str(0))
	case "accept":
		return nil, p.Accept()
	case "confirm":
		return nil, p.Confirm(args.str(0))
	case "reject":
		return nil, p.Reject()
	case "disconnect":
		return nil, p.Disconnect()
	case "cancel":
		p.Cancel()
		return nil, nil
	case "pick":
		if !m.Permissions.Files {
			return nil, errPermission
		}
		if p.Snapshot().State != "connected" {
			return nil, errors.New("请先完成连接验证")
		}
		files, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: win, Title: "选择要发送的文件", Multiple: true})
		if err != nil {
			return nil, err
		}
		return nil, p.Send(files)
	case "folder":
		if !m.Permissions.Files {
			return nil, errPermission
		}
		if p.Busy() {
			return nil, peer.ErrBusy
		}
		dirs, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: win, Title: "选择接收文件夹", Directory: true, DefaultPath: p.Snapshot().Folder})
		if err != nil || len(dirs) == 0 {
			return nil, err
		}
		return nil, p.SetFolder(dirs[0])
	case "reveal":
		for _, r := range p.Snapshot().Records {
			if r.ID == args.str(0) && r.Status == "completed" && r.Path != "" {
				mygo.Shell.ShowItemInFolder(r.Path)
				return nil, nil
			}
		}
		return nil, errors.New("找不到已完成的文件")
	default:
		return nil, errors.New("不支持的传输操作")
	}
}
func (h *pluginHost) bindPeerWindow(id string, win *mygo.Window) {
	m, _, ok := h.a.plugins.ManifestOf(id)
	if !ok || !m.Permissions.Peer {
		return
	}
	win.OnFileDrop(func(e *mygo.FileDropEvent) {
		if !m.Permissions.Files {
			h.peerNotice(id, errPermission)
			return
		}
		paths := append([]string{}, e.Paths...)
		go func() {
			p, err := h.peerService(id, false)
			if err == nil {
				err = p.Send(paths)
			}
			h.peerNotice(id, err)
		}()
	})
	win.OnClose(func(e *mygo.CloseEvent) {
		if err := h.stopPeer(id); err != nil {
			e.PreventDefault()
			h.peerNotice(id, err)
		}
	})
	win.OnClosed(func() { _ = h.stopPeer(id) })
}
