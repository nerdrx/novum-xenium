package com.novumxenium.app

import org.junit.Assert.*
import org.junit.Test

class ServerAddressTest {
    @Test fun acceptsPrivateServerAndExplicitPort() {
        assertEquals("host.tailnet.ts.net", ServerAddress.parse("http://host.tailnet.ts.net:7000/").host)
        assertTrue(ServerAddress.sameOrigin(ServerAddress.parse("http://100.64.1.2:7000"), "http://100.64.1.2:7000/api/download?q=a"))
    }
    @Test fun normalizesDefaultPorts() {
        assertTrue(ServerAddress.sameOrigin(ServerAddress.parse("https://example.com"), "https://EXAMPLE.com:443/a"))
    }
    @Test fun blocksCredentialsAndOtherOrigins() {
        val server = ServerAddress.parse("https://example.com")
        for (address in listOf("http://example.com", "https://evil.example.com", "https://example.com:7000", "https://user@example.com", "javascript:alert(1)", "file:///etc/passwd")) {
            assertFalse(address, ServerAddress.sameOrigin(server, address))
        }
    }
    @Test fun rejectsUnsafeOrIncompleteConfiguration() {
        for (address in listOf("host:7000", "file:///tmp/x", "http://u:p@host", "https://host/chat", "https://host?q=x", "https://host#x", "http://host:0")) {
            assertThrows(address, Exception::class.java) { ServerAddress.parse(address) }
        }
    }
}
