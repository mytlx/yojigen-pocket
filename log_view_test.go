package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"yojigen-pocket/internal/store"
)

func TestLogPagesAndFilteredExport(t *testing.T) {
	dir := t.TempDir()
	settings := Settings{a: &App{paths: store.Paths{Logs: dir}}}
	path := filepath.Join(dir, "app.log")
	const info = "2026/11/18 10:00:00 启动\n"
	const failure = "2026/11/18 10:00:01 [ERROR] 网络异常\n原因详情\n"
	if err := os.WriteFile(path, []byte(strings.Repeat(info, 500)+failure+info), 0600); err != nil {
		t.Fatal(err)
	}
	first, err := settings.LogPage(0, "", false)
	if err != nil || !first.More || len(first.Entries) != 500 {
		t.Fatal(err, len(first.Entries))
	}
	next, err := settings.LogPage(first.Offset, first.Generation, false)
	if err != nil || len(next.Entries) != 3 || !next.Entries[0].Error || !next.Entries[1].Error || next.Entries[2].Error {
		t.Fatal(err, next)
	}
	all := info + failure + info
	for _, onlyErrors := range []bool{false, true} {
		var out bytes.Buffer
		if err := copyLog(strings.NewReader(all), &out, onlyErrors); err != nil {
			t.Fatal(err)
		}
		want := all
		if onlyErrors {
			want = failure
		}
		if out.String() != want {
			t.Fatal(out.String())
		}
	}
	if err := os.Rename(path, path+".1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(info), 0600); err != nil {
		t.Fatal(err)
	}
	fresh, err := settings.LogPage(next.Offset, next.Generation, false)
	if err != nil || !fresh.Reset || len(fresh.Entries) != 1 {
		t.Fatal(err, fresh)
	}
}
