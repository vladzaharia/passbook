package passbook

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Every generated Go snippet builds against this SDK: the same text the reference pages show.
func TestSnippetsCompile(t *testing.T) {
	sdk, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../../docs/developers/snippets/generated/go/*.go")
	if err != nil || len(files) < 150 {
		t.Fatalf("found %d snippets, err %v", len(files), err)
	}
	dir := t.TempDir()
	gomod := "module snippets\n\ngo 1.22\n\nrequire github.com/vladzaharia/passbook/sdk/go v0.0.0\n\nreplace github.com/vladzaharia/passbook/sdk/go => " + sdk + "\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(gomod), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		name := strings.NewReplacer(".", "_").Replace(strings.TrimSuffix(filepath.Base(f), ".go"))
		out := filepath.Join(dir, "cmd", name)
		if err := os.MkdirAll(out, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(out, "main.go"), src, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command("go", "vet", "./...")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go vet: %v\n%s", err, out)
	}
}
