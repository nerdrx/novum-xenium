package com.novumxenium.app

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewProxyRoutingTest {
    @Test
    fun reverseBypassRoutesOnlyConfiguredServerHostThroughProxy() {
        val config = WebViewProxyRouting.build(
            "127.0.0.1:45678", URI("https://novum.example.ts.net"), true,
        )

        assertTrue(config.isReverseBypassEnabled)
        assertEquals(listOf("<-loopback>", "novum.example.ts.net"), config.bypassRules)
        assertEquals("127.0.0.1:45678", config.proxyRules.single().url)
    }

    @Test
    fun unsupportedReverseBypassKeepsExistingPrivateOnlyProxyBehavior() {
        val config = WebViewProxyRouting.build(
            "127.0.0.1:45678", URI("http://192.168.1.20:7000"), false,
        )

        assertFalse(config.isReverseBypassEnabled)
        assertEquals(listOf("<-loopback>"), config.bypassRules)
        assertEquals("127.0.0.1:45678", config.proxyRules.single().url)
    }
}
