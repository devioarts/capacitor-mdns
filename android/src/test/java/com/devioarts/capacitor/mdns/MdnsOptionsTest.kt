package com.devioarts.capacitor.mdns

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MdnsOptionsTest {
    @Test
    fun portRejectsNonintegerAndNonnumberBridgeValues() {
        for (raw in listOf(null, JSONObject.NULL, true, false, "80", 80.5, 0, 65536, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertTrue("Accepted port $raw", runCatching { MdnsOptions.port(raw) }.isFailure)
        }
        assertEquals(1, MdnsOptions.port(1))
        assertEquals(65535, MdnsOptions.port(65535.0))
    }

    @Test
    fun timeoutRejectsInvalidValuesAndPreservesDefaultsAndClamping() {
        for (raw in listOf(true, "50", Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertTrue("Accepted timeout $raw", runCatching { MdnsOptions.timeout(raw) }.isFailure)
        }
        assertEquals(3000, MdnsOptions.timeout(null))
        assertEquals(3000, MdnsOptions.timeout(JSONObject.NULL))
        assertEquals(0, MdnsOptions.timeout(-1))
        assertEquals(50, MdnsOptions.timeout(50.9))
        assertEquals(Int.MAX_VALUE, MdnsOptions.timeout(Double.MAX_VALUE))
    }

    @Test
    fun stringAndTxtRejectJsonCoercion() {
        assertEquals(null, MdnsOptions.string(JSONObject.NULL, "name"))
        assertEquals("Peer", MdnsOptions.string("Peer", "name"))
        assertTrue(runCatching { MdnsOptions.string(1, "name") }.isFailure)
        for (raw in listOf(JSONArray(), "txt", JSONObject().put("a", 1), JSONObject().put("a", true), JSONObject().put("a", JSONObject.NULL), JSONObject().put("A", "").put("a", ""))) {
            assertTrue("Accepted TXT $raw", runCatching { MdnsOptions.txt(raw) }.isFailure)
        }
        assertEquals(emptyMap<String, String>(), MdnsOptions.txt(JSONObject.NULL))
        assertEquals(mapOf("role" to "tiskárna"), MdnsOptions.txt(JSONObject().put("role", "tiskárna")))
    }
}
