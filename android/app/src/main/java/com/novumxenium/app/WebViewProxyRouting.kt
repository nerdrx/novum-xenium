package com.novumxenium.app

import androidx.webkit.ProxyConfig
import java.net.URI

/** Keep the configured Novum origin on the private tunnel while public assets use Android networking. */
internal object WebViewProxyRouting {
    fun build(proxyAddress: String, server: URI, reverseBypassSupported: Boolean): ProxyConfig {
        val builder = ProxyConfig.Builder()
            .addProxyRule(proxyAddress)
            .removeImplicitRules()
        if (reverseBypassSupported) {
            val host = server.host.removePrefix("[").removeSuffix("]")
            val pattern = if (host.contains(':')) "[$host]" else host
            // In reverse-bypass mode these are the only hosts sent through the proxy.
            // The Go bridge still enforces the exact configured authority and port.
            builder.addBypassRule(pattern).setReverseBypassEnabled(true)
        }
        return builder.build()
    }
}
