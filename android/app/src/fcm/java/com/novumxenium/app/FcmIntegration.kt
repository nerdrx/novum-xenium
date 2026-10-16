package com.novumxenium.app

import android.app.Activity
import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging

/** Firebase-only entry points stay in the optional `fcm` product flavor. */
object FcmIntegration {
    private const val PREFS = "push"

    @JvmStatic
    fun refreshToken(activity: Activity) {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener(activity) { token -> saveToken(activity, token) }
            .addOnFailureListener(activity) { Log.w("NovumPush", "Could not get FCM token", it) }
    }

    @JvmStatic
    fun deleteToken(context: Context) {
        FirebaseMessaging.getInstance().deleteToken()
            .addOnFailureListener { Log.w("NovumPush", "Could not delete FCM token", it) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("token").apply()
    }

    internal fun saveToken(context: Context, token: String) {
        if (token.isNotBlank()) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("token", token).apply()
        }
    }
}
