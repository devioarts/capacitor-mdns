package com.devioarts.capacitor.mdns

internal object MdnsValidation {
    fun type(raw: String?): String {
        val type = raw?.trim()?.takeIf { it.isNotEmpty() }?.removeSuffix(".")?.lowercase() ?: "_http._tcp"
        val match = Regex("^_([a-z0-9](?:[a-z0-9-]{0,13}[a-z0-9])?)\\._(tcp|udp)$").matchEntire(type)
        require(match != null && match.groupValues[1].any { it in 'a'..'z' } && !match.groupValues[1].contains("--")) { "Invalid service type: $raw" }
        return "$type."
    }
    fun name(raw: String?): String {
        val name = raw?.trim().orEmpty()
        require(name.toByteArray(Charsets.UTF_8).size <= 63 && raw.orEmpty().none { it < ' ' || it == '\u007f' }) { "Invalid instance name (maximum 63 UTF-8 bytes, no control characters)" }
        return name
    }
    fun txt(txt: Map<String, String>) {
        val keys = mutableSetOf<String>()
        var totalBytes = 0
        txt.forEach { (key, value) ->
            require(key.isNotEmpty() && key.all { it in ' '..'~' && it != '=' } && keys.add(key.lowercase())) { "Invalid or duplicate TXT key" }
            val bytes = "$key=$value".toByteArray(Charsets.UTF_8).size
            totalBytes += bytes + 1
            require(totalBytes <= 1300) { "TXT record must fit in 1300 bytes including length prefixes" }
            require(bytes <= 255) { "TXT entries must be at most 255 UTF-8 bytes including key=" }
        }
    }
}
