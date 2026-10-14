package com.novumxenium.app

import java.net.InetSocketAddress
import java.net.Proxy
import java.net.SocketTimeoutException
import java.net.URI
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

object ConnectionCheck {
    data class Result(val success: Boolean, val message: String)

    fun check(server: URI, proxyAddress: String): Result {
        val validServer = try { ServerAddress.parse(server.toString()) } catch (_: Exception) {
            return Result(false, "Invalid server address.")
        }
        val proxy = parseProxy(proxyAddress)
            ?: return Result(false, "Private connection is not ready. Retry the connection.")
        val target = URL(validServer.resolve("/login").toString())
        var connection: HttpURLConnection? = null
        return try {
            val request = target.openConnection(Proxy(Proxy.Type.HTTP, proxy)) as HttpURLConnection
            connection = request
            request.connectTimeout = 4_000
            request.readTimeout = 4_000
            request.instanceFollowRedirects = false
            request.requestMethod = "GET"
            val status = request.responseCode
            when {
                status in 300..399 -> Result(true, "Server reachable; open the workspace to continue.")
                status == 401 -> Result(true, "Server reachable; sign in to continue.")
                status == 403 -> Result(false, "Server denied access (HTTP 403).")
                status in 200..299 -> Result(true, "Server reachable (HTTP $status).")
                else -> Result(false, "Server returned HTTP $status. Check the server address and subnet route, then retry.")
            }
        } catch (_: SocketTimeoutException) {
            Result(false, "Connection timed out.")
        } catch (_: SSLException) {
            Result(false, "TLS connection failed.")
        } catch (_: Exception) {
            Result(false, "Private connection is not ready. Retry the connection.")
        } finally {
            connection?.disconnect()
        }
    }

    private fun parseProxy(value: String): InetSocketAddress? {
        val match = Regex("^127\\.0\\.0\\.1:([0-9]{1,5})$").matchEntire(value.trim()) ?: return null
        val port = match.groupValues[1].toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
        return InetSocketAddress("127.0.0.1", port)
    }
}
