package providers

import "testing"

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"1.10.0", "1.2.0", 1},
		{"1.0.0-alpha.1", "1.0.0", -1},
		{"1.0.0-beta", "1.0.0-alpha", 1},
		{"1.0.0-alpha.1", "1.0.0-alpha.beta", -1},
		{"2.0.0", "1.9.9", 1},
	}
	for _, tc := range cases {
		if got := CompareSemver(tc.a, tc.b); got != tc.want {
			t.Errorf("CompareSemver(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestSelectCompatibleArtifactAndBuildStore(t *testing.T) {
	reg := &ExtensionRegistry{
		Schema:    1,
		UpdatedAt: "2026-11-19T00:00:00Z",
		Extensions: []RegistryExtension{
			{
				ID:          "peer",
				Name:        "口袋直传",
				Icon:        "svg:send",
				Tools:       []string{"口袋直传"},
				Permissions: Permissions{Peer: true, Files: true},
				RegistryArtifact: RegistryArtifact{
					Version: "2.0.0",
					API:     3,
					URL:     "https://example.com/peer-2.0.0.zip",
					SHA256:  "hash-v2",
				},
				Compat: map[string]RegistryArtifact{
					"2": {Version: "1.2.0", API: 2, URL: "https://example.com/peer-1.2.0.zip", SHA256: "hash-1.2"},
					"3": {Version: "2.0.0", API: 3, URL: "https://example.com/peer-2.0.0.zip", SHA256: "hash-v2"},
				},
			},
			{
				ID:   "editors",
				Name: "写作与代码",
				Icon: "local-relative.png", // 未安装时相对路径图标应安全退回内置图标
				RegistryArtifact: RegistryArtifact{
					Version: "1.0.0",
					API:     1,
					URL:     "https://example.com/editors-1.0.0.zip",
					SHA256:  "hash-ed",
				},
			},
			{
				ID:   "future",
				Name: "未来扩展",
				RegistryArtifact: RegistryArtifact{
					Version: "1.0.0",
					API:     99,
					URL:     "https://example.com/future.zip",
					SHA256:  "hash-fut",
				},
			},
		},
	}

	installed := []PluginInfo{
		{ID: "peer", Title: "口袋直传", Version: "1.1.0", Enabled: true},
	}

	items := BuildStoreExtensions(reg, installed, 2)
	if len(items) != 3 {
		t.Fatalf("len(items) = %d, want 3", len(items))
	}
	// 排序优先级：update_available(peer) -> not_installed(editors) -> incompatible(future)
	if items[0].ID != "peer" || items[1].ID != "editors" || items[2].ID != "future" {
		t.Fatalf("unexpected order: %+v", items)
	}

	peer := items[0]
	if peer.Status != StoreStatusUpdateAvailable || peer.InstallableVersion != "1.2.0" || peer.InstallableAPI != 2 || !peer.RequiresAppUpdate {
		t.Fatalf("peer store item mismatch: %+v", peer)
	}

	editors := items[1]
	if editors.Status != StoreStatusNotInstalled || editors.Icon != "svg:puzzle" {
		t.Fatalf("editors store item mismatch: %+v", editors)
	}

	future := items[2]
	if future.Status != StoreStatusIncompatible || !future.RequiresAppUpdate || future.DownloadURL != "" {
		t.Fatalf("future store item mismatch: %+v", future)
	}
}

func TestResolveDownloadURLs(t *testing.T) {
	raw := "https://github.com/mytlx/yojigen-pocket/releases/download/v0.2.0/editors-1.0.0.zip"
	urls, err := ResolveDownloadURLs(raw, "")
	if err != nil || len(urls) != 1 || urls[0] != raw {
		t.Fatalf("no mirror: got=%v err=%v", urls, err)
	}

	urls, err = ResolveDownloadURLs(raw, "https://gh-proxy.com")
	if err != nil || len(urls) != 2 || urls[0] != "https://gh-proxy.com/"+raw || urls[1] != raw {
		t.Fatalf("prefix mirror: got=%v err=%v", urls, err)
	}

	urls, err = ResolveDownloadURLs(raw, "https://mirror.example.com/get?u={url}")
	if err != nil || len(urls) != 2 || urls[0] != "https://mirror.example.com/get?u="+raw {
		t.Fatalf("template mirror: got=%v err=%v", urls, err)
	}

	if _, err := ResolveDownloadURLs("file:///C:/a.zip", ""); err == nil {
		t.Fatal("expected error for non-http URL")
	}
	if _, err := ResolveDownloadURLs(raw, "ftp://bad-mirror.local"); err == nil {
		t.Fatal("expected error for non-http mirror")
	}
}
