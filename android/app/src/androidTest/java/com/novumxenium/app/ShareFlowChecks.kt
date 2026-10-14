package com.novumxenium.app

import android.app.Instrumentation
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.view.View
import android.webkit.WebView
import org.json.JSONObject
import org.json.JSONTokener
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

object ShareFlowChecks {
    fun run(test: Instrumentation, app: MainActivity) {
        fun field(name: String) = MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }
        val web = field("web").get(app) as WebView
        fun evaluate(script: String): String {
            val latch = CountDownLatch(1)
            var result = ""
            test.runOnMainSync { web.evaluateJavascript(script) { result = it; latch.countDown() } }
            check(latch.await(5, TimeUnit.SECONDS)) { "WebView script timed out" }
            return result
        }
        val uri = Uri.parse("content://com.novumxenium.app.test.share/fixture")
        val text = "A link https://example.test/ and quotes '\" 🐾\n');window.pwned=true;//"
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            .putExtra(Intent.EXTRA_STREAM, uri).apply { clipData = ClipData.newRawUri("fixture", uri) }
        val parsed = SharedContent.fromIntent(intent)!!
        check(parsed.files == listOf(uri)) { "Duplicate ClipData file was not removed" }
        check(runCatching { SharedContent.fromIntent(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///etc/passwd"))) }.isFailure)
        check(runCatching { SharedContent.fromIntent(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "a".repeat(100_001))) }.isFailure)
        test.runOnMainSync {
            field("server").set(app, URI("http://192.0.2.1:7000"))
            field("connected").setBoolean(app, true)
            web.visibility = View.VISIBLE
            (field("welcome").get(app) as View).visibility = View.GONE
            web.loadDataWithBaseURL("http://192.0.2.1:7000/", """
                <form onsubmit="window.submits++;return false"><textarea id="message">Existing draft</textarea>
                <input id="file-input" type="file" multiple></form><script>
                window.submits=0; window.received=[]; window.__nxErrors=[];
                window.addEventListener('error', e=>window.__nxErrors.push(e.message));
                window.__nxReceiveClipboardFiles=()=>{};
                document.getElementById('file-input').onchange=async e=>{
                    window.received=await Promise.all([...e.target.files].map(async f=>({name:f.name,text:await f.text()})));
                };</script>
            """.trimIndent(), "text/html", "UTF-8", "http://192.0.2.1:7000/")
            check(ServerAddress.sameOrigin(URI("http://192.0.2.1:7000"), web.url.orEmpty())) {
                "Share fixture has no server origin: ${web.url}"
            }
        }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (evaluate("typeof window.__nxReceiveClipboardFiles === 'function'") != "true") {
            check(System.nanoTime() < deadline) { "Composer fixture did not load" }
            Thread.sleep(50)
        }
        test.runOnMainSync {
            field("pageReady").setBoolean(app, true)
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }.invoke(app, intent)
            MainActivity::class.java.getDeclaredMethod("addSharedContent").apply { isAccessible = true }.invoke(app)
        }
        val filesDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        while (evaluate("window.received.length") != "1") {
            if (System.nanoTime() >= filesDeadline) {
                val diagnostic = evaluate("JSON.stringify({fileCount:document.getElementById('file-input')?.files?.length,transfer:!!window.__nxShareTransfer,errors:window.__nxErrors})")
                error("Shared file did not reach the composer; WebView=$diagnostic")
            }
            Thread.sleep(50)
        }
        val result = JSONObject(JSONTokener(evaluate("JSON.stringify({text:document.getElementById('message').value,files:window.received,submits:window.submits,pwned:!!window.pwned})")).nextValue() as String)
        check(result.getString("text") == "Existing draft\n$text") { "Share replaced or changed the existing draft" }
        check(result.getJSONArray("files").getJSONObject(0).getString("text") == "Shared bytes!")
        check(result.getInt("submits") == 0 && !result.getBoolean("pwned")) { "Share must not submit or execute text" }
        test.runOnMainSync { check((field("sharedBar").get(app) as View).visibility == View.GONE) }

        val second = Uri.parse("content://com.novumxenium.app.test.share/fixture/second")
        val multiple = Intent(Intent.ACTION_SEND_MULTIPLE).setType("text/plain")
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri, second))
            .apply { clipData = ClipData.newRawUri("fixture", uri).apply { addItem(ClipData.Item(second)) } }
        test.runOnMainSync {
            evaluateOnMain(web, "document.getElementById('message').value='Second draft';window.received=[]")
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }.invoke(app, multiple)
            MainActivity::class.java.getDeclaredMethod("addSharedContent").apply { isAccessible = true }.invoke(app)
        }
        val multipleDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8)
        while (evaluate("window.received.length") != "2") {
            check(System.nanoTime() < multipleDeadline) { "Two shared files did not reach the composer" }
            Thread.sleep(50)
        }
        val multipleResult = JSONObject(JSONTokener(evaluate("JSON.stringify({text:document.getElementById('message').value,files:window.received,submits:window.submits})")).nextValue() as String)
        check(multipleResult.getString("text") == "Second draft")
        check(multipleResult.getJSONArray("files").length() == 2 &&
            (0 until 2).all { multipleResult.getJSONArray("files").getJSONObject(it).getString("text") == "Shared bytes!" })
        check(multipleResult.getInt("submits") == 0)

        test.runOnMainSync {
            evaluateOnMain(web, "document.getElementById('message').value='Text draft'")
            val textOnly = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Just text")
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }.invoke(app, textOnly)
            MainActivity::class.java.getDeclaredMethod("addSharedContent").apply { isAccessible = true }.invoke(app)
        }
        val textResult = JSONObject(JSONTokener(evaluate("JSON.stringify({text:document.getElementById('message').value,submits:window.submits})")).nextValue() as String)
        check(textResult.getString("text") == "Text draft\nJust text" && textResult.getInt("submits") == 0)
    }

    private fun evaluateOnMain(web: WebView, script: String) { web.evaluateJavascript(script, null) }
}
