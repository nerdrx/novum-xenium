package bridge

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPreparePrivateEnvironment(t *testing.T) {
	keys := []string{"HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "TS_LOGS_DIR"}
	old := make(map[string]string, len(keys))
	for _, key := range keys {
		old[key] = os.Getenv(key)
	}
	t.Cleanup(func() {
		for _, key := range keys {
			_ = os.Setenv(key, old[key])
		}
	})
	dir := t.TempDir()
	if err := preparePrivateEnvironment(dir); err != nil {
		t.Fatal(err)
	}
	for key, suffix := range map[string]string{
		"HOME": "", "XDG_CACHE_HOME": "cache", "XDG_CONFIG_HOME": "config", "TS_LOGS_DIR": "logs",
	} {
		want := dir
		if suffix != "" {
			want = filepath.Join(dir, suffix)
		}
		if got := os.Getenv(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
		if suffix != "" {
			if info, err := os.Stat(want); err != nil || !info.IsDir() {
				t.Errorf("%s directory missing: %v", key, err)
			}
		}
	}
}

func TestParseTargetAndExactAuthorityAllowlist(t *testing.T) {
	target, err := parseTarget("http://odysseus.local:7000/workspace")
	if err != nil {
		t.Fatal(err)
	}
	for _, authority := range []string{"odysseus.local:7000", "ODYSSEUS.LOCAL:7000"} {
		if !target.allows(authority, "http") {
			t.Errorf("expected exact authority %q to be allowed", authority)
		}
	}
	for _, authority := range []string{"odysseus.local:7001", "other.local:7000", "odysseus.local.evil:7000"} {
		if target.allows(authority, "http") {
			t.Errorf("unexpectedly allowed %q", authority)
		}
	}
}

func TestParseInterfacesUsesProvidedAddresses(t *testing.T) {
	got, err := parseInterfaces(`[{"name":"wlan0","index":4,"mtu":1500,"up":true,"multicast":true,"addrs":[{"ip":"192.168.1.12","prefixLen":24}]}]`)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "wlan0" || len(got[0].AltAddrs) != 1 {
		t.Fatalf("unexpected interface parse result: %#v", got)
	}
	if _, err := parseInterfaces(`[{"name":"wlan0","addrs":[{"ip":"not-an-ip","prefixLen":24}]}]`); err == nil {
		t.Fatal("invalid address accepted")
	}
}

func TestProxyForwardsAllowedHTTPAndStreamsResponse(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" || r.Header.Get("Proxy-Connection") != "" {
			t.Error("proxy credentials or hop header leaked upstream")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release // Keep the response open until the client has received the first event.
	}))
	defer func() {
		close(release)
		upstream.Close()
	}()
	target, err := parseTarget("http://allowed.test:7000/")
	if err != nil {
		t.Fatal(err)
	}
	upstreamAddr := upstream.Listener.Addr().String()
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, upstreamAddr)
	}
	proxy := httptest.NewServer(proxyHandlerWithDial(dial, target))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://allowed.test:7000/events", nil)
	req.Header.Set("Proxy-Authorization", "secret")
	req.Header.Set("Proxy-Connection", "keep-alive")
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected proxied status: %d", response.StatusCode)
	}
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "data: first" {
		t.Fatalf("first SSE event was not streamed while upstream stayed open: line=%q err=%v", line, err)
	}
}

func TestProxyCONNECTTunnelRoundTrip(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		conn, err := upstream.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(conn, buf); err == nil {
			_, _ = conn.Write([]byte("pong"))
		}
	}()
	target, err := parseTarget("https://allowed.test:7443/")
	if err != nil {
		t.Fatal(err)
	}
	dial := func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, upstream.Addr().String())
	}
	proxy := httptest.NewServer(proxyHandlerWithDial(dial, target))
	defer proxy.Close()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(proxy.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := fmt.Fprintf(conn, "CONNECT allowed.test:7443 HTTP/1.1\r\nHost: allowed.test:7443\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d, want 200", response.StatusCode)
	}
	if _, err := io.WriteString(conn, "ping"); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 4)
	if _, err := io.ReadFull(reader, got); err != nil || string(got) != "pong" {
		t.Fatalf("CONNECT tunnel response = %q, err=%v", got, err)
	}
}

func TestProxyRejectsDestinationBeforeDial(t *testing.T) {
	var dials atomic.Int32
	target, err := parseTarget("http://allowed.test:7000/")
	if err != nil {
		t.Fatal(err)
	}
	dial := func(context.Context, string, string) (net.Conn, error) {
		dials.Add(1)
		return nil, fmt.Errorf("unexpected dial")
	}
	proxy := httptest.NewServer(proxyHandlerWithDial(dial, target))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://other.test:7000/private", nil)
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("rejected destination status = %d, want 403", response.StatusCode)
	}
	if got := dials.Load(); got != 0 {
		t.Fatalf("rejected destination triggered %d dials", got)
	}
}
