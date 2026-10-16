package com.novumxenium.app

import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.*
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebMessageCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
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
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity() {
    companion object {
        const val EXTRA_NOTIFICATION_EVENT_ID = "notification_event_id"
        const val EXTRA_NOTIFICATION_SERVER_ID = "notification_server_id"
        const val ACTION_OPEN_NOTIFICATION = "com.novumxenium.app.OPEN_NOTIFICATION"
        private const val NOTIFICATION_PERMISSION_REQUEST = 412
        private const val NOTIFICATION_CHANNEL_ID = "novum_updates"
        private const val MAX_SHARED_FILE_BYTES = 50L * 1024 * 1024
    }

    private val work = Executors.newCachedThreadPool()
    private val handler = Handler(Looper.getMainLooper())
    private val checking = AtomicBoolean(false)
    private var bridge: Client? = null
    private var server: URI? = null
    private var proxyAddress = ""
    private var loginUrl = ""
    private var starting = false
    private var connected = false
    private var proxyReady = false
    private var generation = 0
    private var closed = false
    private var activityResumed = false
    private var foregroundFeedReady = false
    private var pendingNotificationEventId: String? = null
    private var pendingNotificationServerId: String? = null
    private var pushBridgeOrigin: String? = null
    private var notificationStatusInfo: TextView? = null
    private var lastPushSyncAt = 0L
    private val pushSyncing = AtomicBoolean(false)
    private lateinit var header: LinearLayout
    private var pageReady = false
    private var pageFailed = false
    private var startupPeekUntil = 0L
    private val hideHeader = Runnable {
        if (pageReady && connected && !closed) header.visibility = View.GONE
    }
    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var signIn: Button
    private lateinit var welcome: LinearLayout
    private lateinit var retry: Button
    private lateinit var sharedBar: LinearLayout
    private lateinit var sharedLabel: TextView
    private lateinit var addShared: Button
    private val shares = java.util.ArrayDeque<SharedContent>()
    private var armedShare: SharedContent? = null
    private var activeShareTransfer: String? = null
    private var chooser: ValueCallback<Array<Uri>>? = null
    private data class Download(val url: String, val cookie: String?, val userAgent: String)
    private var download: Download? = null
    private val prefs by lazy { getSharedPreferences("connection", MODE_PRIVATE) }
    private val pushPrefs by lazy { getSharedPreferences("push", MODE_PRIVATE) }
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
            syncPushRegistrationIfDue()
            handler.postDelayed(this, 2000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pushPrefs.edit().putBoolean("foreground", false).apply()
        val saved = prefs.getString("server", "") ?: ""
        if (saved.isNotBlank()) startupPeekUntil = SystemClock.uptimeMillis() + 2000
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
        header = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        header.addView(bar)
        root.addView(header)
        status = TextView(this).apply { text = getString(R.string.connection_prompt); setPadding(dp(16), dp(8), dp(16), dp(8)); setTextColor(Color.LTGRAY) }
        header.addView(status)
        val recovery = LinearLayout(this).apply { gravity = android.view.Gravity.CENTER_VERTICAL; setPadding(dp(12), 0, dp(12), dp(8)) }
        retry = Button(this).apply { text = getString(R.string.retry); styleButton(this, false); setOnClickListener { retryConnection() } }
        recovery.addView(retry)
        recovery.addView(Button(this).apply { text = getString(R.string.check_connection); styleButton(this, false); setOnClickListener { checkConnection() } })
        header.addView(recovery)
        signIn = Button(this).apply {
            text = getString(R.string.tailscale_sign_in); styleButton(this, true)
            visibility = View.GONE; setOnClickListener { openExternal(loginUrl) }
        }
        root.addView(signIn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply {
            setMargins(dp(16), dp(4), dp(16), dp(12))
        })
        sharedBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(4), dp(12), dp(4)); visibility = View.GONE
        }
        sharedLabel = TextView(this).apply { setTextColor(Color.LTGRAY); textSize = 13f }
        sharedBar.addView(sharedLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addShared = Button(this).apply { text = getString(R.string.add_to_chat); styleButton(this, true); setOnClickListener { addSharedContent() } }
        sharedBar.addView(addShared)
        sharedBar.addView(Button(this).apply {
            text = "×"; contentDescription = getString(R.string.discard_share); styleButton(this, false)
            setOnClickListener { if (armedShare == null) { shares.pollFirst(); updateSharedContent() } }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(sharedBar)
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
        if (savedInstanceState != null) {
            val savedShares = savedInstanceState.getString("pendingShares")
            if (savedShares != null) {
                val items = JSONArray(savedShares)
                for (index in 0 until items.length()) {
                    val item = items.getJSONObject(index)
                    val files = item.getJSONArray("files")
                    shares.add(SharedContent(item.getString("text"), (0 until files.length()).map { Uri.parse(files.getString(it)) }.toMutableList()))
                }
                updateSharedContent()
            } else receiveSharedContent(intent)
        } else receiveSharedContent(intent)
        receiveNotificationIntent(intent)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkChanges)
        handler.post(poll)
        if (saved.isNotBlank()) connect(saved) else configure()
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        updatePushForeground()
    }

    override fun onPause() {
        activityResumed = false
        updatePushForeground()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        updatePushForeground()
    }

    private fun updatePushForeground() {
        if (!BuildConfig.FCM_ENABLED || !::web.isInitialized) return
        pushPrefs.edit().putBoolean(
            "foreground", activityResumed && connected && pageReady && web.hasWindowFocus() && foregroundFeedReady,
        ).apply()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        receiveSharedContent(intent)
        receiveNotificationIntent(intent)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != NOTIFICATION_PERMISSION_REQUEST) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            refreshFcmToken()
        } else {
            pushPrefs.edit().putBoolean("enabled", false).apply()
            Toast.makeText(this, R.string.notification_permission_denied, Toast.LENGTH_LONG).show()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        val items = JSONArray()
        shares.forEach { items.put(JSONObject().put("text", it.text).put("files", JSONArray(it.files.map(Uri::toString)))) }
        outState.putString("pendingShares", items.toString())
        super.onSaveInstanceState(outState)
    }

    private fun receiveSharedContent(intent: Intent) {
        try {
            val share = SharedContent.fromIntent(intent) ?: return
            require(shares.size < 10 && shares.sumOf { it.text.length } + share.text.length <= 100_000 &&
                shares.sumOf { it.files.size } + share.files.size <= 10) { getString(R.string.too_many_shares) }
            shares.add(share)
            updateSharedContent()
        } catch (error: Exception) {
            Toast.makeText(this, error.message ?: getString(R.string.share_failed), Toast.LENGTH_LONG).show()
        }
    }

    private fun updateSharedContent() {
        while (shares.peekFirst()?.isEmpty() == true) shares.removeFirst()
        sharedBar.visibility = if (shares.isEmpty()) View.GONE else View.VISIBLE
        val current = shares.peekFirst() ?: return
        sharedLabel.text = getString(R.string.shared_ready, current.files.size, shares.size)
        addShared.isEnabled = armedShare == null
    }

    private fun addSharedContent() {
        val share = shares.peekFirst() ?: return
        val target = server ?: return shareNotReady()
        if (!pageReady || !ServerAddress.sameOrigin(target, web.url.orEmpty())) return shareNotReady()
        if (armedShare != null) return
        if (share.files.isNotEmpty()) {
            armedShare = share
            addShared.isEnabled = false
            val transferId = UUID.randomUUID().toString()
            activeShareTransfer = transferId
            work.execute {
                var failure: String? = null
                try {
                    val descriptors = JSONArray()
                    share.files.forEach { uri ->
                        val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                            ?.use { if (it.moveToFirst()) it.getString(0) else null }
                            ?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment ?: "shared-file"
                        descriptors.put(JSONObject().put("name", name).put("type", contentResolver.getType(uri).orEmpty()))
                    }
                    check(evaluateShareScript(SharedContent.beginFileTransferScript(target.toString(), transferId, descriptors)))
                    var total = 0L
                    share.files.forEachIndexed { index, uri ->
                        val input = contentResolver.openInputStream(uri) ?: error("Unable to open shared file")
                        input.use { stream ->
                            val buffer = ByteArray(256 * 1024)
                            while (true) {
                                val count = stream.read(buffer)
                                if (count < 0) break
                                total += count
                                if (total > MAX_SHARED_FILE_BYTES) throw SharedFileTooLarge()
                                val encoded = Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)
                                check(evaluateShareScript(SharedContent.appendFileChunkScript(target.toString(), transferId, index, encoded)))
                            }
                        }
                    }
                    check(evaluateShareScript(SharedContent.finishFileTransferScript(target.toString(), transferId, share.text)))
                } catch (error: Exception) {
                    failure = if (error is SharedFileTooLarge) getString(R.string.share_too_large) else getString(R.string.share_failed)
                    runCatching { evaluateShareScript(SharedContent.clearFileTransferScript(target.toString(), transferId)) }
                }
                runOnUiThread {
                    if (closed) return@runOnUiThread
                    if (activeShareTransfer == transferId) activeShareTransfer = null
                    if (armedShare !== share) return@runOnUiThread
                    armedShare = null
                    if (failure == null) {
                        share.text = ""
                        share.files.clear()
                        updateSharedContent()
                    } else {
                        updateSharedContent()
                        Toast.makeText(this, failure, Toast.LENGTH_LONG).show()
                    }
                }
            }
            return
        }
        addShared.isEnabled = false
        web.evaluateJavascript(SharedContent.script(target.toString(), share.text)) { result ->
            if (result == "true") {
                share.text = ""
                updateSharedContent()
            } else {
                updateSharedContent()
                shareNotReady()
            }
        }
    }

    private fun evaluateShareScript(script: String): Boolean {
        val latch = CountDownLatch(1)
        var success = false
        runOnUiThread {
            if (!closed) web.evaluateJavascript(script) { result -> success = result == "true"; latch.countDown() }
            else latch.countDown()
        }
        return latch.await(10, TimeUnit.SECONDS) && success
    }

    private class SharedFileTooLarge : Exception()

    private fun shareNotReady(message: String = getString(R.string.share_open_chat)) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }


    private fun retryConnection() {
        if (starting) return
        val saved = prefs.getString("server", "").orEmpty()
        if (saved.isBlank()) configure() else connect(saved)
    }

    private fun checkConnection() {
        val target = server ?: prefs.getString("server", "")?.let { runCatching { ServerAddress.parse(it) }.getOrNull() }
        val token = generation
        val client = bridge
        val proxy = proxyAddress
        val message = TextView(this).apply { text = getString(R.string.checking_connection); setPadding(dp(24), dp(16), dp(24), dp(16)) }
        val dialog = AlertDialog.Builder(this).setTitle(R.string.check_connection).setView(message)
            .setNegativeButton(R.string.close, null)
            .setNeutralButton(R.string.connection) { _, _ -> configure() }
            .setPositiveButton(R.string.retry) { _, _ -> retryConnection() }.show()
        work.execute {
            val result = runCatching {
                val manager = getSystemService(ConnectivityManager::class.java)
                when {
                    manager.activeNetwork == null -> getString(R.string.no_network)
                    target == null -> getString(R.string.connection_prompt)
                    client == null -> getString(R.string.private_connection_retry)
                    else -> {
                        val state = JSONObject(client.statusJSON()).optString("state")
                        when (state) {
                            "NeedsLogin" -> getString(R.string.tailscale_login_needed)
                            "NeedsMachineAuth" -> getString(R.string.machine_approval_needed)
                            "Running" -> ConnectionCheck.check(target, proxy).message
                            else -> getString(R.string.private_connection_retry)
                        }
                    }
                }
            }.getOrDefault(getString(R.string.connection_status_unavailable))
            runOnUiThread { if (!closed && token == generation && dialog.isShowing) message.text = result }
        }
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

    private fun showConnectionControls() {
        handler.removeCallbacks(hideHeader)
        header.visibility = View.VISIBLE
    }

    private fun hideConnectionControlsWhenReady() {
        handler.removeCallbacks(hideHeader)
        if (pageReady && connected) {
            handler.postDelayed(hideHeader, (startupPeekUntil - SystemClock.uptimeMillis()).coerceAtLeast(0))
        }
    }

    private fun configure() {
        showConnectionControls()
        val input = EditText(this).apply {
            hint = getString(R.string.server_hint)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setText(prefs.getString("server", ""))
            setPadding(dp(24), dp(16), dp(24), dp(16))
        }
        val notifications = if (BuildConfig.FCM_ENABLED) CheckBox(this).apply {
            text = getString(R.string.enable_notifications)
            isChecked = pushPrefs.getBoolean("enabled", false)
        } else null
        notificationStatusInfo = if (notifications != null) TextView(this).apply {
            text = getString(R.string.notification_server_checking)
            setTextColor(Color.LTGRAY)
            setPadding(dp(24), 0, dp(24), dp(8))
            visibility = if (notifications.isChecked) View.VISIBLE else View.GONE
        } else null
        notifications?.setOnCheckedChangeListener { _, checked ->
            notificationStatusInfo?.visibility = if (checked) View.VISIBLE else View.GONE
        }
        val dialogContent = if (notifications != null) LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(input)
            addView(notifications)
            addView(notificationStatusInfo)
            addView(TextView(this@MainActivity).apply {
                text = getString(R.string.notification_privacy)
                setTextColor(Color.LTGRAY)
                setPadding(dp(24), 0, dp(24), dp(8))
            })
        } else input
        val dialog = AlertDialog.Builder(this).setTitle(getString(R.string.server_title))
            .setMessage(getString(R.string.server_explanation))
            .setView(dialogContent).setNegativeButton(getString(R.string.cancel), null).setPositiveButton(getString(R.string.connect), null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    ServerAddress.parse(input.text.toString())
                    val enableNotifications = notifications?.isChecked == true
                    dialog.dismiss()
                    connect(input.text.toString())
                    if (notifications != null) setNotificationsEnabled(enableNotifications)
                }
                catch (e: Exception) { input.error = e.message ?: getString(R.string.invalid_server) }
            }
        }
        dialog.setOnDismissListener { hideConnectionControlsWhenReady() }
        dialog.show()
    }

    private fun receiveNotificationIntent(intent: Intent?) {
        if (intent?.action != ACTION_OPEN_NOTIFICATION) return
        pendingNotificationEventId = NotificationTap.eventId(intent.getStringExtra(EXTRA_NOTIFICATION_EVENT_ID))
        pendingNotificationServerId = intent.getStringExtra(EXTRA_NOTIFICATION_SERVER_ID)
        openPendingNotification()
    }

    private fun openPendingNotification() {
        val route = NotificationTap.route(pendingNotificationEventId) ?: return
        val target = server ?: return
        val expectedServerId = pushPrefs.getString("server_id", null)
        if (pendingNotificationServerId.isNullOrBlank() || pendingNotificationServerId != expectedServerId) {
            pendingNotificationEventId = null
            pendingNotificationServerId = null
            return
        }
        pendingNotificationEventId = null
        pendingNotificationServerId = null
        web.loadUrl(target.toString().trimEnd('/') + route)
    }

    private fun installPushBridge(target: URI) {
        if (!BuildConfig.FCM_ENABLED || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val origin = "${target.scheme}://${target.rawAuthority}"
        if (pushBridgeOrigin == origin) return
        if (pushBridgeOrigin != null) WebViewCompat.removeWebMessageListener(web, "NovumPushBridge")
        try {
            WebViewCompat.addWebMessageListener(web, "NovumPushBridge", setOf(origin)) { _, message, sourceOrigin, isMainFrame, reply ->
                if (isMainFrame && ServerAddress.sameOrigin(target, sourceOrigin.toString())) {
                    handlePushBridgeMessage(target, message, reply)
                }
            }
            pushBridgeOrigin = origin
        } catch (_: Exception) {
            pushBridgeOrigin = null
        }
    }

    private fun handlePushBridgeMessage(target: URI, message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val request = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return
        val requestId = request.optString("request_id")
        if (request.optString("method") == "feed-ready") {
            foregroundFeedReady = request.optBoolean("ready", false)
            updatePushForeground()
            if (requestId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) {
                reply.postMessage(JSONObject().put("request_id", requestId).put("ok", true).toString())
            }
            return
        }
        if (!requestId.matches(Regex("[A-Za-z0-9_-]{1,64}"))) return
        if (request.optString("method") != "unregister") {
            reply.postMessage(JSONObject().put("request_id", requestId).put("ok", false).toString())
            return
        }
        val deviceId = pushPrefs.getString("device_id", null)
        val registeredOrigin = pushPrefs.getString("registered_origin", null)
        val targetOrigin = canonicalOrigin(target)
        if (registeredOrigin != targetOrigin) {
            reply.postMessage(JSONObject().put("request_id", requestId).put("ok", false).toString())
            return
        }
        if (deviceId.isNullOrBlank()) {
            pushPrefs.edit().putBoolean("enabled", false).apply()
            callFcm("deleteToken")
            reply.postMessage(JSONObject().put("request_id", requestId).put("ok", true).toString())
            return
        }
        if (!deviceId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) {
            reply.postMessage(JSONObject().put("request_id", requestId).put("ok", false).toString())
            return
        }
        work.execute {
            val response = notificationRequest(target, "DELETE", "/api/tasks/notification-devices/$deviceId")
            val status = response?.first
            val ok = status != null && (status in 200..299 || status == 404)
            pushPrefs.edit().putBoolean("enabled", false).apply()
            callFcm("deleteToken")
            if (ok) pushPrefs.edit().remove("device_id").remove("server_id").apply()
            handler.post {
                runCatching { reply.postMessage(JSONObject().put("request_id", requestId).put("ok", ok).toString()) }
            }
        }
    }

    private fun setNotificationsEnabled(enabled: Boolean) {
        pushPrefs.edit().putBoolean("enabled", enabled).apply()
        if (!enabled) {
            syncPushRegistrationIfDue(force = true)
            callFcm("deleteToken")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
        } else {
            refreshFcmToken()
        }
    }

    private fun refreshFcmToken() {
        ensureNotificationChannel()
        callFcm("refreshToken")
    }

    private fun callFcm(method: String) {
        if (!BuildConfig.FCM_ENABLED) return
        runCatching {
            val type = Class.forName("com.novumxenium.app.FcmIntegration")
            when (method) {
                "refreshToken" -> type.getMethod(method, Activity::class.java).invoke(null, this)
                "deleteToken" -> type.getMethod(method, android.content.Context::class.java).invoke(null, this)
            }
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL_ID, "Novum updates", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "New email and task updates" },
        )
    }

    /** Register only after Android permission and the Novum session are both available. */
    private fun syncPushRegistrationIfDue(force: Boolean = false) {
        if (!BuildConfig.FCM_ENABLED || !pageReady || !connected || !pushSyncing.compareAndSet(false, true)) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastPushSyncAt < 30_000) {
            pushSyncing.set(false)
            return
        }
        lastPushSyncAt = now
        val target = server
        val token = pushPrefs.getString("token", null)
        val enabled = pushPrefs.getBoolean("enabled", false) && notificationsAllowed()
        work.execute {
            try {
                if (target == null) return@execute
                val oldDeviceId = pushPrefs.getString("device_id", null)
                val oldOrigin = pushPrefs.getString("registered_origin", null)
                val currentOrigin = canonicalOrigin(target)
                val setupResponse = notificationRequest(target, "GET", "/api/tasks/notification-status")
                val setup = setupResponse?.second
                val serverReady = setup?.optBoolean("push_configured", false) == true && setup?.optBoolean("worker_enabled", false) == true
                handler.post {
                    val message = when {
                        setupResponse?.first !in 200..299 -> R.string.notification_server_sign_in
                        serverReady -> R.string.notification_server_ready
                        else -> R.string.notification_server_pending
                    }
                    notificationStatusInfo?.text = getString(message)
                }
                if (!enabled) {
                    val registeredOrigin = pushPrefs.getString("registered_origin", null)
                    if (!oldDeviceId.isNullOrBlank() && registeredOrigin == currentOrigin) {
                        val response = notificationRequest(target, "DELETE", "/api/tasks/notification-devices/${oldDeviceId}")
                        val status = response?.first
                        if (status != null && (status in 200..299 || status == 404)) {
                            pushPrefs.edit().remove("device_id").remove("server_id").apply()
                        }
                    }
                    return@execute
                }
                if (token.isNullOrBlank()) return@execute
                val body = JSONObject()
                    .put("token", token)
                    .put("platform", "android")
                    .put("opt_in", true)
                    .put("email_enabled", true)
                    .put("task_enabled", true)
                    .put("chat_enabled", true)
                val response = notificationRequest(target, "POST", "/api/tasks/notification-devices", body)
                if (response?.first?.let { it !in 200..299 } != false) return@execute
                val deviceId = response.second?.optString("device_id")?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,128}")) } ?: return@execute
                val serverId = response.second?.optString("server_id")?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,128}")) } ?: return@execute
                pushPrefs.edit().putString("device_id", deviceId)
                    .putString("registered_origin", currentOrigin).putString("server_id", serverId).apply()
                if (!oldDeviceId.isNullOrBlank() && oldDeviceId != deviceId && oldOrigin == currentOrigin) {
                    notificationRequest(target, "DELETE", "/api/tasks/notification-devices/$oldDeviceId")
                }
            } finally {
                pushSyncing.set(false)
            }
        }
    }

    private fun notificationsAllowed(): Boolean =
        (Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    private fun canonicalOrigin(target: URI): String {
        val scheme = target.scheme.lowercase()
        val host = target.host.lowercase()
        val defaultPort = if (scheme == "https") 443 else 80
        val hostPart = if (host.contains(':')) "[$host]" else host
        return "$scheme://$hostPart" + if (target.port == -1 || target.port == defaultPort) "" else ":${target.port}"
    }

    private fun notificationRequest(target: URI, method: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject?>? = runCatching {
        val cookie = CookieManager.getInstance().getCookie(target.toString())?.takeIf { it.isNotBlank() } ?: return null
        val proxy = proxyAddress.substringAfterLast(':').toIntOrNull() ?: return null
        val address = URI(target.toString().trimEnd('/') + path)
        val connection = address.toURL().openConnection(
            Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxy)),
        ) as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.requestMethod = method
        connection.setRequestProperty("Cookie", cookie)
        connection.setRequestProperty("Accept", "application/json")
        if (body != null) {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        }
        try {
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val result = stream?.bufferedReader()?.use { it.readText() }?.takeIf { it.isNotBlank() }
                ?.let { runCatching { JSONObject(it) }.getOrNull() }
            status to result
        } finally {
            connection.disconnect()
        }
    }.getOrNull()

    // Feature availability is checked before any asynchronous bridge work starts.
    @android.annotation.SuppressLint("RequiresFeature")
    private fun connect(address: String) {
        if (starting) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            status.text = getString(R.string.update_webview)
            return
        }
        val target = ServerAddress.parse(address)
        val token = ++generation
        val targetOrigin = canonicalOrigin(target)
        if (pushPrefs.getString("registered_origin", null) != targetOrigin) {
            pushPrefs.edit().remove("server_id").apply()
        }
        starting = true; retry.isEnabled = false
        pageReady = false; pageFailed = false; showConnectionControls()
        connected = false; proxyReady = false; loginUrl = ""; signIn.visibility = View.GONE
        updatePushForeground()
        web.stopLoading(); web.loadUrl("about:blank")
        installPushBridge(target)
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
                    starting = false; retry.isEnabled = true
                    bridge = client; server = target; proxyAddress = addressOfProxy
                    prefs.edit().putString("server", target.toString()).apply()
                    val config = ProxyConfig.Builder().addProxyRule(addressOfProxy).removeImplicitRules().build()
                    ProxyController.getInstance().setProxyOverride(config, java.util.concurrent.Executor { handler.post(it) }) {
                        if (token == generation && !closed) { proxyReady = true; showState(JSONObject(client.statusJSON())) }
                    }
                }
            } catch (e: Exception) {
                runCatching { started?.stop() }
                runOnUiThread { if (token == generation && !closed) { starting = false; retry.isEnabled = true; status.text = getString(R.string.connection_failed, e.message ?: getString(R.string.try_again)) } }
            }
        }
    }

    private fun showState(state: JSONObject) {
        loginUrl = state.optString("loginUrl")
        val phase = state.optString("state")
        signIn.visibility = if (phase == "NeedsLogin" && safeExternal(loginUrl)) View.VISIBLE else View.GONE
        status.text = when (phase) {
            "Running" -> if (pageFailed) getString(R.string.server_unavailable) else getString(R.string.connection_ready, server?.host.orEmpty())
            "NeedsLogin" -> getString(R.string.tailscale_login_needed)
            "NeedsMachineAuth" -> getString(R.string.machine_approval_needed)
            "Stopped" -> getString(R.string.disconnected)
            else -> state.optString("error").ifBlank { getString(R.string.connecting) }
        }
        if (phase != "Running") {
            connected = false
            updatePushForeground()
            pageReady = false
            showConnectionControls()
        }
        if (phase == "Running" && proxyReady && !connected) {
            connected = true
            updatePushForeground()
            welcome.visibility = View.GONE; web.visibility = View.VISIBLE
            web.loadUrl(server.toString())
        }
    }

    private fun showPageFailure() {
        pageReady = false; pageFailed = true
        showConnectionControls()
        status.text = getString(R.string.server_unavailable)
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
            override fun onPageStarted(view: WebView, address: String, icon: android.graphics.Bitmap?) {
                foregroundFeedReady = false
                updatePushForeground()
                activeShareTransfer?.let { id ->
                    server?.let { view.evaluateJavascript(SharedContent.clearFileTransferScript(it.toString(), id), null) }
                    activeShareTransfer = null
                }
                pageReady = false; pageFailed = false
                handler.removeCallbacks(hideHeader)
            }
            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) showPageFailure()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showPageFailure()
            }
            override fun onPageCommitVisible(view: WebView, address: String) {
                if (!pageFailed && server?.let { ServerAddress.sameOrigin(it, address) } == true) {
                    pageReady = true
                    updatePushForeground()
                    openPendingNotification()
                    hideConnectionControlsWhenReady()
                }
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
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack()
        else if (header.visibility == View.GONE) configure()
        else super.onBackPressed()
    }
    override fun onDestroy() {
        closed = true; generation++; handler.removeCallbacks(poll); handler.removeCallbacks(hideHeader)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkChanges) }
        chooser?.onReceiveValue(null); chooser = null
        web.stopLoading(); web.destroy()
        val client = bridge; bridge = null
        work.execute { runCatching { client?.stop() }; work.shutdown() }
        super.onDestroy()
    }
}
