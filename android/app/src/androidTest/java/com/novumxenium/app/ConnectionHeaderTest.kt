package com.novumxenium.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.View
import android.webkit.WebView
import org.json.JSONObject
import java.net.URI

/** Native UI checks with simulated connection state; no tailnet credentials required. */
class ConnectionHeaderTest : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun onStart() {
        var activity: MainActivity? = null
        try {
            targetContext.getSharedPreferences("connection", 0).edit().clear().commit()
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val app = activity
            fun cancelDialog() {
                waitForIdleSync()
                val deadline = SystemClock.uptimeMillis() + 5000
                var cancel = uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(app.getString(R.string.cancel))?.firstOrNull()
                while (cancel == null && SystemClock.uptimeMillis() < deadline) {
                    SystemClock.sleep(50)
                    cancel = uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(app.getString(R.string.cancel))?.firstOrNull()
                }
                checkNotNull(cancel) { "Connection dialog did not become visible" }
                check(cancel.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                SystemClock.sleep(350)
                waitForIdleSync()
            }
            cancelDialog()
            fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
            fun invoke(name: String) = MainActivity::class.java.getDeclaredMethod(name).apply { isAccessible = true }.invoke(app)
            val header = field("header").get(app) as View
            val web = field("web").get(app) as WebView
            var stage = "startup"
            fun visible(expected: Boolean) {
                var state = ""
                var actual = false
                runOnMainSync {
                    actual = header.visibility == View.VISIBLE
                    state = "ready=${field("pageReady").get(app)} connected=${field("connected").get(app)} closed=${field("closed").get(app)}"
                }
                check(actual == expected) { "$stage: visible=$actual expected=$expected $state" }
            }
            runOnMainSync {
                field("server").set(app, URI("http://192.0.2.1:7000"))
                field("connected").setBoolean(app, true)
                field("startupPeekUntil").setLong(app, SystemClock.uptimeMillis() + 2000)
                web.webViewClient.onPageCommitVisible(web, "http://192.0.2.1:7000/login")
            }
            visible(true)
            SystemClock.sleep(1000)
            visible(true)
            SystemClock.sleep(1200)
            visible(false)
            stage = "navigation"
            // A later ordinary page load must not flash the header again.
            runOnMainSync { web.webViewClient.onPageCommitVisible(web, "http://192.0.2.1:7000/") }
            waitForIdleSync()
            visible(false)
            stage = "disconnect"
            // Losing the private connection restores settings and sign-in controls.
            runOnMainSync {
                MainActivity::class.java.getDeclaredMethod("showState", JSONObject::class.java)
                    .apply { isAccessible = true }.invoke(app, JSONObject().put("state", "Stopped"))
            }
            visible(true)
            stage = "first connection"
            // A first connection, without a restart peek, hides as soon as ready.
            runOnMainSync {
                field("startupPeekUntil").setLong(app, 0)
                field("connected").setBoolean(app, true)
                field("pageReady").setBoolean(app, true)
                invoke("hideConnectionControlsWhenReady")
            }
            waitForIdleSync()
            visible(false)
            stage = "Back settings"
            // Back at the root still provides a way to edit the server.
            runOnMainSync { app.onBackPressed() }
            visible(true)
            cancelDialog()
            visible(false)
            stage = "error recovery"
            // Error pages and healthy tunnel polls must not hide a failed page.
            runOnMainSync {
                invoke("showPageFailure")
                web.webViewClient.onPageCommitVisible(web, "http://192.0.2.1:7000/")
                MainActivity::class.java.getDeclaredMethod("showState", JSONObject::class.java)
                    .apply { isAccessible = true }.invoke(app, JSONObject().put("state", "Running"))
                check((field("status").get(app) as android.widget.TextView).text == app.getString(R.string.server_unavailable))
            }
            waitForIdleSync()
            visible(true)
            runOnMainSync {
                web.webViewClient.onPageStarted(web, "http://192.0.2.1:7000/", null)
                web.webViewClient.onPageCommitVisible(web, "http://192.0.2.1:7000/")
            }
            waitForIdleSync()
            visible(false)
            ShareFlowChecks.run(this, app)
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "PASS: header timing/recovery; text-only, one and multiple shared file bytes, draft preservation, no automatic send\n") })
        } catch (error: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "FAIL: ${error.stackTraceToString()}\n") })
        } finally {
            activity?.let { runOnMainSync { it.finish() } }
        }
    }
}
