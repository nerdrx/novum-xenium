package com.novumxenium.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.LinkProperties
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import com.novumxenium.android.bridge.Client
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Owns the private tunnel while bound, and keeps it alive only after explicit notification opt-in. */
class NotificationConnectionService : Service() {
    data class ConnectionState(val client: Client, val target: URI, val proxy: String)
    companion object {
        const val ACTION_ENABLE = "com.novumxenium.app.ENABLE_BACKGROUND_NOTIFICATIONS"
        const val ACTION_DISABLE = "com.novumxenium.app.DISABLE_BACKGROUND_NOTIFICATIONS"
        private const val SERVICE_CHANNEL = "novum_background_connection"
        private const val ALERT_CHANNEL = "novum_updates"
        private const val SERVICE_NOTIFICATION_ID = 201
        private const val POLL_MS = 60_000L
    }

    inner class LocalBinder : Binder() {
        fun service() = this@NotificationConnectionService
    }

    private val binder = LocalBinder()
    private val prefs by lazy { getSharedPreferences("local_notifications", MODE_PRIVATE) }
    private val work = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val polling = AtomicBoolean(false)
    @Volatile private var client: Client? = null
    @Volatile private var target: URI? = null
    @Volatile private var proxy = ""
    @Volatile private var feedReady = false
    @Volatile private var appForeground = false
    @Volatile private var feedOwner = ""
    @Volatile private var feedGeneration = 0
    private var destroyed = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
            val active = client ?: return
            work.execute {
                runCatching {
                    val config = networkConfiguration()
                    active.setInterfacesJSON(config.first)
                    active.setDNSJSON(config.second)
                }
            }
        }
    }
    private val poll = object : Runnable {
        override fun run() {
            if (destroyed) return
            if (notificationsEnabled() && feedReady && polling.compareAndSet(false, true)) {
                work.execute {
                    try { runCatching { pollFeed() } } finally { polling.set(false) }
                }
            }
            main.postDelayed(this, POLL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        ensureAlertChannel()
        main.postDelayed(poll, POLL_MS)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISABLE -> {
                prefs.edit().putBoolean("enabled", false).remove("cursor").remove("owner").apply()
                feedReady = false
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf(startId)
            }
            ACTION_ENABLE, null -> {
                if (notificationsEnabled()) startForegroundNotice()
                else {
                    prefs.edit().putBoolean("enabled", false).apply()
                    stopSelf(startId)
                }
            }
        }
        return START_NOT_STICKY
    }

    @Synchronized fun adopt(active: Client, server: URI, proxyAddress: String) {
        if (client !== active) runCatching { client?.stop() }
        client = active
        target = server
        proxy = proxyAddress
        feedReady = false
        feedOwner = ""
        feedGeneration++
        prefs.edit().remove("cursor").remove("owner").putString("origin", canonicalOrigin(server)).apply()
    }

    @Synchronized fun connectionState(): ConnectionState? {
        val active = client ?: return null
        val server = target ?: return null
        return ConnectionState(active, server, proxy)
    }

    @Synchronized fun prepareConnectionReplacement() {
        feedReady = false
        feedOwner = ""
        feedGeneration++
        prefs.edit().remove("cursor").remove("owner").apply()
        val old = client
        client = null
        target = null
        proxy = ""
        runCatching { old?.stop() }
    }

    @Synchronized fun setFeedReady(ready: Boolean, owner: String) {
        feedGeneration++
        val safeOwner = owner
        if (!ready || safeOwner.isEmpty() || safeOwner.any { Character.isISOControl(it) } || (feedOwner.isNotEmpty() && safeOwner != feedOwner)) {
            feedReady = false
            feedOwner = ""
            prefs.edit().remove("cursor").remove("owner").apply()
            if (!ready || safeOwner.isEmpty() || safeOwner.any { Character.isISOControl(it) }) return
        }
        feedOwner = safeOwner
        val oldOwner = prefs.getString("owner", "") ?: ""
        val ownerKey = java.security.MessageDigest.getInstance("SHA-256")
            .digest(feedOwner.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        if (oldOwner != ownerKey) prefs.edit().remove("cursor").putString("owner", ownerKey).apply()
        feedReady = true
        main.removeCallbacks(poll)
        main.post(poll)
    }

    @Synchronized fun pauseFeed() {
        feedReady = false
        feedGeneration++
    }

    fun setAppForeground(foreground: Boolean) { appForeground = foreground }

    fun notificationsEnabled() = prefs.getBoolean("enabled", false) &&
        (Build.VERSION.SDK_INT < 33 || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) &&
        getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    fun enable() {
        prefs.edit().putBoolean("enabled", true).apply()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        startForegroundService(Intent(this, NotificationConnectionService::class.java).setAction(ACTION_ENABLE))
    }

    fun disable() {
        prefs.edit().putBoolean("enabled", false).remove("cursor").remove("owner").apply()
        feedReady = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundNotice() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(SERVICE_CHANNEL, "Background connection", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Private connection used for opted-in Novum alerts" },
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, SERVICE_CHANNEL) else Notification.Builder(this))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Novum background alerts")
            .setContentText("Enabled while background alerts are turned on")
            .setOngoing(true)
            .setContentIntent(open)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(SERVICE_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else startForeground(SERVICE_NOTIFICATION_ID, notification)
    }

    private fun ensureAlertChannel() {
        if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(ALERT_CHANNEL, "Novum updates", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Generic new email, task, and chat alerts" },
        )
    }

    private fun pollFeed() {
        val current = client ?: return
        val server = target ?: return
        if (!notificationsEnabled() || !feedReady) return
        val generation = feedGeneration
        val owner = feedOwner
        val serverOrigin = canonicalOrigin(server)
        val cookie = CookieManager.getInstance().getCookie(server.toString())?.takeIf(String::isNotBlank) ?: return
        val cursor = prefs.getString("cursor", null)
        val after = cursor?.let { "&after=$it" } ?: ""
        val connection = (URI(server.toString().trimEnd('/') + "/api/tasks/notification-feed?limit=50&email=true$after")
            .toURL().openConnection(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", proxy.substringAfterLast(':').toInt()))) as HttpURLConnection)
        connection.instanceFollowRedirects = false
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.setRequestProperty("Cookie", cookie)
        connection.setRequestProperty("Accept", "application/json")
        try {
            if (connection.responseCode == 401) {
                if (generation == feedGeneration) setFeedReady(false, "")
                return
            }
            if (connection.responseCode !in 200..299) return
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val data = JSONObject(body)
            val responseOwner = data.optString("owner")
            if (responseOwner.isEmpty() || responseOwner != owner) {
                if (generation == feedGeneration) setFeedReady(false, "")
                return
            }
            val events = data.optJSONArray("notifications") ?: return
            for (i in 0 until events.length()) {
                if (!feedSnapshotCurrent(generation, owner, current, server, serverOrigin, cookie)) return
                val event = events.optJSONObject(i) ?: continue
                val id = event.optLong("id", -1)
                if (id <= 0) continue
                val kind = event.optString("kind")
                if (kind !in setOf("email", "task", "chat")) continue
                synchronized(this) {
                    if (!feedSnapshotCurrent(generation, owner, current, server, serverOrigin, cookie)) return
                    if (!appForeground) showAlert(id, kind, event.optString("status"), server)
                }
            }
            val next = data.optString("cursor").takeIf { it.matches(Regex("[0-9]{1,20}")) }
            if (next != null) synchronized(this) {
                if (feedSnapshotCurrent(generation, owner, current, server, serverOrigin, cookie)) {
                    prefs.edit().putString("cursor", next).apply()
                }
            }
        } catch (_: Exception) {
            // Keep the cursor unchanged so the next bounded poll retries safely.
        } finally {
            connection.disconnect()
        }
    }

    @Synchronized private fun feedSnapshotCurrent(generation: Int, owner: String, active: Client, server: URI, origin: String, cookie: String) =
        generation == feedGeneration && feedReady && feedOwner == owner && client === active && target == server &&
            canonicalOrigin(server) == origin && notificationsEnabled() &&
            CookieManager.getInstance().getCookie(server.toString()) == cookie

    private fun showAlert(id: Long, kind: String, status: String, server: URI) {
        if (!notificationsEnabled() || !feedReady || appForeground) return
        val (title, body) = NotificationCopy.forEvent(kind, status) ?: return
        val serverBinding = canonicalOrigin(server)
        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .putExtra(MainActivity.EXTRA_NOTIFICATION_EVENT_ID, id.toString())
            .putExtra(MainActivity.EXTRA_NOTIFICATION_SERVER_ID, serverBinding)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(
            this, id.toInt(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, ALERT_CHANNEL) else Notification.Builder(this))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText(body).setAutoCancel(true).setContentIntent(pending).build()
        getSystemService(NotificationManager::class.java).notify("novum-$serverBinding", id.toInt(), notification)
    }

    private fun canonicalOrigin(uri: URI): String {
        val scheme = uri.scheme.lowercase()
        val host = uri.host.lowercase()
        val port = if (scheme == "https") 443 else 80
        val hostPart = if (host.contains(':')) "[$host]" else host
        return "$scheme://$hostPart" + if (uri.port == -1 || uri.port == port) "" else ":${uri.port}"
    }

    private fun networkConfiguration(): Pair<String, String> {
        val interfaces = org.json.JSONArray()
        for (item in Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
            val addresses = org.json.JSONArray()
            item.interfaceAddresses.forEach { address ->
                address.address?.hostAddress?.substringBefore('%')?.let {
                    addresses.put(JSONObject().put("ip", it).put("prefixLen", address.networkPrefixLength.toInt()))
                }
            }
            interfaces.put(JSONObject().put("name", item.name).put("index", item.index).put("mtu", item.mtu)
                .put("up", item.isUp).put("broadcast", item.interfaceAddresses.any { it.broadcast != null })
                .put("loopback", item.isLoopback).put("pointToPoint", item.isPointToPoint)
                .put("multicast", item.supportsMulticast()).put("addrs", addresses))
        }
        val dns = org.json.JSONArray()
        getSystemService(ConnectivityManager::class.java).getLinkProperties(
            getSystemService(ConnectivityManager::class.java).activeNetwork,
        )?.dnsServers?.forEach { dns.put(it.hostAddress) }
        return interfaces.toString() to dns.toString()
    }

    override fun onDestroy() {
        destroyed = true
        main.removeCallbacks(poll)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        val old = client
        client = null
        work.execute { runCatching { old?.stop() }; work.shutdown() }
        super.onDestroy()
    }
}
