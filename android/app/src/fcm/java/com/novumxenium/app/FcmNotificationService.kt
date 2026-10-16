package com.novumxenium.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.app.Notification
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FcmNotificationService : FirebaseMessagingService() {
    override fun onNewToken(token: String) = FcmIntegration.saveToken(this, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val payload = message.data
        val notice = PushNotice.from(payload) ?: return
        val preferences = getSharedPreferences("push", MODE_PRIVATE)
        if (!preferences.getBoolean("enabled", false)) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val registeredServerId = preferences.getString("server_id", null)
        if (registeredServerId.isNullOrBlank() || notice.serverId != registeredServerId) return
        if (preferences.getBoolean("foreground", false)) return
        val manager = getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return
        createChannel(manager)

        val open = Intent(this, MainActivity::class.java).apply {
            action = MainActivity.ACTION_OPEN_NOTIFICATION
            data = Uri.parse("novum://notification/${notice.eventId}")
            putExtra(MainActivity.EXTRA_NOTIFICATION_EVENT_ID, notice.eventId)
            putExtra(MainActivity.EXTRA_NOTIFICATION_SERVER_ID, notice.serverId)
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(
            this, notice.eventId.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        runCatching { manager.notify(notice.eventId.hashCode(), notification) }
    }

    private fun createChannel(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Novum updates", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = "New email and task updates" },
            )
        }
    }

    companion object {
        const val CHANNEL_ID = "novum_updates"
    }
}

internal data class PushNotice(val eventId: String, val serverId: String, val title: String, val body: String) {
    companion object {
        fun from(data: Map<String, String>): PushNotice? {
            val id = NotificationTap.eventId(data["event_id"]) ?: return null
            val serverId = data["server_id"]?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,128}")) } ?: return null
            val kind = data["kind"] ?: return null
            val failed = data["status"] == "failure"
            val waitingForApproval = data["status"] == "waiting_approval"
            return when (kind) {
                "email" -> PushNotice(id, serverId, "New email", "You have new email.")
                "task" -> if (failed) PushNotice(id, serverId, "Task needs attention", "A task did not finish successfully.")
                    else PushNotice(id, serverId, "Task update", "A task has finished.")
                "chat" -> when {
                    failed -> PushNotice(id, serverId, "Chat update", "A response could not be completed.")
                    waitingForApproval -> PushNotice(id, serverId, "Response needs attention", "Open Novum Xenium to review a request.")
                    else -> PushNotice(id, serverId, "Chat update", "A response is ready.")
                }
                else -> null
            }
        }
    }
}
