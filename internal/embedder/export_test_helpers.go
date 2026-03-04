package embedder

import "net/http"

// SetTestTransport replaces the HTTP transport of the embedder's client.
// This is exported for use in integration tests from other packages.
func SetTestTransport(e *Embedder, rt http.RoundTripper) {
	e.client.httpClient.Transport = rt
}
