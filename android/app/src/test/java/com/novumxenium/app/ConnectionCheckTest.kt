package com.novumxenium.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import kotlin.concurrent.thread

class ConnectionCheckTest {
    @Test fun rejectsNonLoopbackAndInvalidPorts() {
        val server = URI("http://example.test")
        val expected = "Private connection is not ready. Retry the connection."
        assertEquals(expected, ConnectionCheck.check(server, "localhost:1234").message)
        assertEquals(expected, ConnectionCheck.check(server, "127.0.0.1:65536").message)
    }

    @Test fun rejectsInvalidServerAddress() {
        val result = ConnectionCheck.check(URI("file:///workspace"), "127.0.0.1:1234")
        assertFalse(result.success)
        assertEquals("Invalid server address.", result.message)
    }

    @Test fun sendsLoginRequestThroughProxyAndReportsRedirect() = checkProxyResponse(
        "HTTP/1.1 302 Found\r\nLocation: /auth\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        true,
        "Server reachable; open the workspace to continue."
    )

    @Test fun reportsForbiddenAsAccessDenied() = checkProxyResponse(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        false,
        "Server denied access (HTTP 403)."
    )

    private fun checkProxyResponse(response: String, success: Boolean, message: String) {
        ServerSocket().use { proxy ->
            proxy.bind(InetSocketAddress("127.0.0.1", 0))
            proxy.soTimeout = 5_000
            val request = arrayOfNulls<String>(1)
            val worker = thread {
                proxy.accept().use { socket ->
                    socket.soTimeout = 5_000
                    request[0] = socket.getInputStream().bufferedReader().readLine()
                    socket.getOutputStream().write(response.toByteArray())
                }
            }
            val result = ConnectionCheck.check(URI("http://example.test:8080"), "127.0.0.1:${proxy.localPort}")
            worker.join(5_000)
            assertEquals(success, result.success)
            assertEquals(message, result.message)
            assertEquals("GET http://example.test:8080/login HTTP/1.1", request[0])
        }
    }
}
