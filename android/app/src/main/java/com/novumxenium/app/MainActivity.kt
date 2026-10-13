package com.novumxenium.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.novumxenium.android.bridge.Bridge
import com.novumxenium.android.bridge.Client
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Proxy
import java.net.URI
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity() {
    private val work = Executors.newCachedThreadPool()
    private val handler = Handler(Looper.getMainLooper())
    private val checking = AtomicBoolean(false)
    private var bridge: Client? = null
    private var server: URI? = null
    private var proxyAddress = ""
    private var loginUrl = ""
    private var connected = false
    private var proxyReady = false
    private var generation = 0
    private var closed = false
    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var signIn: Button
    private lateinit var welcome: LinearLayout
    private var chooser: ValueCallback<Array<Uri>>? = null
    private data class Download(val url: String, val cookie: String?, val userAgent: String)
    private var download: Download? = null
    private val prefs by lazy { getSharedPreferences("connection", MODE_PRIVATE) }
    private val networkChanges = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: android.net.Network, properties: android.net.LinkProperties) {
            val client = bridge ?: return
            if (closed) return
            work.execute {
                runCatching {
                    val configuration = networkConfiguration()
                    client.setInterfacesJSON(configuration.first)
                    client.setDNSJSON(configuration.second)
                }
            }
        }
    }

    private val poll = object : Runnable {
        override fun run() {
            if (closed) return
            val client = bridge
            if (client != null && checking.compareAndSet(false, true)) {
                val token = generation
                work.execute {
                    val result = runCatching { JSONObject(client.statusJSON()) }
                    runOnUiThread {
                        checking.set(false)
                        if (closed || token != generation) return@runOnUiThread
                        result.onSuccess { showState(it) }.onFailure { status.text = getString(R.string.connection_status_unavailable) }
                    }
                }
            }
            handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(17, 16, 21))
            fitsSystemWindows = true
        }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(4), dp(12), dp(4)) }
        bar.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_nx)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(28), dp(28)).apply { marginEnd = dp(10) })
        bar.addView(TextView(this).apply {
            text = getString(R.string.app_name); setTextColor(Color.rgb(230, 222, 241)); textSize = 16f
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(this).apply {
            text = getString(R.string.connection); styleButton(this, false)
            setOnClickListener { configure() }
        })
        root.addView(bar)
        status = TextView(this).apply { text = getString(R.string.connection_prompt); setPadding(dp(16), dp(8), dp(16), dp(8)); setTextColor(Color.LTGRAY) }
        root.addView(status)
        signIn = Button(this).apply {
            text = getString(R.string.tailscale_sign_in); styleButton(this, true)
            visibility = View.GONE; setOnClickListener { openExternal(loginUrl) }
        }
        root.addView(signIn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply {
            setMargins(dp(16), dp(4), dp(16), dp(12))
        })
        val content = FrameLayout(this)
        web = WebView(this).apply { visibility = View.GONE }
        content.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        welcome = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = android.view.Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        welcome.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_nx); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(56), dp(56)).apply { bottomMargin = dp(20) })
        welcome.addView(TextView(this).apply {
            text = getString(R.string.welcome_title); textSize = 21f
            gravity = android.view.Gravity.CENTER; setTextColor(Color.rgb(230, 222, 241))
        })
        welcome.addView(TextView(this).apply {
            text = getString(R.string.welcome_body); textSize = 15f
            gravity = android.view.Gravity.CENTER; setTextColor(Color.rgb(173, 164, 186))
            setPadding(0, dp(12), 0, 0)
        })
        content.addView(welcome, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        setupWebView()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkChanges)
        handler.post(poll)
        val saved = prefs.getString("server", "") ?: ""
        if (saved.isNotBlank()) connect(saved) else configure()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun styleButton(button: Button, primary: Boolean) {
        button.isAllCaps = false
        button.textSize = 14f
        button.minHeight = dp(48)
        button.setTextColor(if (primary) Color.rgb(24, 18, 34) else Color.rgb(218, 205, 236))
        if (primary) {
            button.backgroundTintList = android.content.res.ColorStateList.valueOf(Color.rgb(177, 150, 217))
        } else {
            val shape = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.rgb(29, 26, 36)); cornerRadius = dp(6).toFloat()
                setStroke(dp(1), Color.rgb(65, 56, 79))
            }
            button.background = android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(Color.rgb(75, 61, 95)), shape, null)
            button.setPadding(dp(12), dp(4), dp(12), dp(4))
        }
    }

    private fun configure() {
        val input = EditText(this).apply {
            hint = getString(R.string.server_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setText(prefs.getString("server", ""))
            setPadding(dp(24), dp(16), dp(24), dp(16))
        }
        val dialog = AlertDialog.Builder(this).setTitle(getString(R.string.server_title))
            .setMessage(getString(R.string.server_explanation))
            .setView(input).setNegativeButton(getString(R.string.cancel), null).setPositiveButton(getString(R.string.connect), null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try { ServerAddress.parse(input.text.toString()); dialog.dismiss(); connect(input.text.toString()) }
                catch (e: Exception) { input.error = e.message ?: getString(R.string.invalid_server) }
            }
        }
        dialog.show()
    }

    // Feature availability is checked before any asynchronous bridge work starts.
    @android.annotation.SuppressLint("RequiresFeature")
    private fun connect(address: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            status.text = getString(R.string.update_webview)
            return
        }
        val target = ServerAddress.parse(address)
        val token = ++generation
        connected = false; proxyReady = false; loginUrl = ""; signIn.visibility = View.GONE
        web.stopLoading(); web.loadUrl("about:blank")
        web.visibility = View.GONE; welcome.visibility = View.VISIBLE
        status.text = getString(R.string.connection_starting)
        val previous = bridge; bridge = null
        work.execute {
            var started: Client? = null
            try {
                previous?.stop()
                val client = Bridge.newClient()
                started = client
                val network = networkConfiguration()
                client.setInterfacesJSON(network.first)
                client.setDNSJSON(network.second)
                client.start(filesDir.resolve("tailscale").absolutePath, target.toString())
                val addressOfProxy = client.proxyAddress()
                require(addressOfProxy.startsWith("127.0.0.1:")) { getString(R.string.private_proxy_unavailable) }
                runOnUiThread {
                    if (closed || token != generation) { work.execute { client.stop() }; return@runOnUiThread }
                    bridge = client; server = target; proxyAddress = addressOfProxy
                    prefs.edit().putString("server", target.toString()).apply()
                    val config = ProxyConfig.Builder().addProxyRule(addressOfProxy).removeImplicitRules().build()
                    ProxyController.getInstance().setProxyOverride(config, java.util.concurrent.Executor { handler.post(it) }) {
                        if (token == generation && !closed) { proxyReady = true; showState(JSONObject(client.statusJSON())) }
                    }
                }
            } catch (e: Exception) {
                runCatching { started?.stop() }
                runOnUiThread { if (token == generation && !closed) status.text = getString(R.string.connection_failed, e.message ?: getString(R.string.try_again)) }
            }
        }
    }

    private fun showState(state: JSONObject) {
        loginUrl = state.optString("loginUrl")
        val phase = state.optString("state")
        signIn.visibility = if (phase == "NeedsLogin" && safeExternal(loginUrl)) View.VISIBLE else View.GONE
        status.text = when (phase) {
            "Running" -> getString(R.string.connection_ready, server?.host.orEmpty())
            "NeedsLogin" -> getString(R.string.tailscale_login_needed)
            "NeedsMachineAuth" -> getString(R.string.machine_approval_needed)
            "Stopped" -> getString(R.string.disconnected)
            else -> state.optString("error").ifBlank { getString(R.string.connecting) }
        }
        if (phase == "Running" && proxyReady && !connected) {
            connected = true
            welcome.visibility = View.GONE; web.visibility = View.VISIBLE
            web.loadUrl(server.toString())
        }
    }

    private fun setupWebView() {
        web.setBackgroundColor(Color.rgb(17, 16, 21))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true // Android document-picker uploads
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(true)
            builtInZoomControls = true; displayZoomControls = false
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val address = request.url.toString()
                if (!request.isForMainFrame) return false
                if (server?.let { ServerAddress.sameOrigin(it, address) } == true) return false
                openExternal(address); return true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) status.text = getString(R.string.server_unavailable)
            }
            override fun onPageFinished(view: WebView, address: String) { CookieManager.getInstance().flush() }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null); chooser = callback
                val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.filter { it.contains('/') }
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).apply {
                    type = if (types.size == 1) types[0] else "*/*"
                    if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                try { startActivityForResult(intent, 10) } catch (_: android.content.ActivityNotFoundException) {
                    chooser?.onReceiveValue(null); chooser = null
                    status.text = getString(R.string.no_file_picker)
                }
                return true
            }
            override fun onCreateWindow(view: WebView, dialog: Boolean, gesture: Boolean, result: android.os.Message): Boolean {
                if (!gesture) return false
                val temporary = WebView(this@MainActivity)
                temporary.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        val address = request.url.toString()
                        if (server?.let { ServerAddress.sameOrigin(it, address) } == true) web.loadUrl(address) else openExternal(address)
                        temporary.destroy(); return true
                    }
                }
                (result.obj as WebView.WebViewTransport).webView = temporary; result.sendToTarget(); return true
            }
        }
        web.setDownloadListener { address, userAgent, disposition, mime, _ ->
            if (server?.let { ServerAddress.sameOrigin(it, address) } != true) {
                status.text = getString(R.string.download_original)
                return@setDownloadListener
            }
            download = Download(address, CookieManager.getInstance().getCookie(address), userAgent ?: web.settings.userAgentString)
            val name = URLUtil.guessFileName(address, disposition, mime).substringAfterLast('/').substringAfterLast('\\').take(180)
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).apply {
                    type = mime ?: "application/octet-stream"; putExtra(Intent.EXTRA_TITLE, name)
                }, 11)
            } catch (_: android.content.ActivityNotFoundException) {
                download = null
                status.text = getString(R.string.no_file_saver)
            }
        }
    }

    @Deprecated("Android legacy result API remains supported")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) {
            val result = if (resultCode == RESULT_OK) data?.clipData?.let { clips -> Array(clips.itemCount) { clips.getItemAt(it).uri } }
                ?: data?.data?.let { arrayOf(it) } else null
            chooser?.onReceiveValue(result); chooser = null
        }
        if (requestCode == 11) {
            val request = download; download = null
            val destination = if (resultCode == RESULT_OK) data?.data else null
            if (request != null && destination != null) saveDownload(request, destination)
        }
    }

    private fun saveDownload(request: Download, destination: Uri) {
        val target = server ?: return
        val proxy = proxyAddress
        status.text = getString(R.string.saving_file)
        work.execute {
            try {
                require(ServerAddress.sameOrigin(target, request.url))
                val hostPort = proxy.split(':')
                val connection = URI(request.url).toURL().openConnection(Proxy(Proxy.Type.HTTP, InetSocketAddress(hostPort[0], hostPort[1].toInt()))) as HttpURLConnection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 30000; connection.readTimeout = 60000
                request.cookie?.let { connection.setRequestProperty("Cookie", it) }
                connection.setRequestProperty("User-Agent", request.userAgent)
                try {
                    require(connection.responseCode in 200..299) { getString(R.string.download_response_error, connection.responseCode) }
                    connection.inputStream.use { input -> contentResolver.openOutputStream(destination, "w")!!.use { output -> input.copyTo(output) } }
                } finally { connection.disconnect() }
                runOnUiThread { status.text = getString(R.string.file_saved) }
            } catch (e: Exception) {
                runOnUiThread { status.text = getString(R.string.download_failed, e.message ?: getString(R.string.try_again)) }
            }
        }
    }

    private fun networkConfiguration(): Pair<String, String> {
        val interfaces = JSONArray()
        for (item in Collections.list(NetworkInterface.getNetworkInterfaces())) {
            val addresses = JSONArray()
            item.interfaceAddresses.forEach { address ->
                address.address?.hostAddress?.substringBefore('%')?.let { addresses.put(JSONObject().put("ip", it).put("prefixLen", address.networkPrefixLength.toInt())) }
            }
            interfaces.put(JSONObject().put("name", item.name).put("index", item.index).put("mtu", item.mtu)
                .put("up", item.isUp).put("broadcast", item.interfaceAddresses.any { it.broadcast != null })
                .put("loopback", item.isLoopback).put("pointToPoint", item.isPointToPoint).put("multicast", item.supportsMulticast()).put("addrs", addresses))
        }
        val manager = getSystemService(ConnectivityManager::class.java)
        val dns = JSONArray()
        manager.getLinkProperties(manager.activeNetwork)?.dnsServers?.forEach { dns.put(it.hostAddress) }
        return interfaces.toString() to dns.toString()
    }
    private fun safeExternal(address: String) = runCatching {
        val uri = URI(address); uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null
    }.getOrDefault(false)
    private fun openExternal(address: String) {
        if (!safeExternal(address)) { status.text = getString(R.string.secure_links_only); return }
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(address))) }
        catch (_: Exception) { status.text = getString(R.string.no_browser) }
    }
    @Deprecated("Legacy back dispatch")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }
    override fun onDestroy() {
        closed = true; generation++; handler.removeCallbacks(poll)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkChanges) }
        chooser?.onReceiveValue(null); chooser = null
        web.stopLoading(); web.destroy()
        val client = bridge; bridge = null
        work.execute { runCatching { client?.stop() }; work.shutdown() }
        super.onDestroy()
    }
}
