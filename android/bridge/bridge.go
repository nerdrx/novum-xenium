package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
)

type addressJSON struct {
	IP        string `json:"ip"`
	PrefixLen int    `json:"prefixLen"`
}

type interfaceJSON struct {
	Name      string        `json:"name"`
	Index     int           `json:"index"`
	MTU       int           `json:"mtu"`
	Up        bool          `json:"up"`
	Broadcast bool          `json:"broadcast"`
	Loopback  bool          `json:"loopback"`
	PointToPt bool          `json:"pointToPoint"`
	Multicast bool          `json:"multicast"`
	Addrs     []addressJSON `json:"addrs"`
}

var interfaces struct {
	sync.RWMutex
	list []netmon.Interface
}

var dnsServers struct {
	sync.RWMutex
	list []netip.Addr
	next atomic.Uint64
}

func init() {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		interfaces.RLock()
		defer interfaces.RUnlock()
		if interfaces.list == nil {
			return nil, errors.New("Android interface snapshot not set")
		}
		return append([]netmon.Interface(nil), interfaces.list...), nil
	})

	// Android apps do not have a system resolv.conf. Route Go's pure resolver
	// through DNS servers supplied by ConnectivityManager instead.
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: dialAndroidDNS}
}

func dialAndroidDNS(ctx context.Context, network, _ string) (net.Conn, error) {
	dnsServers.RLock()
	if len(dnsServers.list) == 0 {
		dnsServers.RUnlock()
		return nil, errors.New("Android DNS snapshot not set")
	}
	server := dnsServers.list[dnsServers.next.Add(1)%uint64(len(dnsServers.list))].String()
	dnsServers.RUnlock()
	return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(server, "53"))
}

// Client owns one app-private tsnet node and its local, destination-limited proxy.
type Client struct {
	mu       sync.RWMutex
	server   *tsnet.Server
	local    *local.Client
	proxy    *http.Server
	listener net.Listener
	cancel   context.CancelFunc
	status   clientStatus
	target   targetAuthority
}

type clientStatus struct {
	State    string `json:"state"`
	LoginURL string `json:"loginUrl,omitempty"`
	Error    string `json:"error,omitempty"`
}

type targetAuthority struct {
	host string
	port string
}

// NewClient creates a stopped bridge. State is stored under Start's dataDir.
func NewClient() *Client { return &Client{status: clientStatus{State: "Stopped"}} }

// SetInterfacesJSON accepts NetworkInterface data from Android. Call before Start
// and again after Android reports a network change.
func (c *Client) SetInterfacesJSON(payload string) error {
	parsed, err := parseInterfaces(payload)
	if err != nil {
		return err
	}
	interfaces.Lock()
	interfaces.list = parsed
	interfaces.Unlock()
	return nil
}

// SetDNSJSON accepts the active Android Network's LinkProperties DNS IP list.
func (c *Client) SetDNSJSON(payload string) error {
	var values []string
	if err := json.Unmarshal([]byte(payload), &values); err != nil {
		return fmt.Errorf("decode Android DNS snapshot: %w", err)
	}
	parsed := make([]netip.Addr, 0, len(values))
	for _, value := range values {
		ip, err := netip.ParseAddr(value)
		if err != nil || ip.Zone() != "" {
			return fmt.Errorf("invalid Android DNS address %q", value)
		}
		parsed = append(parsed, ip)
	}
	if len(parsed) == 0 {
		return errors.New("Android DNS snapshot is empty")
	}
	dnsServers.Lock()
	dnsServers.list = parsed
	dnsServers.Unlock()
	return nil
}

