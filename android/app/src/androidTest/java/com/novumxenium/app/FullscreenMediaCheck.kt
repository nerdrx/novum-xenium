package com.novumxenium.app

import android.app.Instrumentation
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Offline native fullscreen handoff check using a generated local video fixture. */
object FullscreenMediaCheck {
    fun run(test: Instrumentation, activity: MainActivity) {
        fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
        val web = field("web").get(activity) as WebView
        val bytes = test.context.assets.open("fullscreen-fixture.mp4").use { it.readBytes() }
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val page = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{margin:0;background:#111;color:white;font:20px sans-serif}#play{position:fixed;left:20px;top:20px;width:260px;height:80px}</style>
            <video id="clip" playsinline src="data:video/mp4;base64,$encoded"></video>
            <button id="play" disabled onclick="const v=document.querySelector('#clip');v.play().catch(e=>window.playError=e.name+':'+e.message);v.requestFullscreen()">Play fullscreen</button>
            <script>document.querySelector('#clip').addEventListener('canplay',()=>document.querySelector('#play').disabled=false)</script>
        """.trimIndent()
        val origin = URI("https://fullscreen.test")
        val decor = activity.window.decorView
        val oldSystemUi = decor.systemUiVisibility
        test.runOnMainSync {
            field("server").set(activity, origin)
            field("connected").setBoolean(activity, true)
            (field("welcome").get(activity) as View).visibility = View.GONE
            web.visibility = View.VISIBLE
            web.loadDataWithBaseURL("https://fullscreen.test/", page, "text/html", "UTF-8", null)
        }

        fun evaluate(script: String): String {
            val latch = CountDownLatch(1)
            var result = ""
            test.runOnMainSync { web.evaluateJavascript(script) { value -> result = value.orEmpty(); latch.countDown() } }
            check(latch.await(3, TimeUnit.SECONDS)) { "Local WebView script timed out" }
            return result.trim('"')
        }
        val loadedUntil = SystemClock.uptimeMillis() + 5000
        while (SystemClock.uptimeMillis() < loadedUntil && evaluate("String(document.querySelector('#play')?.disabled)") != "false") {
            SystemClock.sleep(50)
        }
        check(evaluate("String(document.querySelector('#play')?.disabled)") == "false") {
            "Local video fixture did not become playable"
        }

        val location = IntArray(2)
        web.getLocationOnScreen(location)
        val density = activity.resources.displayMetrics.density
        val x = location[0] + (150 * density).toInt()
        val y = location[1] + (60 * density).toInt()
        val down = SystemClock.uptimeMillis()
        test.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x.toFloat(), y.toFloat(), 0).apply {
            source = InputDevice.SOURCE_TOUCHSCREEN
        })
        test.sendPointerSync(MotionEvent.obtain(down, SystemClock.uptimeMillis() + 80, MotionEvent.ACTION_UP, x.toFloat(), y.toFloat(), 0).apply {
            source = InputDevice.SOURCE_TOUCHSCREEN
        })

        val customField = field("fullscreenView")
        val fullscreenUntil = SystemClock.uptimeMillis() + 5000
        var custom: View? = null
        while (custom == null && SystemClock.uptimeMillis() < fullscreenUntil) {
            test.waitForIdleSync()
            custom = customField.get(activity) as? View
            if (custom == null) SystemClock.sleep(50)
        }
        checkNotNull(custom) { "Trusted video tap did not reach the native fullscreen callback" }
        check(custom.parent === decor)
        check(decor.systemUiVisibility and View.SYSTEM_UI_FLAG_FULLSCREEN != 0)

        val playbackUntil = SystemClock.uptimeMillis() + 1500
        var advanced = false
        while (!advanced && SystemClock.uptimeMillis() < playbackUntil) {
            advanced = evaluate("String(document.querySelector('#clip').currentTime > 0.1)") == "true"
            if (!advanced) SystemClock.sleep(50)
        }
        check(advanced) {
            val diagnostic = evaluate("JSON.stringify({time:document.querySelector('#clip').currentTime,paused:document.querySelector('#clip').paused,ready:document.querySelector('#clip').readyState,error:window.playError||null})")
            "Video did not advance during fullscreen playback: $diagnostic"
        }

        test.runOnMainSync {
            activity.onBackPressed()
            check(custom.parent == null) { "Back did not remove fullscreen video" }
            check(customField.get(activity) == null) { "Fullscreen state was not cleared" }
            check(decor.systemUiVisibility == oldSystemUi) { "System bars were not restored" }
        }
        test.waitForIdleSync()
    }
}
