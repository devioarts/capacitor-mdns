package com.devioarts.capacitor.mdns

import org.json.JSONObject

/** Parses the raw values supplied by the Capacitor JSON bridge. */
internal object MdnsOptions {
    fun string(raw: Any?, key: String): String? {
        require(raw == null || raw === JSONObject.NULL || raw is String) { "Invalid $key" }
        return raw as? String
    }

    fun port(raw: Any?): Int {
        require(raw is Number && raw.toDouble() in 1.0..65535.0 && raw.toDouble() % 1.0 == 0.0) { "Missing/invalid port" }
        return raw.toInt()
    }

    fun txt(raw: Any?): Map<String, String> {
        if (raw == null || raw === JSONObject.NULL) return emptyMap()
        require(raw is JSONObject) { "TXT must be an object of strings" }
        return raw.keys().asSequence().associateWith { key ->
            val value = raw.get(key)
            require(value is String) { "TXT values must be strings" }
            value
        }.also { MdnsValidation.txt(it) }
    }

    fun timeout(raw: Any?): Int {
        if (raw == null || raw === JSONObject.NULL) return 3000
        require(raw is Number && raw.toDouble().isFinite()) { "Invalid timeout" }
        return raw.toDouble().coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
    }
}