// Start joins the configured tailnet and starts a loopback HTTP proxy. serverURL
// supplies the only permitted destination authority, including its port.
func (c *Client) Start(dataDir, serverURL string) error {
	if strings.TrimSpace(dataDir) == "" {
		return errors.New("private state directory is required")
	}
	target, err := parseTarget(serverURL)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server != nil {
		return errors.New("Tailscale bridge is already started")
	}
	interfaces.RLock()
	interfacesReady := len(interfaces.list) > 0
	interfaces.RUnlock()
	dnsServers.RLock()
	dnsReady := len(dnsServers.list) > 0
	dnsServers.RUnlock()
	if !interfacesReady || !dnsReady {
		return errors.New("Android network and DNS snapshots are required before Start")
	}
	stateDir := filepath.Join(dataDir, "tailscale")
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return fmt.Errorf("create private Tailscale state directory: %w", err)
	}
	if err := preparePrivateEnvironment(dataDir); err != nil {
		return err
	}
	srv := &tsnet.Server{Dir: stateDir, Hostname: "novum-xenium-android"}
	if err := srv.Start(); err != nil {
		return fmt.Errorf("start tsnet: %w", err)
	}
	lc, err := srv.LocalClient()
	if err != nil {
		_ = srv.Close()
		return fmt.Errorf("get tsnet local client: %w", err)
	}
	if _, err := lc.EditPrefs(context.Background(), &ipn.MaskedPrefs{
		Prefs:       ipn.Prefs{RouteAll: true},
		RouteAllSet: true,
	}); err != nil {
		_ = srv.Close()
		return fmt.Errorf("enable advertised subnet routes: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		cancel()
		_ = srv.Close()
		return fmt.Errorf("watch Tailscale status: %w", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		watcher.Close()
		cancel()
		_ = srv.Close()
		return fmt.Errorf("listen for local proxy: %w", err)
	}
	proxy := &http.Server{Handler: c.proxyHandler(srv, target), ReadHeaderTimeout: 10 * time.Second}
	c.server, c.local, c.proxy, c.listener, c.cancel, c.target = srv, lc, proxy, ln, cancel, target
	c.status = clientStatus{State: "Starting"}
	go c.watch(ctx, watcher)
	go func() {
		if err := proxy.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			c.setError(err)
		}
	}()
	go c.beginLoginIfNeeded(ctx, lc)
	return nil
}

// Android has no usable process-wide HOME or writable root temp directory.
// Tailscale's logpolicy requires a writable log directory even when tsnet
// state itself has an explicit Dir, so keep all fallback paths app-private.
func preparePrivateEnvironment(dataDir string) error {
	cacheDir := filepath.Join(dataDir, "cache")
	configDir := filepath.Join(dataDir, "config")
	logsDir := filepath.Join(dataDir, "logs")
	for _, dir := range []string{cacheDir, configDir, logsDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return fmt.Errorf("create app-private Tailscale directory: %w", err)
		}
	}
	for key, value := range map[string]string{
		"HOME":            dataDir,
		"XDG_CACHE_HOME":  cacheDir,
		"XDG_CONFIG_HOME": configDir,
		"TS_LOGS_DIR":     logsDir,
	} {
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("configure app-private %s: %w", key, err)
		}
	}
	return nil
}

func (c *Client) beginLoginIfNeeded(ctx context.Context, lc *local.Client) {
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		c.setError(err)
		return
	}
	if status.BackendState == ipn.NeedsLogin.String() {
		if err := lc.StartLoginInteractive(ctx); err != nil {
			c.setError(err)
		}
	}
}

func (c *Client) watch(ctx context.Context, watcher *local.IPNBusWatcher) {
	defer watcher.Close()
	for {
		n, err := watcher.Next()
		if err != nil {
			if ctx.Err() == nil {
				c.setError(err)
			}
			return
		}
		c.mu.Lock()
		if n.State != nil {
			c.status.State = n.State.String()
		}
		if n.BrowseToURL != nil {
			c.status.LoginURL = *n.BrowseToURL
		}
		if n.ErrMessage != nil {
			c.status.Error = *n.ErrMessage
		}
		c.mu.Unlock()
	}
}

// StatusJSON reports Tailscale state and interactive-login URL.
func (c *Client) StatusJSON() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	data, _ := json.Marshal(c.status)
	return string(data)
}

// ProxyAddress returns the HTTP proxy address for WebView ProxyController.
func (c *Client) ProxyAddress() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.listener == nil {
		return ""
	}
	return c.listener.Addr().String()
}

// Stop shuts down the proxy and embedded node, preserving its state directory.
func (c *Client) Stop() error {
	c.mu.Lock()
	srv, proxy, cancel := c.server, c.proxy, c.cancel
	c.server, c.local, c.proxy, c.listener, c.cancel = nil, nil, nil, nil, nil
	c.status = clientStatus{State: "Stopped"}
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	var proxyErr, serverErr error
	if proxy != nil {
		ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
		proxyErr = proxy.Shutdown(ctx)
		done()
	}
	if srv != nil {
		serverErr = srv.Close()
	}
	return errors.Join(proxyErr, serverErr)
}

func (c *Client) proxyHandler(srv *tsnet.Server, target targetAuthority) http.Handler {
	return proxyHandlerWithDial(srv.Dial, target)
}

