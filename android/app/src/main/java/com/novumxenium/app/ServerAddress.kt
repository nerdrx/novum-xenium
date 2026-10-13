package com.novumxenium.app

import java.net.URI

/** Exact origin boundary shared by navigation and authenticated downloads. */
object ServerAddress {
    fun parse(value: String): URI {
        val uri = URI(value.trim())
        require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()) { "Enter a full http:// or https:// server address." }
        require(uri.rawUserInfo == null && uri.fragment == null) { "Use an address without credentials or a fragment." }
        require(uri.port == -1 || uri.port in 1..65535) { "Invalid server port." }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "Use the server address without a page path." }
        require(uri.query == null) { "Use the server address without a query." }
        return uri
    }
    fun sameOrigin(server: URI, value: String): Boolean = try {
        val uri = URI(value)
        uri.rawUserInfo == null && uri.scheme.equals(server.scheme, true) && uri.host.equals(server.host, true) && port(uri) == port(server)
    } catch (_: Exception) { false }
    private fun port(uri: URI) = if (uri.port != -1) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
}
