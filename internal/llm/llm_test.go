package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(serverURL string) *Client {
	c := &Client{client: newAnthropicClient("test-key")}
	c.client.baseURL = serverURL
	return c
}

func mockServer(responseText string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := messagesResponse{
			Content: []contentBlock{{Type: "text", Text: responseText}},
		}
		json.NewEncoder(w).Encode(resp)
	}))
}

func TestExtractDecisions_ParsesValidJSON(t *testing.T) {
	server := mockServer(`[{"topic":"Use SQLite for storage","decision":"Chose SQLite because it is lightweight and requires no server","reasoning":"simplicity","file_paths":["internal/store/store.go"]}]`)
	defer server.Close()

	c := newTestClient(server.URL)
	decisions, err := c.ExtractDecisions(context.Background(), longText("I decided to use SQLite for the database layer because it's lightweight and doesn't require a separate server process."))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(decisions) != 1 {
		t.Fatalf("expected 1 decision, got %d", len(decisions))
	}
	if decisions[0].Topic != "Use SQLite for storage" {
		t.Errorf("topic = %q", decisions[0].Topic)
	}
	if len(decisions[0].FilePaths) != 1 || decisions[0].FilePaths[0] != "internal/store/store.go" {
		t.Errorf("file_paths = %v", decisions[0].FilePaths)
	}
}

func TestExtractDecisions_EmptyArray(t *testing.T) {
	server := mockServer(`[]`)
	defer server.Close()

	c := newTestClient(server.URL)
	decisions, err := c.ExtractDecisions(context.Background(), longText("I read the file and it looks fine."))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(decisions) != 0 {
		t.Errorf("expected 0 decisions, got %d", len(decisions))
	}
}

func TestExtractDecisions_StripsCodeFences(t *testing.T) {
	server := mockServer("```json\n[{\"topic\":\"test\",\"decision\":\"test decision\"}]\n```")
	defer server.Close()

	c := newTestClient(server.URL)
	decisions, err := c.ExtractDecisions(context.Background(), longText("Some assistant message with a decision."))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(decisions) != 1 {
		t.Fatalf("expected 1 decision, got %d", len(decisions))
	}
}

func TestExtractDecisions_ShortTextSkipped(t *testing.T) {
	c := &Client{client: newAnthropicClient("test-key")}
	decisions, err := c.ExtractDecisions(context.Background(), "short")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if decisions != nil {
		t.Errorf("expected nil for short text, got %v", decisions)
	}
}

func TestExtractDecisions_CapsAt5(t *testing.T) {
	items := make([]Decision, 8)
	for i := range items {
		items[i] = Decision{Topic: "test", Decision: "test"}
	}
	data, _ := json.Marshal(items)
	server := mockServer(string(data))
	defer server.Close()

	c := newTestClient(server.URL)
	decisions, err := c.ExtractDecisions(context.Background(), longText("A long message with many decisions."))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(decisions) != 5 {
		t.Errorf("expected 5 decisions (capped), got %d", len(decisions))
	}
}

func TestExtractDecisions_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"server error"}}`))
	}))
	defer server.Close()

	c := newTestClient(server.URL)
	_, err := c.ExtractDecisions(context.Background(), longText("Some message."))
	if err == nil {
		t.Error("expected error for 500 response")
	}
}

// longText pads a string to exceed the 100-char minimum.
func longText(s string) string {
	for len(s) < 120 {
		s += " padding"
	}
	return s
}