func proxyHandlerWithDial(dial func(context.Context, string, string) (net.Conn, error), target targetAuthority) http.Handler {
	forward := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.Header.Del("Proxy-Authorization")
			r.Out.Header.Del("Proxy-Connection")
		},
		Transport: &http.Transport{DialContext: dial},
	}
	forward.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		http.Error(w, "tailnet destination unavailable: "+err.Error(), http.StatusBadGateway)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			if !target.allows(r.Host, "https") {
				http.Error(w, "destination denied", http.StatusForbidden)
				return
			}
			tunnel(w, r, dial)
			return
		}
		if !r.URL.IsAbs() || (r.URL.Scheme != "http" && r.URL.Scheme != "https") || r.URL.User != nil ||
			!target.allows(r.URL.Host, r.URL.Scheme) || !target.allows(r.Host, r.URL.Scheme) {
			http.Error(w, "destination denied", http.StatusForbidden)
			return
		}
		forward.ServeHTTP(w, r)
	})
}

func tunnel(w http.ResponseWriter, r *http.Request, dial func(context.Context, string, string) (net.Conn, error)) {
	conn, err := dial(r.Context(), "tcp", r.Host)
	if err != nil {
		http.Error(w, "tailnet destination unavailable", http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = conn.Close()
		http.Error(w, "proxy does not support tunnels", http.StatusInternalServerError)
		return
	}
	client, rw, err := hijacker.Hijack()
	if err != nil {
		_ = conn.Close()
		return
	}
	if _, err := rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err == nil {
		err = rw.Flush()
	}
	if err != nil {
		_ = client.Close()
		_ = conn.Close()
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(conn, rw); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, conn); done <- struct{}{} }()
	<-done
	_ = client.Close()
	_ = conn.Close()
}

func (c *Client) setError(err error) {
	c.mu.Lock()
	c.status.Error = err.Error()
	c.mu.Unlock()
}

func parseTarget(raw string) (targetAuthority, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return targetAuthority{}, errors.New("server URL must be an HTTP or HTTPS URL without credentials")
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return targetAuthority{}, errors.New("server URL port must be between 1 and 65535")
	}
	return targetAuthority{host: strings.TrimSuffix(strings.ToLower(u.Hostname()), "."), port: port}, nil
}

func (target targetAuthority) allows(authority, scheme string) bool {
	u, err := url.Parse("//" + authority)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return false
	}
	port := u.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else if scheme == "http" {
			port = "80"
		} else {
			return false
		}
	}
	return strings.TrimSuffix(strings.ToLower(u.Hostname()), ".") == target.host && port == target.port
}

func parseInterfaces(payload string) ([]netmon.Interface, error) {
	var input []interfaceJSON
	if err := json.Unmarshal([]byte(payload), &input); err != nil {
		return nil, fmt.Errorf("decode Android interfaces: %w", err)
	}
	out := make([]netmon.Interface, 0, len(input))
	for _, item := range input {
		if item.Name == "" {
			return nil, errors.New("Android interface has empty name")
		}
		iface := netmon.Interface{Interface: &net.Interface{Name: item.Name, Index: item.Index, MTU: item.MTU}, AltAddrs: []net.Addr{}}
		if item.Up {
			iface.Flags |= net.FlagUp
		}
		if item.Broadcast {
			iface.Flags |= net.FlagBroadcast
		}
		if item.Loopback {
			iface.Flags |= net.FlagLoopback
		}
		if item.PointToPt {
			iface.Flags |= net.FlagPointToPoint
		}
		if item.Multicast {
			iface.Flags |= net.FlagMulticast
		}
		for _, addr := range item.Addrs {
			ip, err := netip.ParseAddr(addr.IP)
			if err != nil {
				return nil, fmt.Errorf("invalid address %q on Android interface %q", addr.IP, item.Name)
			}
			if ip.Zone() != "" {
				iface.AltAddrs = append(iface.AltAddrs, &net.IPAddr{IP: net.IP(ip.AsSlice()), Zone: ip.Zone()})
				continue
			}
			bits := 128
			if ip.Is4() {
				bits = 32
			}
			if addr.PrefixLen < 0 || addr.PrefixLen > bits {
				return nil, fmt.Errorf("invalid prefix length on Android interface %q", item.Name)
			}
			iface.AltAddrs = append(iface.AltAddrs, &net.IPNet{IP: net.IP(ip.AsSlice()), Mask: net.CIDRMask(addr.PrefixLen, bits)})
		}
		out = append(out, iface)
	}
	if len(out) == 0 {
		return nil, errors.New("Android interface snapshot is empty")
	}
	return out, nil
}
