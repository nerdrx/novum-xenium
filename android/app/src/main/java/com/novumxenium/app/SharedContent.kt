package com.novumxenium.app

import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/** Shared content stays in a draft. Files enter WebView's existing attachment input. */
data class SharedContent(var text: String, val files: MutableList<Uri>) {
    fun isEmpty() = text.isEmpty() && files.isEmpty()

    companion object {
        @Suppress("DEPRECATION")
        fun fromIntent(intent: Intent): SharedContent? {
            if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
            val text = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
                ?: intent.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text)?.toString().orEmpty()
            require(text.length <= 100_000) { "Shared text is too long. Share a file instead." }
            val files = mutableListOf<Uri>()
            if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                files.addAll(intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty())
            } else {
                intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let { files.add(it) }
            }
            intent.clipData?.let { clip ->
                for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { files.add(it) }
            }
            val unique = files.distinct().toMutableList()
            require(unique.size <= 10) { "Share up to 10 files at a time." }
            require(unique.all { it.scheme == "content" && it.toString().length <= 4096 }) {
                "This app did not share readable files. Try sharing through Files."
            }
            return SharedContent(text, unique).takeUnless { it.isEmpty() }
        }

        fun script(server: String, text: String): String = """
            (() => {
                if (location.origin !== new URL(${JSONObject.quote(server)}).origin) return false;
                const input = document.getElementById('message');
                if (!input || input.disabled || !input.getClientRects().length ||
                    typeof window.__nxReceiveClipboardFiles !== 'function') return false;
                const text = ${JSONObject.quote(text)};
                if (text) {
                    input.value += (input.value ? '\n' : '') + text;
                    input.dispatchEvent(new Event('input', {bubbles: true}));
                }
                input.focus();
                return true;
            })()
        """.trimIndent()

        fun beginFileTransferScript(server: String, id: String, files: JSONArray): String = """
            (() => {
                if (location.origin !== new URL(${JSONObject.quote(server)}).origin ||
                    typeof window.__nxReceiveClipboardFiles !== 'function' || !document.getElementById('file-input')) return false;
                window.__nxShareTransfer = {id:${JSONObject.quote(id)}, files:${files.toString()}};
                for (const file of window.__nxShareTransfer.files) file.chunks = [];
                return true;
            })()
        """.trimIndent()

        fun appendFileChunkScript(server: String, id: String, index: Int, bytes: String): String = """
            (() => {
                if (location.origin !== new URL(${JSONObject.quote(server)}).origin) return false;
                const transfer = window.__nxShareTransfer;
                if (!transfer || transfer.id !== ${JSONObject.quote(id)} || !transfer.files[$index]) return false;
                const binary = atob(${JSONObject.quote(bytes)});
                const chunk = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) chunk[i] = binary.charCodeAt(i);
                transfer.files[$index].chunks.push(chunk);
                return true;
            })()
        """.trimIndent()

        fun finishFileTransferScript(server: String, id: String, text: String): String = """
            (() => {
                if (location.origin !== new URL(${JSONObject.quote(server)}).origin) return false;
                const transfer = window.__nxShareTransfer;
                const input = document.getElementById('message');
                const picker = document.getElementById('file-input');
                if (!transfer || transfer.id !== ${JSONObject.quote(id)} || !input || input.disabled ||
                    !input.getClientRects().length || !picker || typeof window.__nxReceiveClipboardFiles !== 'function') return false;
                const files = new DataTransfer();
                for (const item of transfer.files) {
                    files.items.add(new File(item.chunks, item.name, {type:item.type || 'application/octet-stream'}));
                }
                picker.files = files.files;
                picker.dispatchEvent(new Event('change', {bubbles:true}));
                const text = ${JSONObject.quote(text)};
                if (text) {
                    input.value += (input.value ? '\n' : '') + text;
                    input.dispatchEvent(new Event('input', {bubbles:true}));
                }
                window.__nxShareTransfer = null;
                input.focus();
                return true;
            })()
        """.trimIndent()

        fun clearFileTransferScript(server: String, id: String): String = """
            (() => {
                if (location.origin !== new URL(${JSONObject.quote(server)}).origin) return false;
                if (window.__nxShareTransfer?.id === ${JSONObject.quote(id)}) window.__nxShareTransfer = null;
                return true;
            })()
        """.trimIndent()
    }
}
